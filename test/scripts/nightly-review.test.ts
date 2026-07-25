import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitPayload, isSafeRef, resolveBranchHead } from "../../scripts/nightly-review.js";

/**
 * Offline unit tests for the nightly-review seams that guard the error/injection
 * paths:
 *  - isSafeRef: a branch/sha ref is interpolated into a `gh api` path, so `..`
 *    traversal, query/fragment splices, and control chars must be rejected BEFORE
 *    they reach the URL.
 *  - resolveBranchHead: an unexpected/malformed `gh` payload maps to the friendly
 *    message + exit 1, never an opaque TypeError from dereferencing `.sha`.
 * Importing the module must NOT run `main()` (entrypoint-guarded), so these run
 * without any network, real `gh`, or Postgres.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isSafeRef", () => {
  it("accepts ordinary branch names and shas", () => {
    expect(isSafeRef("main")).toBe(true);
    expect(isSafeRef("feature/github-app-reader")).toBe(true);
    expect(isSafeRef("release-1.2.3")).toBe(true);
    expect(isSafeRef("a".repeat(40))).toBe(true);
  });

  it("rejects traversal, path/query/fragment splices, and control chars", () => {
    expect(isSafeRef("")).toBe(false);
    expect(isSafeRef("..")).toBe(false);
    expect(isSafeRef("feature/../../etc")).toBe(false); // `..` traversal
    expect(isSafeRef("main?foo=bar")).toBe(false); // query splice
    expect(isSafeRef("main#frag")).toBe(false); // fragment splice
    expect(isSafeRef("main branch")).toBe(false); // space
    expect(isSafeRef("main%2f..")).toBe(false); // percent-encoding
    expect(isSafeRef("/leading-slash")).toBe(false);
    expect(isSafeRef("main\n")).toBe(false); // control char
  });
});

describe("resolveBranchHead", () => {
  it("accepts a well-formed commit payload", () => {
    const sha = "a".repeat(40);
    const gh = vi.fn(() => ({ sha, html_url: "https://example/commit/abc" }));
    expect(resolveBranchHead(gh, "acme/widgets", "main")).toEqual({
      headSha: sha,
      htmlUrl: "https://example/commit/abc",
    });
  });

  it("exits 1 on a payload with no sha (instead of a TypeError)", () => {
    const gh = vi.fn(() => ({ message: "Not Found", status: "404" }));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => resolveBranchHead(gh, "acme/widgets", "main")).toThrow("exit:1");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 when gh itself throws (transport/auth failure)", () => {
    const gh = vi.fn(() => {
      throw new Error("gh: not authenticated");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => resolveBranchHead(gh, "acme/widgets", "main")).toThrow("exit:1");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("CommitPayload rejects a non-40-char sha", () => {
    expect(CommitPayload.safeParse({ sha: "abc", html_url: "x" }).success).toBe(false);
    expect(CommitPayload.safeParse({ sha: "a".repeat(40), html_url: "" }).success).toBe(false);
  });
});
