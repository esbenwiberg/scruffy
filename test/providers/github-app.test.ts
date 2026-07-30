import { describe, expect, it } from "vitest";
import { GithubAppScmWriter, applyEdits, type GhApi } from "../../src/providers/scm/github-app.js";
import type { CheckRunInput, PullRequestInput } from "../../src/providers/scm/port.js";
import type { SubjectRevision } from "../../src/domain/evidence/types.js";

/**
 * Offline contract test for the GitHub App writer. A stubbed `GhApi` returns
 * recorded GitHub JSON shapes (and throws status-carrying errors like Octokit's
 * RequestError), so the idempotency keys, crash-resume behavior, and error
 * discipline are pinned without any network or real App credentials.
 */

const REPO = "acme/widgets";
const HEAD = "a".repeat(40);
const SUBJECT: SubjectRevision = { repository: REPO, commitSha: HEAD };

type Call = { route: string; params: Record<string, unknown> | undefined };

/** Routes calls by substring match, records every call, throws when unhandled. */
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

/** An Octokit-style error carrying an HTTP status. */
function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const ok = (data: unknown) => ({ status: 200, data });

describe("applyEdits", () => {
  const FILE = ["line 1", "line 2", "line 3", "line 4"].join("\n");
  const edit = (startLine: number, endLine: number, replacement: string) => ({
    path: "src/x.ts",
    startLine,
    endLine,
    replacement,
  });

  it("replaces an inclusive line range", () => {
    expect(applyEdits(FILE, [edit(2, 3, "fixed")])).toBe(["line 1", "fixed", "line 4"].join("\n"));
  });

  it("applies multiple non-overlapping edits correctly regardless of input order", () => {
    const out = applyEdits(FILE, [edit(4, 4, "four"), edit(1, 1, "one")]);
    expect(out).toBe(["one", "line 2", "line 3", "four"].join("\n"));
  });

  it("a multi-line replacement expands the file", () => {
    expect(applyEdits(FILE, [edit(2, 2, "a\nb")])).toBe(["line 1", "a", "b", "line 3", "line 4"].join("\n"));
  });

  it("preserves a trailing newline", () => {
    expect(applyEdits(FILE + "\n", [edit(1, 1, "one")])).toBe(["one", "line 2", "line 3", "line 4", ""].join("\n"));
  });

  it("throws on overlapping edits (ambiguous — must fail loudly, not corrupt)", () => {
    expect(() => applyEdits(FILE, [edit(1, 2, "a"), edit(2, 3, "b")])).toThrow(/overlap/);
  });

  it("throws on an out-of-range edit", () => {
    expect(() => applyEdits(FILE, [edit(4, 5, "a")])).toThrow(/out of range/);
  });

  it("throws on an inverted range", () => {
    expect(() => applyEdits(FILE, [edit(3, 2, "a")])).toThrow(/endLine/);
  });
});

