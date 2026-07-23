import { describe, expect, it } from "vitest";
import { GhCliScm, conclusionToState, type RunGh } from "../../src/providers/scm/gh-cli.js";
import type { CheckRunInput } from "../../src/providers/scm/port.js";
import type { SubjectRevision } from "../../src/domain/evidence/types.js";

/**
 * Offline contract test for the gh-backed adapter. A stubbed `runGh` returns
 * recorded GitHub JSON shapes, so the mapping and error discipline are pinned
 * without any network or real `gh`. This is the "contract test that keeps the
 * fake honest" the port doc calls for.
 */

const REPO = "acme/widgets";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SUBJECT: SubjectRevision = { repository: REPO, commitSha: HEAD };

/** A gh stub that dispatches canned responses by matching the endpoint in args, and records calls. */
function stub(handlers: { match: (args: string[]) => boolean; reply: string }[]): { runGh: RunGh; calls: string[][] } {
  const calls: string[][] = [];
  const runGh: RunGh = async (args) => {
    calls.push(args);
    const h = handlers.find((x) => x.match(args));
    if (!h) throw new Error(`gh stub: no handler for ${args.join(" ")}`);
    return h.reply;
  };
  return { runGh, calls };
}

const isCompare = (a: string[]) => a.some((s) => s.includes("/compare/"));
const isPulls = (a: string[]) => a.some((s) => s.endsWith("/pulls"));
const isStatus = (a: string[]) => a.some((s) => s.includes("/statuses/"));

// A slurped compare page: one real diff, one binary/rename file with NO patch.
const comparePage = JSON.stringify([
  {
    files: [
      { filename: "src/config.ts", patch: "@@ -0,0 +1,1 @@\n+export const KEY = 'x';" },
      { filename: "assets/logo.png" }, // binary: no `patch`
      { filename: "src/new-name.ts", previous_filename: "src/old-name.ts" }, // rename: no `patch`
    ],
  },
]);

describe("GhCliScm reader", () => {
  it("maps compare files to ChangedFile, defaulting a missing patch to empty string", async () => {
    const { runGh } = stub([{ match: isCompare, reply: comparePage }]);
    const scm = new GhCliScm({ runGh });

    const files = await scm.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD });

    expect(files).toEqual([
      { path: "src/config.ts", patch: "@@ -0,0 +1,1 @@\n+export const KEY = 'x';" },
      { path: "assets/logo.png", patch: "" },
      { path: "src/new-name.ts", patch: "" },
    ]);
  });

  it("getChangedFiles resolves the associated PR base, then compares base...head", async () => {
    const { runGh, calls } = stub([
      { match: isPulls, reply: JSON.stringify([{ state: "open", base: { sha: BASE } }]) },
      { match: isCompare, reply: comparePage },
    ]);
    const scm = new GhCliScm({ runGh });

    const files = await scm.getChangedFiles(SUBJECT);

    expect(files.map((f) => f.path)).toContain("src/config.ts");
    // It looked up the PR, then compared against the resolved base.
    expect(calls.some(isPulls)).toBe(true);
    expect(calls.some((a) => a.some((s) => s.includes(`/compare/${BASE}...${HEAD}`)))).toBe(true);
  });

  it("falls back to the commit's own files when no PR is associated", async () => {
    const { runGh, calls } = stub([
      { match: isPulls, reply: "[]" }, // no associated PR
      { match: (a) => a.some((s) => s.endsWith(`/commits/${HEAD}`)), reply: JSON.stringify({ files: [{ filename: "a.ts", patch: "@@ -0,0 +1,1 @@\n+1" }] }) },
    ]);
    const scm = new GhCliScm({ runGh });

    const files = await scm.getChangedFiles(SUBJECT);
    expect(files).toEqual([{ path: "a.ts", patch: "@@ -0,0 +1,1 @@\n+1" }]);
    expect(calls.some(isCompare)).toBe(false); // no base -> no compare
  });

  it("THROWS (never returns []) when gh fails — an empty diff on a fault would false-green a blocking gate", async () => {
    const runGh: RunGh = async () => {
      throw new Error("gh api exited 1: HTTP 404");
    };
    const scm = new GhCliScm({ runGh });
    await expect(scm.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD })).rejects.toThrow(/404/);
  });

  it("THROWS when the compare hits GitHub's 300-file cap (partial diff must not scan as clean)", async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, patch: "@@ -0,0 +1,1 @@\n+1" }));
    const { runGh } = stub([{ match: isCompare, reply: JSON.stringify([{ files }]) }]);
    const scm = new GhCliScm({ runGh });
    await expect(scm.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD })).rejects.toThrow(/cap|too large/i);
  });
});

describe("GhCliScm writer (check-run effect -> commit status)", () => {
  const input: CheckRunInput = {
    subject: SUBJECT,
    externalId: `poison:${REPO}:${HEAD}`,
    name: "scruffy/poison",
    conclusion: "failure",
    title: "Poison gate: blocked",
    summary: "leaked-credential found",
  };

  it("posts a commit status with the mapped state, context, and description", async () => {
    const { runGh, calls } = stub([{ match: isStatus, reply: JSON.stringify({ id: 999 }) }]);
    const scm = new GhCliScm({ runGh });

    const result = await scm.upsertCheckRun(input);

    expect(result.id).toBe("999");
    const call = calls.find(isStatus)!;
    expect(call).toContain("POST");
    expect(call.some((s) => s === `repos/${REPO}/statuses/${HEAD}`)).toBe(true);
    expect(call).toContain("state=failure"); // failure -> failure
    expect(call).toContain("context=scruffy/poison");
    expect(call.some((s) => s.startsWith("description=Poison gate: blocked"))).toBe(true);
  });

  it("maps conclusions to status states (neutral -> pending, statuses have no neutral)", () => {
    expect(conclusionToState("success")).toBe("success");
    expect(conclusionToState("failure")).toBe("failure");
    expect(conclusionToState("neutral")).toBe("pending");
  });

  it("hard-throws on openPullRequest — a stray PR effect must fail loudly, not silently no-op", async () => {
    const scm = new GhCliScm({ runGh: async () => "{}" });
    await expect(
      scm.openPullRequest({ subject: SUBJECT, externalId: "x", branch: "b", title: "t", body: "b", edits: [] }),
    ).rejects.toThrow(/not enabled/);
  });
});
