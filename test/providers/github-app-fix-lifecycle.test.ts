import { describe, expect, it } from "vitest";
import { GithubAppScmWriter, type GhApi } from "../../src/providers/scm/github-app.js";
import type { PullRequestInput } from "../../src/providers/scm/port.js";
import {
  fixProposalBranch,
  fixProposalExternalId,
  renderFixPullRequestBody,
  type PreconditionedEdit,
} from "../../src/domain/fixes/delivery.js";
import {
  deterministicFixerProvenance,
  findingOccurrenceId,
  fixProposalId,
  modelFixerProvenance,
  nightlyReportId,
  NIGHTLY_REPORT_SCHEMA_VERSION,
  type FindingOccurrenceIdentity,
  type NightlyReportIdentity,
} from "../../src/domain/findings/work-identity.js";

/**
 * Delivery contract for the GitHub App writer: candidate-bound branches, ready vs
 * draft PRs, and an atomic preconditioned commit.
 *
 * Driven by an in-memory GitHub simulator rather than a per-route stub, because
 * the properties under test are about ORDER and ATOMICITY ("no ref until the whole
 * commit exists", "no PR when a preimage is stale") and about identity across two
 * different candidates. A simulator that actually holds refs, commits and pulls
 * can answer those; a table of canned replies cannot.
 *
 * No network and no App credentials: every route is served from local state.
 */

const REPO = "acme/widgets";
const BASE_SHA = "0".repeat(40);
const CANDIDATE_1 = "a".repeat(40);
const CANDIDATE_2 = "f".repeat(40);

const TLS_FILE = [
  "import https from 'https';",
  "",
  "const agent = new https.Agent({",
  "  rejectUnauthorized: false,",
  "});",
  "",
  "export default agent;",
].join("\n");

const CONFIG_FILE = ["export const config = {", "  verifySsl: false,", "};", ""].join("\n");

type Call = { route: string; params: Record<string, unknown> | undefined };

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
}

interface SimPull {
  number: number;
  branch: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  title: string;
  body: string;
}

/** An Octokit-style error carrying an HTTP status. */
function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const ok = (data: unknown) => ({ status: 200, data });

/**
 * A minimal but stateful GitHub simulator: immutable content snapshots per commit
 * sha, mutable refs/pulls, and write routes that behave like the real ones
 * (duplicate ref -> 422, duplicate PR head -> 422).
 */
