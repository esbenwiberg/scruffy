import { describe, expect, it } from "vitest";
import { GithubAppScmWriter, type GhApi } from "../../src/providers/scm/github-app.js";
import { SCRUFFY_ISSUE_LABEL, workItemIssueMarker } from "../../src/domain/findings/work-publication.js";
import type { IssueRef, IssueUpsertInput } from "../../src/providers/scm/port.js";

/**
 * Offline contract test for GitHub ISSUE publication: the parent/child hierarchy
 * through the native sub-issue endpoint, and the crash-resume lookup that keeps a
 * process death between "GitHub created it" and "we stored it" from duplicating.
 *
 * A stubbed `GhApi` returns recorded GitHub JSON shapes (and throws status-carrying
 * errors like Octokit's RequestError), so identity, pagination, and error discipline
 * are pinned with no network and no App credentials.
 *
 * The two behaviours these tests exist to defend:
 *  - identity is the hidden MARKER, never the title and never a search index. A
 *    title carries counts and line numbers that change between attempts, and
 *    `GET /search/issues` lags a write by seconds to minutes — precisely the window
 *    a crash-resume lands in;
 *  - attachment uses the child's database ID, which is a different value from its
 *    number. Passing the number would attach the wrong issue or 404.
 */

const REPO = "acme/widgets";
const PARENT_WORK_ITEM = "nwi_run_1111111111111111";
const CHILD_WORK_ITEM = "nwi_fnd_2222222222222222";
const PARENT_MARKER = workItemIssueMarker(PARENT_WORK_ITEM);
const CHILD_MARKER = workItemIssueMarker(CHILD_WORK_ITEM);

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

/** A GitHub issue payload. `id` (database id) is deliberately unlike `number`. */
function issue(number: number, id: number, body: string): Record<string, unknown> {
  return { number, id, html_url: `https://github.com/${REPO}/issues/${number}`, body };
}

const isIssueList = (r: string) => /^GET \/repos\/[^/]+\/[^/]+\/issues$/.test(r);
const isIssueCreate = (r: string) => /^POST \/repos\/[^/]+\/[^/]+\/issues$/.test(r);
const isIssuePatch = (r: string) => /^PATCH \/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(r);
const isSubIssueList = (r: string) => r.startsWith("GET") && r.endsWith("/sub_issues");
const isSubIssueCreate = (r: string) => r.startsWith("POST") && r.endsWith("/sub_issues");

function upsertInput(overrides: Partial<IssueUpsertInput> = {}): IssueUpsertInput {
  return {
    repository: REPO,
    marker: PARENT_MARKER,
    labels: [SCRUFFY_ISSUE_LABEL, "scruffy:nightly-run"],
    title: "Nightly review acme/widgets@main: 1 finding(s), 1 coverage gap(s)",
    body: "Coverage: complete.",
    ...overrides,
  };
}