describe("GithubAppScmWriter check runs", () => {
  const input: CheckRunInput = {
    subject: SUBJECT,
    externalId: "run-123",
    name: "scruffy/poison",
    conclusion: "neutral",
    title: "Poison gate: abstained (escalated)",
    summary: "insufficient evidence",
  };

  const isList = (r: string) => r.startsWith("GET") && r.includes("/check-runs");
  const isCreate = (r: string) => r.startsWith("POST") && r.endsWith("/check-runs");
  const isPatch = (r: string) => r.startsWith("PATCH") && r.includes("/check-runs/");

  it("creates a check run when no run matches the externalId, passing neutral through natively", async () => {
    const { api, calls } = stub([
      { match: isList, reply: () => ok({ check_runs: [] }) },
      { match: isCreate, reply: () => ok({ id: 42 }) },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.upsertCheckRun(input);

    expect(result).toEqual({ id: "42", created: true });
    const create = calls.find((c) => isCreate(c.route))!;
    expect(create.params).toMatchObject({
      name: "scruffy/poison",
      head_sha: HEAD,
      external_id: "run-123",
      status: "completed",
      conclusion: "neutral", // check runs have a REAL neutral — no pending fudge
      output: { title: input.title, summary: input.summary },
    });
  });

  it("patches the existing run when externalId matches — created:false, exact (unlike the status adapter)", async () => {
    const { api, calls } = stub([
      { match: isList, reply: () => ok({ check_runs: [{ id: 7, external_id: "run-123" }] }) },
      { match: isPatch, reply: () => ok({ id: 7 }) },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.upsertCheckRun(input);

    expect(result).toEqual({ id: "7", created: false });
    expect(calls.some((c) => isPatch(c.route) && c.route.includes("/check-runs/7"))).toBe(true);
    expect(calls.some((c) => isCreate(c.route))).toBe(false);
  });

  it("a run with a DIFFERENT externalId does not match — a new run is created for the new evaluation", async () => {
    const { api, calls } = stub([
      { match: isList, reply: () => ok({ check_runs: [{ id: 7, external_id: "other-run" }] }) },
      { match: isCreate, reply: () => ok({ id: 43 }) },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.upsertCheckRun(input);

    expect(result).toEqual({ id: "43", created: true });
    expect(calls.some((c) => isPatch(c.route))).toBe(false);
  });

  it("THROWS on an API failure — the dispatcher must retry, never treat it as sent", async () => {
    const api: GhApi = async () => {
      throw httpError(502);
    };
    const scm = new GithubAppScmWriter({ api });
    await expect(scm.upsertCheckRun(input)).rejects.toThrow(/502/);
  });

  it("THROWS on an unexpected response shape (external boundary is schema-parsed)", async () => {
    const { api } = stub([{ match: isList, reply: () => ok({ nope: true }) }]);
    const scm = new GithubAppScmWriter({ api });
    await expect(scm.upsertCheckRun(input)).rejects.toThrow(/unexpected/);
  });
});

describe("GithubAppScmWriter fix pull requests", () => {
  const PROPOSAL = "nfp_1234567890abcdef";
  const BRANCH = `scruffy/fix/disabled-tls-verification/${HEAD.slice(0, 12)}/1234567890abcdef`;
  const FILE = ["import https from 'https';", "const agent = new https.Agent({", "  rejectUnauthorized: false,", "});"].join("\n");
  const PARENT_TREE = "t".repeat(40);

  const input: PullRequestInput = {
    subject: SUBJECT,
    externalId: `nightly-fix-pr:${PROPOSAL}`,
    branch: BRANCH,
    baseBranch: "develop",
    title: "Fix disabled-tls-verification in src/http.ts",
    body: "proposal",
    edits: [{ path: "src/http.ts", startLine: 3, endLine: 3, replacement: "  rejectUnauthorized: true," }],
    draft: false,
    proposalId: PROPOSAL,
  };

  const isPullsList = (r: string) => r.startsWith("GET") && r.endsWith("/pulls");
  const isRefGet = (r: string) => r.startsWith("GET") && r.includes("/git/ref/heads/");
  const isRefCreate = (r: string) => r.startsWith("POST") && r.endsWith("/git/refs");
  const isCommitGet = (r: string) => r.startsWith("GET") && r.includes("/git/commits/");
  const isTreeGet = (r: string) => r.startsWith("GET") && r.includes("/git/trees/");
  const isBlobCreate = (r: string) => r.startsWith("POST") && r.endsWith("/git/blobs");
  const isTreeCreate = (r: string) => r.startsWith("POST") && r.endsWith("/git/trees");
  const isCommitCreate = (r: string) => r.startsWith("POST") && r.endsWith("/git/commits");
  const isContentsGet = (r: string) => r.startsWith("GET") && r.includes("/contents/");
  const isPullCreate = (r: string) => r.startsWith("POST") && r.endsWith("/pulls");
  const isRepoGet = (r: string) => /^GET \/repos\/[^/]+\/[^/]+$/.test(r);

  const contents = (content: string) => ok({ content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64", sha: "filesha" });
  const pull = (number: number, extra: Record<string, unknown> = {}) =>
    ok({ number, html_url: `https://github.test/${REPO}/pull/${number}`, head: { sha: "b".repeat(40) }, ...extra });

  /** The git-data handlers a successful proposal commit needs, in route order. */
  const gitData = () => [
    { match: isCommitGet, reply: () => ok({ sha: HEAD, message: "reviewed head", tree: { sha: PARENT_TREE } }) },
    { match: isContentsGet, reply: () => contents(FILE) },
    {
      match: isTreeGet,
      reply: ({ route }: Call) =>
        route.includes(PARENT_TREE)
          ? ok({ tree: [{ path: "src", mode: "040000", type: "tree", sha: "s".repeat(40) }] })
          : ok({ tree: [{ path: "http.ts", mode: "100755", type: "blob", sha: "f".repeat(40) }] }),
    },
    { match: isBlobCreate, reply: () => ok({ sha: "e".repeat(40) }) },
    { match: isTreeCreate, reply: () => ok({ sha: "d".repeat(40) }) },
    { match: isCommitCreate, reply: () => ok({ sha: "c".repeat(40), message: "committed", tree: { sha: "d".repeat(40) } }) },
  ];

  it("fresh flow: commits the edit onto the reviewed sha, creates the branch at it, opens the PR against baseBranch", async () => {
    const { api, calls } = stub([
      { match: isPullsList, reply: () => ok([]) },
      {
        match: isRefGet,
        reply: () => {
          throw httpError(404);
        },
      },
      ...gitData(),
      { match: isRefCreate, reply: () => ok({ ref: `refs/heads/${BRANCH}` }) },
      { match: isPullCreate, reply: () => pull(55) },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.openPullRequest(input);

    expect(result).toEqual({ number: 55, url: `https://github.test/${REPO}/pull/55`, headSha: "b".repeat(40), draft: false, created: true });

    const blob = calls.find((c) => isBlobCreate(c.route))!;
    const pushed = Buffer.from(blob.params!.content as string, "base64").toString("utf8");
    expect(pushed).toContain("rejectUnauthorized: true,");
    expect(pushed).not.toContain("rejectUnauthorized: false");
    // The file's existing mode is preserved — a fix must not un-executable a script.
    expect(calls.find((c) => isTreeCreate(c.route))!.params).toMatchObject({
      base_tree: PARENT_TREE,
      tree: [{ path: "src/http.ts", mode: "100755", type: "blob", sha: "e".repeat(40) }],
    });
    // Parented on the REVIEWED sha, and carrying the manifest trailer.
    const commit = calls.find((c) => isCommitCreate(c.route))!;
    expect(commit.params).toMatchObject({ parents: [HEAD] });
    expect(commit.params!.message).toContain(`Scruffy-Fix-Proposal: ${PROPOSAL}`);
    // The ref is created only AFTER the whole commit exists.
    expect(calls.find((c) => isRefCreate(c.route))!.params).toMatchObject({ ref: `refs/heads/${BRANCH}`, sha: "c".repeat(40) });
    expect(calls.findIndex((c) => isRefCreate(c.route))).toBeGreaterThan(calls.findIndex((c) => isCommitCreate(c.route)));
    expect(calls.find((c) => isPullCreate(c.route))!.params).toMatchObject({ head: BRANCH, base: "develop", draft: false });
  });

  it("idempotent: an existing PR for the head branch (any state) short-circuits with NO writes", async () => {
    const { api, calls } = stub([{ match: isPullsList, reply: () => ok([pull(31, { draft: true }).data]) }]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.openPullRequest(input);

    expect(result).toEqual({ number: 31, url: `https://github.test/${REPO}/pull/31`, headSha: "b".repeat(40), draft: true, created: false });
    expect(calls).toHaveLength(1); // the list — nothing else
  });

  it("crash-resume: an existing branch whose head DECLARES this proposal is accepted without re-committing", async () => {
    const { api, calls } = stub([
      { match: isPullsList, reply: () => ok([]) },
      { match: isRefGet, reply: () => ok({ object: { sha: "c".repeat(40) } }) },
      {
        match: isCommitGet,
        reply: () => ok({ sha: "c".repeat(40), message: `t\n\nScruffy-Fix-Proposal: ${PROPOSAL}`, tree: { sha: "d".repeat(40) } }),
      },
      { match: isPullCreate, reply: () => pull(56) },
    ]);
    const scm = new GithubAppScmWriter({ api });

    expect((await scm.openPullRequest(input)).number).toBe(56);
    // No blob/tree/commit writes: the manifest already proves the patch is there.
    expect(calls.some((c) => c.route.startsWith("POST") && c.route.includes("/git/"))).toBe(false);
  });

  it("REFUSES an existing branch that merely advanced — 'advanced' is not proof our patch landed", async () => {
    const { api, calls } = stub([
      { match: isPullsList, reply: () => ok([]) },
      { match: isRefGet, reply: () => ok({ object: { sha: "9".repeat(40) } }) },
      { match: isCommitGet, reply: () => ok({ sha: "9".repeat(40), message: "someone else's commit", tree: { sha: "d".repeat(40) } }) },
    ]);
    const scm = new GithubAppScmWriter({ api });

    await expect(scm.openPullRequest(input)).rejects.toThrow(/does not declare fix proposal/);
    expect(calls.some((c) => isPullCreate(c.route))).toBe(false);
  });

  it("resolves the repository default branch when baseBranch is absent (older persisted effects)", async () => {
    const { api, calls } = stub([
      { match: isPullsList, reply: () => ok([]) },
      { match: isRefGet, reply: () => ok({ object: { sha: "c".repeat(40) } }) },
      {
        match: isCommitGet,
        reply: () => ok({ sha: "c".repeat(40), message: `t\n\nScruffy-Fix-Proposal: ${PROPOSAL}`, tree: { sha: "d".repeat(40) } }),
      },
      { match: isRepoGet, reply: () => ok({ default_branch: "main" }) },
      { match: isPullCreate, reply: () => pull(58) },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const legacy: PullRequestInput = { ...input };
    delete legacy.baseBranch;
    await scm.openPullRequest(legacy);

    expect(calls.find((c) => isPullCreate(c.route))!.params).toMatchObject({ base: "main" });
  });

  it("resolves a 422 duplicate-PR race by re-listing and returning the winner", async () => {
    let listCalls = 0;
    const { api } = stub([
      {
        match: isPullsList,
        reply: () => {
          listCalls += 1;
          return listCalls === 1 ? ok([]) : ok([pull(59).data]);
        },
      },
      { match: isRefGet, reply: () => ok({ object: { sha: "c".repeat(40) } }) },
      {
        match: isCommitGet,
        reply: () => ok({ sha: "c".repeat(40), message: `t\n\nScruffy-Fix-Proposal: ${PROPOSAL}`, tree: { sha: "d".repeat(40) } }),
      },
      {
        match: isPullCreate,
        reply: () => {
          throw httpError(422, "A pull request already exists");
        },
      },
    ]);
    const scm = new GithubAppScmWriter({ api });

    expect(await scm.openPullRequest(input)).toMatchObject({ number: 59, created: false });
  });

  it("refuses to edit a file the contents API cannot return (encoding 'none' — too large)", async () => {
    const { api } = stub([
      { match: isPullsList, reply: () => ok([]) },
      {
        match: isRefGet,
        reply: () => {
          throw httpError(404);
        },
      },
      { match: isCommitGet, reply: () => ok({ sha: HEAD, message: "reviewed head", tree: { sha: PARENT_TREE } }) },
      { match: isContentsGet, reply: () => ok({ content: "", encoding: "none", sha: "filesha" }) },
    ]);
    const scm = new GithubAppScmWriter({ api });
    await expect(scm.openPullRequest(input)).rejects.toThrow(/cannot apply edits safely/);
  });

  it("THROWS on a non-404 ref lookup failure — an auth/network fault must not read as 'branch missing'", async () => {
    const { api } = stub([
      { match: isPullsList, reply: () => ok([]) },
      {
        match: isRefGet,
        reply: () => {
          throw httpError(500);
        },
      },
    ]);
    const scm = new GithubAppScmWriter({ api });
    await expect(scm.openPullRequest(input)).rejects.toThrow(/500/);
  });

  it("THROWS on an unexpected pull-request response shape (external boundary is schema-parsed)", async () => {
    const { api } = stub([
      { match: isPullsList, reply: () => ok([]) },
      { match: isRefGet, reply: () => ok({ object: { sha: "c".repeat(40) } }) },
      {
        match: isCommitGet,
        reply: () => ok({ sha: "c".repeat(40), message: `t\n\nScruffy-Fix-Proposal: ${PROPOSAL}`, tree: { sha: "d".repeat(40) } }),
      },
      { match: isPullCreate, reply: () => ok({ number: 60 }) }, // no html_url, no head
    ]);
    const scm = new GithubAppScmWriter({ api });
    await expect(scm.openPullRequest(input)).rejects.toThrow(/unexpected created pull response shape/);
  });
});