function githubRepo(snapshots: Record<string, Record<string, string>>) {
  const calls: Call[] = [];
  const refs = new Map<string, string>();
  const commits = new Map<string, { message: string; tree: string; parents: string[] }>();
  const trees = new Map<string, TreeEntry[]>();
  const blobs = new Map<string, string>();
  const contentBySha = new Map<string, Record<string, string>>();
  const pulls: SimPull[] = [];
  let counter = 0;

  for (const [sha, files] of Object.entries(snapshots)) {
    contentBySha.set(sha, files);
    const rootTree = `t:${sha}`;
    commits.set(sha, { message: `candidate ${sha.slice(0, 7)}`, tree: rootTree, parents: [] });
    // Materialize one tree object per directory level so `#blobMode`'s
    // segment-by-segment walk (never `?recursive=1`) resolves.
    const dirs = new Map<string, TreeEntry[]>([["", []]]);
    for (const path of Object.keys(files)) {
      const segments = path.split("/");
      let prefix = "";
      for (const [index, segment] of segments.entries()) {
        const parent = dirs.get(prefix)!;
        const child = prefix === "" ? segment : `${prefix}/${segment}`;
        if (index === segments.length - 1) {
          parent.push({ path: segment, mode: "100644", type: "blob", sha: `b:${sha}:${child}` });
        } else if (!parent.some((entry) => entry.path === segment)) {
          parent.push({ path: segment, mode: "040000", type: "tree", sha: `t:${sha}:${child}` });
          dirs.set(child, []);
        }
        prefix = child;
      }
    }
    for (const [dir, entries] of dirs) trees.set(dir === "" ? rootTree : `t:${sha}:${dir}`, entries);
  }

  const toPullJson = (pull: SimPull) => ({
    number: pull.number,
    html_url: `https://github.test/${REPO}/pull/${pull.number}`,
    head: { sha: pull.headSha },
    draft: pull.draft,
    state: pull.state,
    merged: pull.merged,
  });

  const api: GhApi = async (route, params) => {
    calls.push({ route, params });
    const space = route.indexOf(" ");
    const method = route.slice(0, space);
    const rest = route.slice(space + 1).replace(`/repos/${REPO}`, "");

    if (method === "GET" && rest === "/pulls") {
      const head = String(params?.head ?? "");
      const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
      return ok(pulls.filter((p) => p.branch === branch).map(toPullJson));
    }
    if (method === "GET" && rest.startsWith("/git/ref/heads/")) {
      const sha = refs.get(rest.slice("/git/ref/heads/".length));
      if (sha === undefined) throw httpError(404, "Not Found");
      return ok({ object: { sha } });
    }
    if (method === "GET" && rest.startsWith("/git/commits/")) {
      const sha = rest.slice("/git/commits/".length);
      const commit = commits.get(sha);
      if (commit === undefined) throw httpError(404, "Not Found");
      return ok({ sha, message: commit.message, tree: { sha: commit.tree } });
    }
    if (method === "GET" && rest.startsWith("/git/trees/")) {
      const entries = trees.get(rest.slice("/git/trees/".length));
      if (entries === undefined) throw httpError(404, "Not Found");
      return ok({ tree: entries });
    }
    if (method === "GET" && rest.startsWith("/contents/")) {
      const path = rest.slice("/contents/".length);
      const files = contentBySha.get(String(params?.ref ?? ""));
      if (files === undefined) throw httpError(404, `unknown ref ${String(params?.ref)}`);
      const content = files[path];
      if (content === undefined) throw httpError(404, `no ${path} at ${String(params?.ref)}`);
      return ok({ content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64", sha: `b:${path}` });
    }
    if (method === "POST" && rest === "/git/blobs") {
      const sha = `blob${++counter}`;
      blobs.set(sha, Buffer.from(String(params?.content), "base64").toString("utf8"));
      return ok({ sha });
    }
    if (method === "POST" && rest === "/git/trees") {
      const sha = `tree${++counter}`;
      trees.set(sha, params?.tree as TreeEntry[]);
      return ok({ sha });
    }
    if (method === "POST" && rest === "/git/commits") {
      const sha = `commit${++counter}`;
      commits.set(sha, {
        message: String(params?.message),
        tree: String(params?.tree),
        parents: params?.parents as string[],
      });
      return ok({ sha, message: String(params?.message), tree: { sha: String(params?.tree) } });
    }
    if (method === "POST" && rest === "/git/refs") {
      const branch = String(params?.ref).replace("refs/heads/", "");
      if (refs.has(branch)) throw httpError(422, "Reference already exists");
      refs.set(branch, String(params?.sha));
      return ok({ ref: String(params?.ref), object: { sha: String(params?.sha) } });
    }
    if (method === "POST" && rest === "/pulls") {
      const branch = String(params?.head);
      if (pulls.some((p) => p.branch === branch)) throw httpError(422, "A pull request already exists");
      const headSha = refs.get(branch);
      if (headSha === undefined) throw httpError(422, `no such head branch ${branch}`);
      const pull: SimPull = {
        number: 100 + pulls.length,
        branch,
        draft: params?.draft === true,
        state: "open",
        merged: false,
        headSha,
        title: String(params?.title),
        body: String(params?.body),
      };
      pulls.push(pull);
      return ok(toPullJson(pull));
    }
    throw new Error(`github simulator: unhandled route ${route}`);
  };

  return { api, calls, refs, commits, trees, blobs, pulls };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function reportIdentity(headSha: string): NightlyReportIdentity {
  return {
    repository: REPO,
    branch: "main",
    baseSha: BASE_SHA,
    headSha,
    policyVersion: "policy-7",
    schemaVersion: NIGHTLY_REPORT_SCHEMA_VERSION,
  };
}

function occurrence(headSha: string, findingKey: string): FindingOccurrenceIdentity {
  return { report: reportIdentity(headSha), findingKey };
}

const TLS_KEY = "disabled-tls-verification|src/http.ts|4";
const SSL_KEY = "disabled-tls-verification|src/config.ts|2";

/** Build the full delivery input the way `planFixDeliveryEffects` does. */
function deliveryInput(options: {
  headSha: string;
  findingKey: string;
  defectClass: string;
  ruleId: string;
  provenance: ReturnType<typeof deterministicFixerProvenance>;
  readiness: "ready" | "draft";
  validationState: string;
  edits: readonly PreconditionedEdit[];
  childIssue: { number: number; url: string } | null;
  parentIssue?: { number: number; url: string } | null;
}): PullRequestInput {
  const report = reportIdentity(options.headSha);
  const occ = occurrence(options.headSha, options.findingKey);
  const proposalId = fixProposalId({ occurrence: occ, provenance: options.provenance });
  const body = renderFixPullRequestBody({
    report,
    reportId: nightlyReportId(report),
    proposalId,
    occurrenceId: findingOccurrenceId(occ),
    defectClass: options.defectClass,
    ruleId: options.ruleId,
    provenance: options.provenance,
    readiness: options.readiness,
    validationState: options.validationState,
    childIssue: options.childIssue,
    parentIssue: options.parentIssue ?? null,
    edits: options.edits,
    findingSummary: `${options.defectClass} at ${options.edits[0]?.path ?? "unknown"}`,
  });
  return {
    subject: { repository: REPO, commitSha: options.headSha },
    externalId: fixProposalExternalId(proposalId),
    branch: fixProposalBranch({ proposalId, defectClass: options.defectClass, headSha: options.headSha }),
    baseBranch: report.branch,
    baseSha: report.baseSha,
    title: `${options.readiness === "draft" ? "[unconfirmed] " : ""}Fix ${options.defectClass} in ${options.edits[0]?.path ?? "?"}`,
    body,
    edits: options.edits.map((edit) => ({
      path: edit.path,
      startLine: edit.startLine,
      endLine: edit.endLine,
      replacement: edit.replacement,
      ...(edit.expectedOriginal === undefined ? {} : { expectedOriginal: edit.expectedOriginal }),
    })),
    draft: options.readiness === "draft",
    proposalId,
    provenance: options.provenance,
  };
}

const TLS_EDIT: PreconditionedEdit = {
  path: "src/http.ts",
  startLine: 4,
  endLine: 4,
  replacement: "  rejectUnauthorized: true,",
  expectedOriginal: "  rejectUnauthorized: false,",
  rationale: "re-enable certificate verification",
};

const CONFIG_EDIT: PreconditionedEdit = {
  path: "src/config.ts",
  startLine: 2,
  endLine: 2,
  replacement: "  verifySsl: true,",
  expectedOriginal: "  verifySsl: false,",
  rationale: "re-enable ssl verification",
};

const DETERMINISTIC = deterministicFixerProvenance("disabled-tls-verification");
const MODEL = modelFixerProvenance({ fixerId: "model:remediation", modelId: "claude-x", promptVersion: "remediation-fix-1" });

// ── Contract ──────────────────────────────────────────────────────────────────

describe("GitHub App fix delivery", () => {
  it("opens candidate-bound ready and draft PRs", async () => {
    const repo = githubRepo({ [CANDIDATE_1]: { "src/http.ts": TLS_FILE, "src/config.ts": CONFIG_FILE } });
    const scm = new GithubAppScmWriter({ api: repo.api });

    // A critic-CONFIRMED deterministic proposal: opens ready for review.
    const confirmed = deliveryInput({
      headSha: CANDIDATE_1,
      findingKey: TLS_KEY,
      defectClass: "disabled-tls-verification",
      ruleId: "tls.verify",
      provenance: DETERMINISTIC,
      readiness: "ready",
      validationState: "deterministic_patch_ready",
      edits: [TLS_EDIT],
      childIssue: { number: 41, url: `https://github.test/${REPO}/issues/41` },
      parentIssue: { number: 40, url: `https://github.test/${REPO}/issues/40` },
    });
    // A structurally safe but semantically UNCERTAIN model proposal: opens draft.
    const uncertain = deliveryInput({
      headSha: CANDIDATE_1,
      findingKey: SSL_KEY,
      defectClass: "disabled-tls-verification",
      ruleId: "tls.verify",
      provenance: MODEL,
      readiness: "draft",
      validationState: "critic_indeterminate",
      edits: [CONFIG_EDIT],
      childIssue: { number: 42, url: `https://github.test/${REPO}/issues/42` },
      parentIssue: { number: 40, url: `https://github.test/${REPO}/issues/40` },
    });

    const ready = await scm.openPullRequest(confirmed);
    const draft = await scm.openPullRequest(uncertain);

    expect(ready).toMatchObject({ created: true, draft: false });
    expect(draft).toMatchObject({ created: true, draft: true });
    expect(ready.number).not.toBe(draft.number);
    // The head sha is the immutable evidence anchor every CI verdict binds to.
    expect(repo.refs.get(confirmed.branch)).toBe(ready.headSha);
    expect(repo.refs.get(uncertain.branch)).toBe(draft.headSha);

    // Branch identity is candidate-bound and proposal-bound: same repository,
    // same defect class, same reviewed candidate — different proposals, different
    // branches and different SCM idempotency keys.
    expect(confirmed.branch).not.toBe(uncertain.branch);
    expect(confirmed.externalId).not.toBe(uncertain.externalId);
    for (const input of [confirmed, uncertain]) {
      expect(input.branch).toContain(CANDIDATE_1.slice(0, 12));
      expect(input.branch).toContain(input.proposalId.slice("nfp_".length));
    }

    // ...and the FIXER/PROMPT versions are part of it, so a prompt bump mints a new
    // proposal instead of silently redefining the published one.
    const bumped = fixProposalBranch({
      proposalId: fixProposalId({
        occurrence: occurrence(CANDIDATE_1, SSL_KEY),
        provenance: modelFixerProvenance({ fixerId: "model:remediation", modelId: "claude-x", promptVersion: "remediation-fix-2" }),
      }),
      defectClass: "disabled-tls-verification",
      headSha: CANDIDATE_1,
    });
    expect(bumped).not.toBe(uncertain.branch);

    // Each PR body links its own child issue, the shared parent, and the reviewed sha.
    const readyPull = repo.pulls.find((p) => p.number === ready.number)!;
    const draftPull = repo.pulls.find((p) => p.number === draft.number)!;
    expect(readyPull.body).toContain("Finding issue: #41");
    expect(readyPull.body).toContain("Nightly run issue: #40");
    expect(readyPull.body).toContain(`Reviewed head: \`${CANDIDATE_1}\``);
    expect(readyPull.body).not.toContain("Draft — unconfirmed remediation");
    expect(draftPull.body).toContain("Finding issue: #42");
    expect(draftPull.body).toContain("Draft — unconfirmed remediation");
    expect(draftPull.title).toContain("[unconfirmed]");
    // Neither is merged, and nothing asked GitHub to merge them.
    expect(repo.pulls.every((p) => !p.merged)).toBe(true);
    expect(repo.calls.some((c) => c.route.includes("/merge"))).toBe(false);
  });

  it("commits all preconditioned edits atomically", async () => {
    const repo = githubRepo({ [CANDIDATE_1]: { "src/http.ts": TLS_FILE, "src/config.ts": CONFIG_FILE } });
    const scm = new GithubAppScmWriter({ api: repo.api });

    const input = deliveryInput({
      headSha: CANDIDATE_1,
      findingKey: TLS_KEY,
      defectClass: "disabled-tls-verification",
      ruleId: "tls.verify",
      provenance: DETERMINISTIC,
      readiness: "ready",
      validationState: "deterministic_patch_ready",
      edits: [TLS_EDIT, CONFIG_EDIT],
      childIssue: { number: 41, url: `https://github.test/${REPO}/issues/41` },
    });

    const result = await scm.openPullRequest(input);

    // Every preimage was checked against content read AT THE REVIEWED SHA.
    const contentReads = repo.calls.filter((c) => c.route.includes("/contents/"));
    expect(contentReads).toHaveLength(2);
    expect(contentReads.every((c) => c.params?.ref === CANDIDATE_1)).toBe(true);

    // One tree, one commit: both files land together, never file-by-file.
    const treeWrites = repo.calls.filter((c) => c.route === `POST /repos/${REPO}/git/trees`);
    const commitWrites = repo.calls.filter((c) => c.route === `POST /repos/${REPO}/git/commits`);
    expect(treeWrites).toHaveLength(1);
    expect(commitWrites).toHaveLength(1);
    expect((treeWrites[0].params?.tree as TreeEntry[]).map((e) => e.path).sort()).toEqual(["src/config.ts", "src/http.ts"]);
    expect(Array.from(repo.blobs.values()).join("\n")).toContain("rejectUnauthorized: true,");
    expect(Array.from(repo.blobs.values()).join("\n")).toContain("verifySsl: true,");
    expect(Array.from(repo.blobs.values()).join("\n")).not.toContain("rejectUnauthorized: false");

    // The commit is parented on the reviewed candidate and carries the manifest.
    const commit = repo.commits.get(repo.refs.get(input.branch)!)!;
    expect(commit.parents).toEqual([CANDIDATE_1]);
    expect(commit.message).toContain(`Scruffy-Fix-Proposal: ${input.proposalId}`);
    expect(commit.message).toContain(`Scruffy-Reviewed-Sha: ${CANDIDATE_1}`);

    // Ordering: the branch exists only after the whole commit does, and the PR only
    // after the branch — there is no window where a PR describes edits that are not there.
    const indexOf = (route: string) => repo.calls.findIndex((c) => c.route === `POST /repos/${REPO}${route}`);
    expect(indexOf("/git/refs")).toBeGreaterThan(indexOf("/git/commits"));
    expect(indexOf("/pulls")).toBeGreaterThan(indexOf("/git/refs"));
    expect(result.created).toBe(true);
  });

  it("refuses a stale preimage without writing a ref or opening a PR", async () => {
    // The SECOND file of the proposal no longer matches what it claims to replace,
    // so the first file has already been read and applied by the time the refusal
    // happens — the case where a naive writer leaves an orphan blob behind.
    const drifted = CONFIG_FILE.replace("  verifySsl: false,", "  verifySsl: false, // audited");
    const repo = githubRepo({ [CANDIDATE_1]: { "src/http.ts": TLS_FILE, "src/config.ts": drifted } });
    const scm = new GithubAppScmWriter({ api: repo.api });

    const input = deliveryInput({
      headSha: CANDIDATE_1,
      findingKey: TLS_KEY,
      defectClass: "disabled-tls-verification",
      ruleId: "tls.verify",
      provenance: DETERMINISTIC,
      readiness: "ready",
      validationState: "deterministic_patch_ready",
      edits: [TLS_EDIT, CONFIG_EDIT],
      childIssue: null,
    });

    await expect(scm.openPullRequest(input)).rejects.toThrow(/preimage mismatch/);
    expect(repo.refs.size).toBe(0);
    expect(repo.pulls).toHaveLength(0);
    // Not even the unaffected file was pushed: a partial patch is worse than none,
    // and read-and-verify completes for EVERY file before the first byte is written.
    expect(repo.calls.some((c) => c.route === `POST /repos/${REPO}/git/blobs`)).toBe(false);
    expect(repo.calls.some((c) => c.route === `POST /repos/${REPO}/git/trees`)).toBe(false);
  });

  it("refuses a colliding branch that does not declare this proposal", async () => {
    const repo = githubRepo({ [CANDIDATE_1]: { "src/http.ts": TLS_FILE } });
    const scm = new GithubAppScmWriter({ api: repo.api });
    const input = deliveryInput({
      headSha: CANDIDATE_1,
      findingKey: TLS_KEY,
      defectClass: "disabled-tls-verification",
      ruleId: "tls.verify",
      provenance: DETERMINISTIC,
      readiness: "ready",
      validationState: "deterministic_patch_ready",
      edits: [TLS_EDIT],
      childIssue: null,
    });
    // Someone (or a half-finished attempt) already moved the branch.
    repo.commits.set("squatter", { message: "unrelated work", tree: `t:${CANDIDATE_1}`, parents: [CANDIDATE_1] });
    repo.refs.set(input.branch, "squatter");

    await expect(scm.openPullRequest(input)).rejects.toThrow(/does not declare fix proposal/);
    expect(repo.pulls).toHaveLength(0);
  });

  it("crash-resume: re-delivering the same proposal reuses the branch and the PR", async () => {
    const repo = githubRepo({ [CANDIDATE_1]: { "src/http.ts": TLS_FILE } });
    const scm = new GithubAppScmWriter({ api: repo.api });
    const input = deliveryInput({
      headSha: CANDIDATE_1,
      findingKey: TLS_KEY,
      defectClass: "disabled-tls-verification",
      ruleId: "tls.verify",
      provenance: DETERMINISTIC,
      readiness: "ready",
      validationState: "deterministic_patch_ready",
      edits: [TLS_EDIT],
      childIssue: null,
    });

    const first = await scm.openPullRequest(input);
    const second = await scm.openPullRequest(input);

    expect(second).toEqual({ ...first, created: false });
    expect(repo.pulls).toHaveLength(1);

    // And a crash between "ref created" and "PR opened" resumes on the manifest
    // rather than re-committing or refusing.
    repo.pulls.length = 0;
    const resumed = await scm.openPullRequest(input);
    expect(resumed.created).toBe(true);
    expect(repo.commits.get(repo.refs.get(input.branch)!)!.message).toContain(input.proposalId);
    expect(repo.calls.filter((c) => c.route === `POST /repos/${REPO}/git/commits`)).toHaveLength(1);
  });

  it("does not reuse an old PR for a later candidate", async () => {
    // Candidate 1: the finding is fixed, the PR is opened, and a human CLOSES it
    // without merging. The defect is still in the tree.
    const repo = githubRepo({
      [CANDIDATE_1]: { "src/http.ts": TLS_FILE },
      [CANDIDATE_2]: { "src/http.ts": TLS_FILE },
    });
    const scm = new GithubAppScmWriter({ api: repo.api });

    const first = deliveryInput({
      headSha: CANDIDATE_1,
      findingKey: TLS_KEY,
      defectClass: "disabled-tls-verification",
      ruleId: "tls.verify",
      provenance: DETERMINISTIC,
      readiness: "ready",
      validationState: "deterministic_patch_ready",
      edits: [TLS_EDIT],
      childIssue: { number: 41, url: `https://github.test/${REPO}/issues/41` },
    });
    const old = await scm.openPullRequest(first);
    repo.pulls.find((p) => p.number === old.number)!.state = "closed";

    // A LATER nightly finds the same defect class at the same path and line. Under
    // the old path/line branch derivation this collided with the closed PR above and
    // the live defect looked handled; the proposal identity makes it a new proposal.
    const later = deliveryInput({
      headSha: CANDIDATE_2,
      findingKey: TLS_KEY,
      defectClass: "disabled-tls-verification",
      ruleId: "tls.verify",
      provenance: DETERMINISTIC,
      readiness: "ready",
      validationState: "deterministic_patch_ready",
      edits: [TLS_EDIT],
      childIssue: { number: 77, url: `https://github.test/${REPO}/issues/77` },
    });

    expect(later.branch).not.toBe(first.branch);
    expect(later.externalId).not.toBe(first.externalId);
    expect(later.proposalId).not.toBe(first.proposalId);

    const fresh = await scm.openPullRequest(later);

    expect(fresh.created).toBe(true);
    expect(fresh.number).not.toBe(old.number);
    expect(repo.pulls).toHaveLength(2);
    // The new PR is anchored to the LATER candidate, not the closed one's branch.
    expect(repo.commits.get(repo.refs.get(later.branch)!)!.parents).toEqual([CANDIDATE_2]);
    expect(repo.pulls.find((p) => p.number === fresh.number)!.body).toContain(`Reviewed head: \`${CANDIDATE_2}\``);
    expect(repo.pulls.find((p) => p.number === fresh.number)!.body).toContain("Finding issue: #77");
    // The closed PR was left exactly as the human left it.
    expect(repo.pulls.find((p) => p.number === old.number)!.state).toBe("closed");
  });
});
