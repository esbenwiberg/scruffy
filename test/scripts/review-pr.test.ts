import { afterEach, describe, expect, it, vi } from "vitest";
import { PrPayload, resolvePrHead, withPool } from "../../scripts/review-pr.js";
import type { Pool } from "../../src/persistence/db.js";

/**
 * Offline unit tests for the two review-pr seams that guard the error paths:
 *  - resolvePrHead: an unexpected/malformed `gh` payload must map to the friendly
 *    message + exit 1, never an opaque TypeError from dereferencing `.head.sha`.
 *  - withPool: the pool is ALWAYS ended, including when `migrate` throws.
 * Importing the module must NOT run `main()` (entrypoint-guarded), so these run
 * without any network, real `gh`, or Postgres.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolvePrHead", () => {
  it("accepts a well-formed PR payload", () => {
    const sha = "a".repeat(40);
    const gh = vi.fn(() => ({ head: { sha }, html_url: "https://example/pr/1" }));
    expect(resolvePrHead(gh, "acme/widgets", "1")).toEqual({
      headSha: sha,
      htmlUrl: "https://example/pr/1",
    });
  });

  it("exits 1 on a payload with no head (instead of a TypeError)", () => {
    // An error object returned with exit code 0 — the exact shape the finding warns about.
    const gh = vi.fn(() => ({ message: "Not Found", status: "404" }));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => resolvePrHead(gh, "acme/widgets", "1")).toThrow("exit:1");
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

    expect(() => resolvePrHead(gh, "acme/widgets", "1")).toThrow("exit:1");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("PrPayload rejects an empty sha", () => {
    expect(PrPayload.safeParse({ head: { sha: "" }, html_url: "x" }).success).toBe(false);
  });
});

describe("withPool", () => {
  it("ends the pool exactly once when migrate throws", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { end } as unknown as Pool;
    const migrate = vi.fn().mockRejectedValue(new Error("bad DATABASE_URL"));
    const body = vi.fn();

    await expect(withPool(() => pool, migrate, body)).rejects.toThrow("bad DATABASE_URL");
    expect(body).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("runs the body and ends the pool exactly once on success", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const pool = { end } as unknown as Pool;
    const migrate = vi.fn().mockResolvedValue([]);
    const body = vi.fn().mockResolvedValue(undefined);

    await withPool(() => pool, migrate, body);
    expect(body).toHaveBeenCalledWith(pool);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
