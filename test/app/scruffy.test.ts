import { describe, expect, it } from "vitest";
import { Scruffy, type ScruffyDeps } from "../../src/app/scruffy.js";
import type { ReviewInput, ReviewResult } from "../../src/gates/nightly/service.js";

/**
 * Unit tests for the application-boundary behaviour of Scruffy that does not
 * need Postgres: sha validation at the runNightly boundary, and the bounded
 * flushEffects drain loop. The Scruffy constructor only stores its injected
 * refs, so a stub deps object is enough to build one; the collaborators the
 * method under test touches are then swapped for fakes.
 */

const REPO = "acme/web";
const HEAD = "a".repeat(40);

/** Build a Scruffy whose constructor-built collaborators can be overridden. */
function makeScruffy(): Scruffy {
  return new Scruffy({} as ScruffyDeps);
}

describe("Scruffy.runNightly base validation", () => {
  it("forwards a valid 40-hex base through to nightly.review", async () => {
    const scruffy = makeScruffy();
    const seen: ReviewInput[] = [];
    (scruffy as unknown as { nightly: { review(i: ReviewInput): Promise<ReviewResult> } }).nightly = {
      async review(input: ReviewInput): Promise<ReviewResult> {
        seen.push(input);
        return { reviewed: false, reason: "up-to-date" };
      },
    };

    const base = "b".repeat(40);
    await scruffy.runNightly({ repository: REPO, branch: "main", head: HEAD, base });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.base).toBe(base);
  });

  it("rejects a non-40-hex base at the boundary before touching nightly.review", async () => {
    const scruffy = makeScruffy();
    let reviewCalls = 0;
    (scruffy as unknown as { nightly: { review(i: ReviewInput): Promise<ReviewResult> } }).nightly = {
      async review(): Promise<ReviewResult> {
        reviewCalls += 1;
        return { reviewed: false, reason: "up-to-date" };
      },
    };

    await expect(
      scruffy.runNightly({ repository: REPO, branch: "main", head: HEAD, base: "not-a-sha" }),
    ).rejects.toThrow();
    // Rejected at the boundary — the review (and thus the DB) is never reached.
    expect(reviewCalls).toBe(0);
  });

  it("preserves the undefined base (use watermark) vs explicit null distinction", async () => {
    const scruffy = makeScruffy();
    const seen: ReviewInput[] = [];
    (scruffy as unknown as { nightly: { review(i: ReviewInput): Promise<ReviewResult> } }).nightly = {
      async review(input: ReviewInput): Promise<ReviewResult> {
        seen.push(input);
        return { reviewed: false, reason: "up-to-date" };
      },
    };

    await scruffy.runNightly({ repository: REPO, branch: "main", head: HEAD }); // omitted
    await scruffy.runNightly({ repository: REPO, branch: "main", head: HEAD, base: null }); // explicit null

    expect("base" in seen[0]!).toBe(false); // omitted -> not forwarded -> review uses watermark
    expect(seen[1]!.base).toBeNull(); // explicit null -> forwarded as null
  });
});

describe("Scruffy.flushEffects termination", () => {
  it("terminates under a poison-pill dispatcher that reports progress but never drains", async () => {
    const scruffy = makeScruffy();
    let calls = 0;
    (scruffy as unknown as { dispatcher: { dispatchOnce(): Promise<number> } }).dispatcher = {
      async dispatchOnce(): Promise<number> {
        calls += 1;
        return 1; // always positive; the same effect is never actually drained
      },
    };

    const total = await scruffy.flushEffects(5);
    // Bounded: it must stop at the pass cap instead of spinning forever.
    expect(calls).toBe(5);
    expect(total).toBe(5);
  });

  it("stops early as soon as a pass drains nothing", async () => {
    const scruffy = makeScruffy();
    const counts = [3, 2, 0, 9];
    let idx = 0;
    (scruffy as unknown as { dispatcher: { dispatchOnce(): Promise<number> } }).dispatcher = {
      async dispatchOnce(): Promise<number> {
        return counts[idx++] ?? 0;
      },
    };

    const total = await scruffy.flushEffects(100);
    expect(total).toBe(5); // 3 + 2, then a zero-pass ends the drain
    expect(idx).toBe(3); // did not consult the fourth count
  });
});
