import { describe, expect, it } from "vitest";
import { parseReleaseArgs } from "../../scripts/release-review.js";

/**
 * Offline unit tests for the release-review arg boundary. Both the candidate and
 * the previous-release refs are interpolated into a `gh api` path, so parsing must
 * reject `..` traversal / query-fragment splices / control chars BEFORE they reach
 * the URL, and must preserve the omitted-prev-release => null distinction the
 * release range depends on (null = first release over the candidate's own changes).
 *
 * Importing the module must NOT run `main()` (entrypoint-guarded), so these run
 * without any network, real `gh`, or Postgres. The ref-safety and head-resolution
 * seams (isSafeRef / resolveBranchHead) are covered by the nightly-review suite —
 * this module reuses them, so we only test what release adds: the arg parse.
 */

describe("parseReleaseArgs", () => {
  it("accepts repo + candidate with an explicit previous release", () => {
    expect(parseReleaseArgs(["acme/widgets", "v2.0.0", "v1.0.0"])).toEqual({
      repo: "acme/widgets",
      candidateRef: "v2.0.0",
      prevRef: "v1.0.0",
    });
  });

  it("treats an omitted previous release as null (first-ever release)", () => {
    expect(parseReleaseArgs(["acme/widgets", "main"])).toEqual({
      repo: "acme/widgets",
      candidateRef: "main",
      prevRef: null,
    });
  });

  it("rejects a missing or malformed repo", () => {
    expect(parseReleaseArgs([])).toBeNull();
    expect(parseReleaseArgs(["not-a-repo", "main"])).toBeNull(); // no slash
    expect(parseReleaseArgs(["", "main"])).toBeNull();
  });

  it("rejects a missing candidate ref", () => {
    expect(parseReleaseArgs(["acme/widgets"])).toBeNull();
  });

  it("rejects an unsafe candidate ref (traversal / splice / control char)", () => {
    expect(parseReleaseArgs(["acme/widgets", "feature/../../etc"])).toBeNull();
    expect(parseReleaseArgs(["acme/widgets", "main?foo=bar"])).toBeNull();
    expect(parseReleaseArgs(["acme/widgets", "main\n"])).toBeNull();
  });

  it("rejects an unsafe previous-release ref while the candidate is fine", () => {
    expect(parseReleaseArgs(["acme/widgets", "main", "v1..v2"])).toBeNull();
    expect(parseReleaseArgs(["acme/widgets", "main", "tag#frag"])).toBeNull();
  });
});
