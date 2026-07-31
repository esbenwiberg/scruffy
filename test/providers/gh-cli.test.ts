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
function stub(handlers: { match: (args: string[]) => boolean; reply: string }[]): {
  runGh: RunGh;
  calls: string[][];
} {
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
const isCheckRuns = (a: string[]) => a.some((s) => s.includes("/check-runs"));
const isCiStatuses = (a: string[]) => a.some((s) => s.includes("/statuses?"));
const isOpenIssues = (a: string[]) => a.some((s) => s.includes("/issues?state=open&labels=bug"));
const isOpenPulls = (a: string[]) => a.some((s) => s.includes("/pulls?state=open"));

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

    const files = await scm.getChangedFilesInRange({
      repository: REPO,
      baseSha: BASE,
      headSha: HEAD,
    });

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
      {
        match: (a) => a.some((s) => s.endsWith(`/commits/${HEAD}`)),
        reply: JSON.stringify({ files: [{ filename: "a.ts", patch: "@@ -0,0 +1,1 @@\n+1" }] }),
      },
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
    await expect(
      scm.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD }),
    ).rejects.toThrow(/404/);
  });

  it("THROWS when the compare hits GitHub's 300-file cap (partial diff must not scan as clean)", async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${i}.ts`,
      patch: "@@ -0,0 +1,1 @@\n+1",
    }));
    const { runGh } = stub([{ match: isCompare, reply: JSON.stringify([{ files }]) }]);
    const scm = new GhCliScm({ runGh });
    await expect(
      scm.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD }),
    ).rejects.toThrow(/cap|too large/i);
  });

  it("THROWS when a text file has added lines but no patch (too large to diff — must abstain, not scan clean)", async () => {
    const page = JSON.stringify([{ files: [{ filename: "huge.sql", additions: 5000 }] }]); // no patch
    const { runGh } = stub([{ match: isCompare, reply: page }]);
    const scm = new GhCliScm({ runGh });
    await expect(
      scm.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD }),
    ).rejects.toThrow(/no patch|too large/i);
  });

  it("does NOT throw for binary/rename files (no added lines, no patch)", async () => {
    const page = JSON.stringify([
      { files: [{ filename: "logo.png", additions: 0 }, { filename: "moved.ts" }] },
    ]);
    const { runGh } = stub([{ match: isCompare, reply: page }]);
    const scm = new GhCliScm({ runGh });
    const files = await scm.getChangedFilesInRange({
      repository: REPO,
      baseSha: BASE,
      headSha: HEAD,
    });
    expect(files).toEqual([
      { path: "logo.png", patch: "" },
      { path: "moved.ts", patch: "" },
    ]);
  });

  it("null-base range returns the commit's own files and never resolves an associated PR (contract: head's own change set)", async () => {
    // An OPEN PR points at the head commit. The buggy path delegated to
    // getChangedFiles, which would resolve this PR's base and compare base...head —
    // silently widening the null-base scan. The fix bypasses PR resolution.
    const { runGh, calls } = stub([
      { match: isPulls, reply: JSON.stringify([{ state: "open", base: { sha: BASE } }]) },
      {
        match: (a) => a.some((s) => s.endsWith(`/commits/${HEAD}`)),
        reply: JSON.stringify({ files: [{ filename: "a.ts", patch: "@@ -0,0 +1,1 @@\n+1" }] }),
      },
    ]);
    const scm = new GhCliScm({ runGh });

    const files = await scm.getChangedFilesInRange({
      repository: REPO,
      baseSha: null,
      headSha: HEAD,
    });

    expect(files).toEqual([{ path: "a.ts", patch: "@@ -0,0 +1,1 @@\n+1" }]);
    expect(calls.some(isPulls)).toBe(false); // PR resolution bypassed entirely
    expect(calls.some(isCompare)).toBe(false); // never widened to a base...head compare
  });

  it("ignores a closed-only PR and scans the commit itself (stale base would be wrong)", async () => {
    const { runGh, calls } = stub([
      { match: isPulls, reply: JSON.stringify([{ state: "closed", base: { sha: BASE } }]) },
      {
        match: (a) => a.some((s) => s.endsWith(`/commits/${HEAD}`)),
        reply: JSON.stringify({ files: [{ filename: "a.ts", patch: "@@ -0,0 +1,1 @@\n+1" }] }),
      },
    ]);
    const scm = new GhCliScm({ runGh });
    const files = await scm.getChangedFiles(SUBJECT);
    expect(files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(calls.some(isCompare)).toBe(false); // never compared against the closed PR's base
  });
});

describe("GhCliScm candidate CI", () => {
  const checkRuns = JSON.stringify({
    check_runs: [
      {
        name: "ci/build",
        status: "completed",
        conclusion: "success",
        head_sha: HEAD,
        completed_at: "2026-07-20T10:00:00Z",
      },
      { name: "ci/lint", status: "in_progress", conclusion: null, head_sha: HEAD },
      {
        name: "ci/flaky",
        status: "completed",
        conclusion: "cancelled",
        head_sha: HEAD,
        completed_at: "2026-07-20T10:05:00Z",
      },
    ],
  });
  const statuses = JSON.stringify([
    { context: "ci/test", state: "success", updated_at: "2026-07-20T11:00:00Z" },
    { context: "legacy/deploy", state: "failure", updated_at: "2026-07-20T11:01:00Z" },
  ]);

  it("normalizes candidate CI for an exact SHA", async () => {
    const { runGh } = stub([
      { match: isCheckRuns, reply: checkRuns },
      { match: isCiStatuses, reply: statuses },
    ]);
    const scm = new GhCliScm({ runGh });

    const evidence = await scm.getCandidateCi(SUBJECT);

    expect(evidence.sha).toBe(HEAD);
    // Check-run conclusions and commit-status states both normalize, each carrying
    // its context, source, and the EXACT candidate SHA it was gathered for.
    expect(evidence.records).toEqual(
      expect.arrayContaining([
        {
          context: "ci/build",
          state: "success",
          sha: HEAD,
          source: "check-run",
          updatedAt: "2026-07-20T10:00:00Z",
        },
        { context: "ci/lint", state: "pending", sha: HEAD, source: "check-run" }, // not completed -> pending
        {
          context: "ci/flaky",
          state: "cancelled",
          sha: HEAD,
          source: "check-run",
          updatedAt: "2026-07-20T10:05:00Z",
        },
        {
          context: "ci/test",
          state: "success",
          sha: HEAD,
          source: "commit-status",
          updatedAt: "2026-07-20T11:00:00Z",
        },
        {
          context: "legacy/deploy",
          state: "failure",
          sha: HEAD,
          source: "commit-status",
          updatedAt: "2026-07-20T11:01:00Z",
        },
      ]),
    );
    expect(evidence.records.every((r) => r.sha === HEAD)).toBe(true);
  });

  it("does not treat failed CI reads as empty success", async () => {
    // A gh/API failure on either read must REJECT — never resolve to an empty
    // (falsely clean) record set that would let a missing required check pass.
    const failing: RunGh = async () => {
      throw new Error("gh api exited 1: HTTP 500");
    };
    const scm = new GhCliScm({ runGh: failing });
    await expect(scm.getCandidateCi(SUBJECT)).rejects.toThrow(/500/);

    // A malformed check-runs shape (not an array) also throws, never []-as-success.
    const { runGh } = stub([
      { match: isCheckRuns, reply: JSON.stringify({ check_runs: "not-an-array" }) },
      { match: isCiStatuses, reply: "[]" },
    ]);
    await expect(new GhCliScm({ runGh }).getCandidateCi(SUBJECT)).rejects.toThrow(/check_runs/);
  });
});

describe("GhCliScm release context", () => {
  it("reads exact-label bug issues and every open PR as provider-neutral metadata", async () => {
    const { runGh } = stub([
      {
        match: isOpenIssues,
        reply: JSON.stringify([
          {
            number: 7,
            html_url: "https://github.com/acme/widgets/issues/7",
            title: "Widget corrupts cache",
            labels: [{ name: "bug" }],
            updated_at: "2026-07-31T10:00:00Z",
          },
          {
            number: 8,
            html_url: "https://github.com/acme/widgets/pull/8",
            title: "A PR returned by issues",
            labels: [{ name: "bug" }],
            pull_request: {},
          },
        ]),
      },
      {
        match: isOpenPulls,
        reply: JSON.stringify([
          {
            number: 8,
            html_url: "https://github.com/acme/widgets/pull/8",
            title: "Fix cache corruption",
            draft: false,
            head: { sha: HEAD, ref: "fix/cache" },
            base: { ref: "main" },
            user: { login: "alice" },
            updated_at: "2026-07-31T11:00:00Z",
          },
        ]),
      },
    ]);

    const work = await new GhCliScm({ runGh }).getOpenReleaseWork(REPO);

    expect(work.complete).toBe(true);
    expect(work.bugIssues).toEqual([
      {
        number: 7,
        url: "https://github.com/acme/widgets/issues/7",
        title: "Widget corrupts cache",
        labels: ["bug"],
        updatedAt: "2026-07-31T10:00:00Z",
      },
    ]);
    expect(work.openPullRequests[0]).toMatchObject({
      number: 8,
      headSha: HEAD,
      headBranch: "fix/cache",
      baseBranch: "main",
      author: "alice",
    });
  });

  it("throws on malformed context instead of recording an empty backlog", async () => {
    const { runGh } = stub([
      { match: isOpenIssues, reply: JSON.stringify([{ number: 7 }]) },
      { match: isOpenPulls, reply: "[]" },
    ]);
    await expect(new GhCliScm({ runGh }).getOpenReleaseWork(REPO)).rejects.toThrow(
      /unexpected shape/,
    );
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

  it("re-posting the same input supersedes idempotently but reports created:true both times (advisory — effects must not gate on it)", async () => {
    // A commit status has no create-vs-supersede signal, so the gh adapter reports
    // created:true on every post (documented on ScmWriter/CheckRunResult). This pins
    // that intentional divergence from FakeScm: the safety invariant is "no duplicate
    // effect" (both posts hit the same /statuses/{sha} context, latest wins), NOT that
    // created detects a redelivery. Any created-gated side effect would misfire here.
    const { runGh, calls } = stub([{ match: isStatus, reply: JSON.stringify({ id: 999 }) }]);
    const scm = new GhCliScm({ runGh });

    const first = await scm.upsertCheckRun(input);
    const second = await scm.upsertCheckRun(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(true); // NOT false — the real risk the port docstring warns about
    const statusPosts = calls.filter(isStatus);
    expect(statusPosts).toHaveLength(2);
    expect(statusPosts.every((c) => c.some((s) => s === "context=scruffy/poison"))).toBe(true); // same context -> supersede, no duplicate
  });

  it("maps conclusions to status states (neutral -> pending, statuses have no neutral)", () => {
    expect(conclusionToState("success")).toBe("success");
    expect(conclusionToState("failure")).toBe("failure");
    expect(conclusionToState("neutral")).toBe("pending");
  });

  it("hard-throws on openPullRequest — a stray PR effect must fail loudly, not silently no-op", async () => {
    const scm = new GhCliScm({ runGh: async () => "{}" });
    await expect(
      scm.openPullRequest({
        subject: SUBJECT,
        externalId: "x",
        branch: "b",
        title: "t",
        body: "b",
        edits: [],
        draft: false,
        proposalId: "nfp_x",
      }),
    ).rejects.toThrow(/not enabled/);
  });
});
