import { describe, expect, it } from "vitest";
import { GithubAppScmReader } from "../../src/providers/scm/github-app-reader.js";
import type { GhApi } from "../../src/providers/scm/github-app.js";
import type { SubjectRevision } from "../../src/domain/evidence/types.js";

/**
 * Offline contract test for the GitHub App reader. A stubbed `GhApi` returns
 * recorded compare/commit/pulls shapes so the associated-PR resolution, the
 * null-base fallback, pagination, the 300-file cap, and the throw-not-[] error
 * discipline are pinned without any network or real App credentials.
 */

const REPO = "acme/widgets";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SUBJECT: SubjectRevision = { repository: REPO, commitSha: HEAD };

type Call = { route: string; params: Record<string, unknown> | undefined };

function stub(handlers: { match: (route: string) => boolean; reply: (call: Call) => { status: number; data: unknown } }[]): {
  api: GhApi;
  calls: Call[];
} {
  const calls: Call[] = [];
  const api: GhApi = async (route, params) => {
    const call = { route, params };
    calls.push(call);
    const handler = handlers.find((h) => h.match(route));
    if (!handler) throw new Error(`GhApi stub: no handler for ${route}`);
    return handler.reply(call);
  };
  return { api, calls };
}

function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const ok = (data: unknown) => ({ status: 200, data });
const file = (name: string, patch = `@@ -0,0 +1 @@\n+${name}`) => ({ filename: name, patch, additions: 1 });

const isPulls = (r: string) => r.includes("/commits/") && r.endsWith("/pulls");
const isCommit = (r: string) => r.includes("/commits/") && !r.endsWith("/pulls");
const isCompare = (r: string) => r.includes("/compare/");

describe("GithubAppScmReader getChangedFiles", () => {
  it("resolves an associated OPEN PR's base and returns the base...head diff", async () => {
    const { api, calls } = stub([
      { match: isPulls, reply: () => ok([{ state: "open", base: { sha: BASE } }]) },
      { match: isCompare, reply: () => ok({ files: [file("src/a.ts"), file("src/b.ts")] }) },
    ]);
    const reader = new GithubAppScmReader({ api });

    const files = await reader.getChangedFiles(SUBJECT);

    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(calls.some((c) => isCompare(c.route) && c.route.includes(`${BASE}...${HEAD}`))).toBe(true);
  });

  it("falls back to the commit's own files when there is no open PR", async () => {
    const { api, calls } = stub([
      { match: isPulls, reply: () => ok([]) },
      { match: isCommit, reply: () => ok({ files: [file("src/only.ts")] }) },
    ]);
    const reader = new GithubAppScmReader({ api });

    const files = await reader.getChangedFiles(SUBJECT);

    expect(files.map((f) => f.path)).toEqual(["src/only.ts"]);
    expect(calls.some((c) => isCompare(c.route))).toBe(false);
  });

  it("ignores a CLOSED associated PR (stale range) and reads the commit itself", async () => {
    const { api, calls } = stub([
      { match: isPulls, reply: () => ok([{ state: "closed", base: { sha: BASE } }]) },
      { match: isCommit, reply: () => ok({ files: [file("src/x.ts")] }) },
    ]);
    const reader = new GithubAppScmReader({ api });

    await reader.getChangedFiles(SUBJECT);

    expect(calls.some((c) => isCompare(c.route))).toBe(false);
    expect(calls.some((c) => isCommit(c.route))).toBe(true);
  });
});

describe("GithubAppScmReader getChangedFilesInRange", () => {
  it("a null base reads the head commit's own change set (never widened by an open PR)", async () => {
    const { api, calls } = stub([{ match: isCommit, reply: () => ok({ files: [file("src/first.ts")] }) }]);
    const reader = new GithubAppScmReader({ api });

    const files = await reader.getChangedFilesInRange({ repository: REPO, baseSha: null, headSha: HEAD });

    expect(files.map((f) => f.path)).toEqual(["src/first.ts"]);
    expect(calls.some((c) => isPulls(c.route) || isCompare(c.route))).toBe(false);
  });

  it("paginates the compare files across pages and accumulates them all", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => file(`p1/${i}.ts`));
    const page2 = [file("p2/last.ts")];
    const { api, calls } = stub([
      {
        match: isCompare,
        reply: (call) => ok({ files: (call.params?.page as number) === 1 ? page1 : page2 }),
      },
    ]);
    const reader = new GithubAppScmReader({ api });

    const files = await reader.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD });

    expect(files).toHaveLength(101);
    expect(calls.filter((c) => isCompare(c.route))).toHaveLength(2); // stopped on the short page
  });

  it("stops instead of looping when the endpoint returns the SAME full page repeatedly", async () => {
    const sameFullPage = Array.from({ length: 100 }, (_, i) => file(`dup/${i}.ts`));
    const { api, calls } = stub([{ match: isCompare, reply: () => ok({ files: sameFullPage }) }]);
    const reader = new GithubAppScmReader({ api });

    const files = await reader.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD });

    expect(files).toHaveLength(100);
    expect(calls.filter((c) => isCompare(c.route))).toHaveLength(2); // page 2 added nothing new -> stop
  });

  it("THROWS at the 300-file cap rather than scan a partial diff as clean", async () => {
    const { api } = stub([
      {
        match: isCompare,
        reply: (call) => {
          const p = call.params?.page as number;
          return ok({ files: Array.from({ length: 100 }, (_, i) => file(`page${p}/${i}.ts`)) });
        },
      },
    ]);
    const reader = new GithubAppScmReader({ api });

    await expect(reader.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD })).rejects.toThrow(/cap/);
  });

  it("THROWS on a file with added lines but no patch (too large to diff — must not read as clean)", async () => {
    const { api } = stub([{ match: isCompare, reply: () => ok({ files: [{ filename: "big.bin", additions: 42 }] }) }]);
    const reader = new GithubAppScmReader({ api });

    await expect(reader.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD })).rejects.toThrow(
      /too large to diff/,
    );
  });
});

