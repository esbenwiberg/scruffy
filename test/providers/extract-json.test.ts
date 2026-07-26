import { describe, expect, it } from "vitest";
import { jsonCandidates } from "../../src/providers/models/extract-json.js";

/**
 * The extractor replaces the naive first-bracket-to-last-bracket slice. These
 * tests pin the cases that slice got wrong, and — just as importantly — the ones
 * where being MORE tolerant must not turn junk into a finding array. On a review
 * gate, extraction failing means "could not review"; extraction succeeding on
 * garbage would mean "reviewed, clean". The second is the dangerous direction.
 */

describe("jsonCandidates", () => {
  it("finds the array when prose before it contains a bracket", () => {
    // The naive slice starts at the prose bracket and parses nothing, turning a
    // perfectly good review into a coverage gap.
    const text = 'Checked the list [see notes] and found: [{"class":"x"}] — done.';
    expect(jsonCandidates(text, "[")).toContainEqual([{ class: "x" }]);
  });

  it("finds the array when prose after it contains a closing bracket", () => {
    const text = '[{"class":"x"}]\n\nSee the diff [above] for context.';
    expect(jsonCandidates(text, "[")[0]).toEqual([{ class: "x" }]);
  });

  it("survives a markdown code fence", () => {
    const text = 'Findings:\n```json\n[{"class":"x"}]\n```\n';
    expect(jsonCandidates(text, "[")[0]).toEqual([{ class: "x" }]);
  });

  it("does not let a bracket INSIDE a string terminate the value", () => {
    const text = '[{"reason":"array index a[0] is unchecked ]] }"}]';
    expect(jsonCandidates(text, "[")[0]).toEqual([{ reason: "array index a[0] is unchecked ]] }" }]);
  });

  it("handles an escaped quote inside a string", () => {
    const text = String.raw`[{"reason":"the \" here must not end the string ]"}]`;
    expect(jsonCandidates(text, "[")[0]).toEqual([{ reason: 'the " here must not end the string ]' }]);
  });

  it("treats a trailing backslash as escaped, not as an escape", () => {
    // `"a\\"` is the two-char string `a\` and the final quote DOES close it. Get
    // this wrong and every value after it is read as string content.
    const text = String.raw`[{"reason":"a\\"},{"reason":"b"}]`;
    expect(jsonCandidates(text, "[")[0]).toEqual([{ reason: "a\\" }, { reason: "b" }]);
  });

  it("yields outermost first, then nested — so a caller can fall back inward", () => {
    const candidates = jsonCandidates('{"result":{"verdict":"refuted"}}', "{");
    expect(candidates[0]).toEqual({ result: { verdict: "refuted" } });
    expect(candidates[1]).toEqual({ verdict: "refuted" });
  });

  it("yields an earlier non-matching array AND the real one, in order", () => {
    // The caller picks the first that satisfies its schema; the extractor must
    // not decide for it.
    const candidates = jsonCandidates('scores [1,2,3] then [{"class":"x"}]', "[");
    expect(candidates).toEqual([[1, 2, 3], [{ class: "x" }]]);
  });

  it("returns nothing for an unterminated array — a truncated reply is NOT a clean review", () => {
    expect(jsonCandidates('[{"class":"sql-inj', "[")).toEqual([]);
  });

  it("returns nothing when the brackets are mismatched", () => {
    expect(jsonCandidates('[{"a":1]}', "[")).toEqual([]);
  });

  it("returns nothing for prose with no JSON in it", () => {
    expect(jsonCandidates("I could not review this change.", "[")).toEqual([]);
    expect(jsonCandidates("", "[")).toEqual([]);
  });

  it("recognises the empty array — the model's positive claim of cleanliness", () => {
    expect(jsonCandidates("No defects. []", "[")).toEqual([[]]);
  });

  it("stays bounded on pathological nesting rather than scanning forever", () => {
    // 50k unclosed brackets yield NO candidates, so a cap on parsed candidates
    // alone does not stop the walk — each start rescans the tail, and the scan
    // goes quadratic. This is a free CPU burn for anyone who can influence model
    // output, so the cap has to be on brackets EXAMINED. The wall-clock bound is
    // the assertion: without it this takes ~2s, with it ~10ms.
    const started = performance.now();
    expect(jsonCandidates("[".repeat(50_000), "[")).toEqual([]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("stays bounded when every candidate parses", () => {
    const nested = "[".repeat(200) + "]".repeat(200);
    expect(jsonCandidates(nested, "[").length).toBeLessThanOrEqual(32);
  });
});