describe("GithubAppScmWriter issue publication", () => {
  it("creates and attaches native child issues", async () => {
    // The whole hierarchy in one flow: parent first (children need its number), then
    // each child, then the native sub-issue attachment keyed on the child's DB id.
    const created: Record<string, unknown>[] = [];
    const attached: unknown[] = [];
    const { api, calls } = stub([
      // No Scruffy-labelled issues exist yet, and the parent has no sub-issues yet.
      { match: isSubIssueList, reply: () => ok([]) },
      { match: isIssueList, reply: () => ok([]) },
      {
        match: isIssueCreate,
        reply: (call) => {
          const number = created.length + 10;
          created.push(call.params!);
          // GitHub database ids are unrelated to issue numbers — the sub-issue API
          // takes the id, so a test that made them equal would prove nothing.
          return ok(issue(number, number * 1000, String(call.params!.body)));
        },
      },
      {
        match: isSubIssueCreate,
        reply: (call) => {
          attached.push(call.params!.sub_issue_id);
          return { status: 201, data: {} };
        },
      },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const parent = await scm.upsertIssue(upsertInput());
    expect(parent).toEqual({
      number: 10,
      id: "10000",
      url: `https://github.com/${REPO}/issues/10`,
      created: true,
    });

    const findingChild = await scm.upsertIssue(
      upsertInput({ marker: CHILD_MARKER, title: "leaked-credential at src/config.ts:1", body: "evidence" }),
    );
    const coverageChild = await scm.upsertIssue(
      upsertInput({
        marker: workItemIssueMarker("nwi_cov_3333333333333333"),
        title: "Coverage gap: model-analyzer (provider_unavailable)",
        body: "backend returned 503",
      }),
    );
    expect(findingChild.number).toBe(11);
    expect(coverageChild.number).toBe(12);

    // Every created body carries its hidden marker: without it, a retry could not
    // recognise the issue and would open a second one.
    expect(String(created[0]!.body)).toContain(PARENT_MARKER);
    expect(String(created[1]!.body)).toContain(CHILD_MARKER);
    // ...and the labels that scope the lookup server-side.
    expect(created[0]!.labels).toEqual([SCRUFFY_ISSUE_LABEL, "scruffy:nightly-run"]);

    const parentRef: IssueRef = { number: parent.number, id: parent.id, url: parent.url };
    for (const child of [findingChild, coverageChild]) {
      const result = await scm.linkChildIssue({
        repository: REPO,
        parent: parentRef,
        child: { number: child.number, id: child.id, url: child.url },
      });
      expect(result).toEqual({ alreadyLinked: false });
    }

    // Both children attached through the NATIVE endpoint, on the parent's number,
    // carrying each child's DATABASE id (11000/12000), not its number (11/12).
    expect(attached).toEqual([11000, 12000]);
    const attachRoutes = calls.filter((c) => isSubIssueCreate(c.route)).map((c) => c.route);
    expect(attachRoutes).toEqual([
      `POST /repos/${REPO}/issues/10/sub_issues`,
      `POST /repos/${REPO}/issues/10/sub_issues`,
    ]);
  });

  it("recovers marker-matched issue after crash", async () => {
    // The crash: GitHub created the issue, the process died before the number was
    // persisted, and the effect is retried. The retry must find THAT issue.
    const listed: Record<string, unknown>[] = [
      issue(7, 7007, `some other repo activity`),
      issue(8, 8008, `Coverage: complete.\n\n${PARENT_MARKER}`),
    ];
    const { api, calls } = stub([
      { match: isIssueList, reply: () => ok(listed) },
      { match: isIssuePatch, reply: (call) => ok(issue(8, 8008, String(call.params!.body))) },
      {
        match: isIssueCreate,
        reply: () => {
          throw new Error("a duplicate issue must never be created for a marker already on record");
        },
      },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.upsertIssue(upsertInput());

    // The existing issue is returned and UPDATED — no duplicate.
    expect(result).toEqual({ number: 8, id: "8008", url: `https://github.com/${REPO}/issues/8`, created: false });
    expect(calls.some((c) => isIssueCreate(c.route))).toBe(false);
    expect(calls.filter((c) => isIssuePatch(c.route))).toHaveLength(1);

    // The lookup read the primary store, not the search index, and never keyed on
    // the title: the list is filtered by label + state only.
    const list = calls.find((c) => isIssueList(c.route))!;
    expect(list.route).not.toContain("search");
    expect(list.params).toMatchObject({ state: "all", labels: "scruffy,scruffy:nightly-run" });
    expect(JSON.stringify(list.params)).not.toContain("Nightly review");

    // The marker survives the update, so a THIRD attempt still recognises the issue.
    expect(String(calls.find((c) => isIssuePatch(c.route))!.params!.body)).toContain(PARENT_MARKER);
  });

  it("paginates the marker lookup and stops at the first short page", async () => {
    // A repository with more Scruffy issues than one page: a lookup that gave up
    // after page 1 would report "not found" and duplicate.
    const firstPage = Array.from({ length: 100 }, (_, i) => issue(200 + i, 200_000 + i, "unrelated"));
    const { api, calls } = stub([
      {
        match: isIssueList,
        reply: (call) => {
          const page = Number(call.params!.page);
          if (page === 1) return ok(firstPage);
          if (page === 2) return ok([issue(9, 9009, `body\n${PARENT_MARKER}`)]);
          throw new Error("must stop once a short page is seen");
        },
      },
      { match: isIssuePatch, reply: (call) => ok(issue(9, 9009, String(call.params!.body))) },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.upsertIssue(upsertInput());

    expect(result.number).toBe(9);
    expect(calls.filter((c) => isIssueList(c.route)).map((c) => c.params!.page)).toEqual([1, 2]);
  });

  it("ignores a pull request whose body happens to carry the marker", async () => {
    // `GET /issues` mixes PRs in with issues. Treating a marker-bearing PR as the
    // published work item would attach a PR under the parent and never file the issue.
    const { api, calls } = stub([
      { match: isIssueList, reply: () => ok([{ ...issue(4, 4004, `quoted ${PARENT_MARKER}`), pull_request: { url: "x" } }]) },
      { match: isIssueCreate, reply: () => ok(issue(5, 5005, "created")) },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.upsertIssue(upsertInput());

    expect(result).toMatchObject({ number: 5, created: true });
    expect(calls.some((c) => isIssuePatch(c.route))).toBe(false);
  });

  it("a DIFFERENT marker does not match — a later candidate's work is a new issue", async () => {
    const { api } = stub([
      { match: isIssueList, reply: () => ok([issue(8, 8008, `body\n${CHILD_MARKER}`)]) },
      { match: isIssueCreate, reply: () => ok(issue(20, 20020, "created")) },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.upsertIssue(upsertInput({ marker: PARENT_MARKER }));
    expect(result).toMatchObject({ number: 20, created: true });
  });

  it("an already-attached child is a no-op, not a second attachment", async () => {
    const { api, calls } = stub([{ match: isSubIssueList, reply: () => ok([{ id: 11000, number: 11 }]) }]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.linkChildIssue({
      repository: REPO,
      parent: { number: 10, id: "10000", url: "u" },
      child: { number: 11, id: "11000", url: "u" },
    });

    expect(result).toEqual({ alreadyLinked: true });
    expect(calls.some((c) => isSubIssueCreate(c.route))).toBe(false);
  });

  it("resolves a 422 attach race by re-listing and reporting alreadyLinked", async () => {
    let listCalls = 0;
    const { api } = stub([
      {
        match: isSubIssueList,
        reply: () => {
          listCalls += 1;
          return listCalls === 1 ? ok([]) : ok([{ id: 11000, number: 11 }]);
        },
      },
      {
        match: isSubIssueCreate,
        reply: () => {
          throw httpError(422, "sub-issue already exists");
        },
      },
    ]);
    const scm = new GithubAppScmWriter({ api });

    const result = await scm.linkChildIssue({
      repository: REPO,
      parent: { number: 10, id: "10000", url: "u" },
      child: { number: 11, id: "11000", url: "u" },
    });
    expect(result).toEqual({ alreadyLinked: true });
  });

  it("a 422 that is NOT an existing attachment still throws", async () => {
    // e.g. GitHub rejecting a cycle. Swallowing it would record an attachment that
    // does not exist.
    const { api } = stub([
      { match: isSubIssueList, reply: () => ok([]) },
      {
        match: isSubIssueCreate,
        reply: () => {
          throw httpError(422, "would create a cycle");
        },
      },
    ]);
    const scm = new GithubAppScmWriter({ api });

    await expect(
      scm.linkChildIssue({
        repository: REPO,
        parent: { number: 10, id: "10000", url: "u" },
        child: { number: 11, id: "11000", url: "u" },
      }),
    ).rejects.toThrow(/cycle/);
  });

  it("refuses a child id that is not a GitHub database id", async () => {
    const { api } = stub([{ match: isSubIssueList, reply: () => ok([]) }]);
    const scm = new GithubAppScmWriter({ api });

    await expect(
      scm.linkChildIssue({
        repository: REPO,
        parent: { number: 10, id: "10000", url: "u" },
        child: { number: 11, id: "azure-devops-guid", url: "u" },
      }),
    ).rejects.toThrow(/not a GitHub issue database id/);
  });

  it("THROWS on an API failure — the dispatcher must retry, never treat it as published", async () => {
    const api: GhApi = async () => {
      throw httpError(503);
    };
    const scm = new GithubAppScmWriter({ api });
    await expect(scm.upsertIssue(upsertInput())).rejects.toThrow(/503/);
  });

  it("THROWS on an unexpected response shape (external boundary is schema-parsed)", async () => {
    const { api } = stub([
      { match: isIssueList, reply: () => ok([]) },
      { match: isIssueCreate, reply: () => ok({ number: 5 }) }, // no id, no html_url
    ]);
    const scm = new GithubAppScmWriter({ api });
    await expect(scm.upsertIssue(upsertInput())).rejects.toThrow(/unexpected created issue/);
  });

  it("THROWS rather than create a possible duplicate when the lookup never terminates", async () => {
    // A pathological repository (or a broken pagination contract) must not fall
    // through to a create: an unbounded lookup that gives up is a duplicate parent.
    const fullPage = Array.from({ length: 100 }, (_, i) => issue(i + 1, i + 1, "unrelated"));
    const { api, calls } = stub([
      { match: isIssueList, reply: () => ok(fullPage) },
      {
        match: isIssueCreate,
        reply: () => {
          throw new Error("must not create when the lookup was inconclusive");
        },
      },
    ]);
    const scm = new GithubAppScmWriter({ api });

    await expect(scm.upsertIssue(upsertInput())).rejects.toThrow(/refusing to create a possible duplicate/);
    expect(calls.some((c) => isIssueCreate(c.route))).toBe(false);
  });
});