describe("GithubAppScmReader candidate CI", () => {
  const isCheckRuns = (r: string) => r.endsWith("/check-runs");
  const isCiStatuses = (r: string) => r.endsWith("/statuses");

  const checkRuns = {
    check_runs: [
      { name: "ci/build", status: "completed", conclusion: "success", head_sha: HEAD, completed_at: "2026-07-20T10:00:00Z" },
      { name: "ci/lint", status: "queued", conclusion: null, head_sha: HEAD },
      { name: "ci/e2e", status: "completed", conclusion: "timed_out", head_sha: HEAD, completed_at: "2026-07-20T10:09:00Z" },
    ],
  };
  const statuses = [
    { context: "ci/test", state: "success", updated_at: "2026-07-20T11:00:00Z" },
    { context: "legacy/deploy", state: "error", updated_at: "2026-07-20T11:02:00Z" },
  ];

  it("normalizes candidate CI for an exact SHA", async () => {
    const { api } = stub([
      { match: isCheckRuns, reply: () => ok(checkRuns) },
      { match: isCiStatuses, reply: () => ok(statuses) },
    ]);
    const reader = new GithubAppScmReader({ api });

    const evidence = await reader.getCandidateCi(SUBJECT);

    expect(evidence.sha).toBe(HEAD);
    expect(evidence.records).toEqual(
      expect.arrayContaining([
        { context: "ci/build", state: "success", sha: HEAD, source: "check-run", updatedAt: "2026-07-20T10:00:00Z" },
        { context: "ci/lint", state: "pending", sha: HEAD, source: "check-run" }, // not completed -> pending
        { context: "ci/e2e", state: "timed-out", sha: HEAD, source: "check-run", updatedAt: "2026-07-20T10:09:00Z" },
        { context: "ci/test", state: "success", sha: HEAD, source: "commit-status", updatedAt: "2026-07-20T11:00:00Z" },
        { context: "legacy/deploy", state: "error", sha: HEAD, source: "commit-status", updatedAt: "2026-07-20T11:02:00Z" },
      ]),
    );
    expect(evidence.records.every((r) => r.sha === HEAD)).toBe(true);
  });

  it("does not treat failed CI reads as empty success", async () => {
    // An API failure on the check-runs read must REJECT — never resolve to an empty
    // (falsely clean) set. The whole point of the lane is that missing != clean.
    const { api: failing } = stub([
      {
        match: isCheckRuns,
        reply: () => {
          throw httpError(500);
        },
      },
      { match: isCiStatuses, reply: () => ok([]) },
    ]);
    await expect(new GithubAppScmReader({ api: failing }).getCandidateCi(SUBJECT)).rejects.toThrow(/500/);

    // A malformed check-runs shape is schema-parsed and throws, never []-as-success.
    const { api: malformed } = stub([
      { match: isCheckRuns, reply: () => ok({ check_runs: [{ status: "completed" }] }) }, // missing `name`
      { match: isCiStatuses, reply: () => ok([]) },
    ]);
    await expect(new GithubAppScmReader({ api: malformed }).getCandidateCi(SUBJECT)).rejects.toThrow(/unexpected/);
  });
});

describe("GithubAppScmReader error discipline", () => {
  it("propagates an API failure (NEVER returns [] — an empty diff on a fault would false-green the gate)", async () => {
    const { api } = stub([
      {
        match: isCompare,
        reply: () => {
          throw httpError(500);
        },
      },
    ]);
    const reader = new GithubAppScmReader({ api });

    await expect(reader.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD })).rejects.toThrow(/500/);
  });

  it("THROWS on an unexpected response shape (external boundary is schema-parsed)", async () => {
    const { api } = stub([{ match: isCompare, reply: () => ok({ files: "not-an-array" }) }]);
    const reader = new GithubAppScmReader({ api });

    await expect(reader.getChangedFilesInRange({ repository: REPO, baseSha: BASE, headSha: HEAD })).rejects.toThrow(/unexpected/);
  });
});
