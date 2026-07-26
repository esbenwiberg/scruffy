import { describe, expect, it } from "vitest";
import { ModelAnalyzer } from "../../src/providers/analyzers/model-analyzer.js";
import { evaluatePoison } from "../../src/gates/poison/decision.js";
import { evaluateNightly } from "../../src/gates/nightly/decision.js";
import type { PoisonPolicy, NightlyPolicy } from "../../src/domain/policy/types.js";
import type { ChangedFile } from "../../src/providers/scm/port.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/providers/models/port.js";
import { COMPLETE_COVERAGE } from "../../src/domain/evidence/coverage.js";

const SUBJECT = { repository: "acme/web", commitSha: "a".repeat(40) };

function newFile(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

const FILES: ChangedFile[] = [
  {
    path: "src/db.ts",
    patch: newFile([
      "export function getUser(id: string) {",
      "  return db.query('SELECT * FROM users WHERE id = ' + id);",
      "}",
    ]),
  },
];

/** Stub model returning fixed text, or throwing, to exercise every path. */
function stub(behavior: string | (() => never), modelId = "stub-model"): ModelProvider {
  return {
    id: "stub",
    async complete(_req: ModelRequest): Promise<ModelResponse> {
      if (typeof behavior === "function") behavior();
      return { modelId, text: behavior as string };
    },
  };
}

const validOutput = JSON.stringify([
  { class: "sql-injection", path: "src/db.ts", line: 2, reason: "string-concatenated user id into SQL" },
]);

/** Findings only, asserting the run had FULL coverage — the common case. */
async function analyzed(model: ModelProvider, files: ChangedFile[] = FILES) {
  const result = await new ModelAnalyzer(model).analyze(SUBJECT, files);
  expect(result.gaps, "expected a fully-covered review").toEqual([]);
  return result.findings;
}

describe("ModelAnalyzer", () => {
  it("emits a model-asserted finding anchored to the real added line", async () => {
    const findings = await analyzed(stub(validOutput, "claude-x"));
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.ruleId).toBe("MODEL.sql-injection");
    expect(f.defectClass).toBe("sql-injection");
    expect(f.primaryRegion).toMatchObject({ path: "src/db.ts", startLine: 2, endLine: 2 });
    // snippet comes from the actual diff line, not from anything the model claimed.
    expect(f.primaryRegion.snippet).toContain("SELECT * FROM users WHERE id");
    expect(f.provenance).toMatchObject({ analyzerId: "model-analyzer", modelId: "claude-x", promptVersion: "model-analyze-v2" });
    expect(f.validation).toBe("pending");
  });

  it("marks support as model-asserted, NEVER deterministic", async () => {
    const [f] = await analyzed(stub(validOutput));
    expect(f!.supporting.every((s) => s.trust === "model-asserted")).toBe(true);
    expect(f!.supporting.some((s) => s.trust === "deterministic")).toBe(false);
  });

  it("SAFETY: a model finding cannot block the poison gate even for a blockable class", async () => {
    const [f] = await analyzed(stub(validOutput));
    // Even if policy made this class blockable and did not require validation, a
    // model-asserted finding has no deterministic corroboration -> must abstain.
    const policy: PoisonPolicy = { blockableDefectClasses: ["sql-injection"], requireValidation: false };
    const decision = evaluatePoison([f!], policy, COMPLETE_COVERAGE);
    expect(decision.outcome).toBe("indeterminate");
    expect(decision.outcome).not.toBe("block");
  });

  it("feeds nightly: the same model finding surfaces as a report (never auto-fixed)", async () => {
    const [f] = await analyzed(stub(validOutput));
    const policy: NightlyPolicy = { reportableDefectClasses: ["sql-injection"], fixableDefectClasses: [] };
    const decision = evaluateNightly([f!], policy, COMPLETE_COVERAGE);
    expect(decision.dispositions[0]!.disposition).toBe("report");
    expect(decision.dispositions[0]!.reason).toBe("reportable_unvalidated");
    expect(decision.summary.proposedFixes).toBe(0);
  });

  it("drops a finding whose path/line is not a real added line (anti-hallucination)", async () => {
    const hallucinated = JSON.stringify([
      { class: "sql-injection", path: "src/db.ts", line: 99, reason: "made-up line" },
      { class: "command-injection", path: "src/nope.ts", line: 1, reason: "made-up file" },
    ]);
    expect(await analyzed(stub(hallucinated))).toEqual([]);
  });

  it("drops a finding whose class is outside the fixed vocabulary", async () => {
    const bad = JSON.stringify([{ class: "vibes-off", path: "src/db.ts", line: 2, reason: "feels wrong" }]);
    expect(await analyzed(stub(bad))).toEqual([]);
  });

  // COVERAGE — the difference between "reviewed it, clean" and "could not review".
  // Both return zero findings; only the gap tells them apart, and without it a
  // model outage renders as a clean bill of health.
  it("reports a coverage gap (not a clean review) when the provider fails", async () => {
    const result = await new ModelAnalyzer(
      stub(() => {
        throw new Error("network down");
      }),
    ).analyze(SUBJECT, FILES);
    expect(result.findings).toEqual([]);
    expect(result.gaps).toEqual([
      { analyzerId: "model-analyzer", code: "provider_unavailable", detail: "network down" },
    ]);
  });

  it("reports a coverage gap when the output cannot be parsed", async () => {
    const result = await new ModelAnalyzer(stub("not json at all")).analyze(SUBJECT, FILES);
    expect(result.findings).toEqual([]);
    expect(result.gaps.map((g) => g.code)).toEqual(["unparseable_output"]);
  });

  it("reports a coverage gap for empty text — a silent backend is not a clean review", async () => {
    // The fake model returns "" for an unkeyed promptVersion. Before coverage this
    // was the single most dangerous default in the system: a misconfigured fake
    // reported every change as clean.
    const result = await new ModelAnalyzer(stub("")).analyze(SUBJECT, FILES);
    expect(result.findings).toEqual([]);
    expect(result.gaps.map((g) => g.code)).toEqual(["unparseable_output"]);
  });

  it("reports NO gap when the model genuinely reviewed the change and found nothing", async () => {
    const result = await new ModelAnalyzer(stub("[]")).analyze(SUBJECT, FILES);
    expect(result.findings).toEqual([]);
    expect(result.gaps, "an empty array is a positive claim of cleanliness").toEqual([]);
  });

  it("reports an input_truncated gap when the diff exceeds the prompt bound", async () => {
    const huge = [{ path: "src/big.ts", patch: newFile(Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`)) }];
    const result = await new ModelAnalyzer(stub("[]")).analyze(SUBJECT, huge);
    expect(result.gaps.map((g) => g.code)).toEqual(["input_truncated"]);
  });

  it("reports an output_capped gap when the model floods past MAX_FINDINGS", async () => {
    // Padding the response is a real suppression vector: bury the true finding
    // past the cap. Capping is right; capping SILENTLY is not.
    const lines = Array.from({ length: 40 }, (_, i) => `db.query('SELECT ' + x${i});`);
    const files = [{ path: "src/db.ts", patch: newFile(lines) }];
    const flood = JSON.stringify(
      lines.map((_, i) => ({ class: "sql-injection", path: "src/db.ts", line: i + 1, reason: `r${i}` })),
    );
    const result = await new ModelAnalyzer(stub(flood)).analyze(SUBJECT, files);
    expect(result.findings).toHaveLength(25);
    expect(result.gaps.map((g) => g.code)).toEqual(["output_capped"]);
  });

  it("tolerates prose around the JSON array", async () => {
    const wrapped = "Here are the findings:\n" + validOutput + "\nThat's all.";
    expect(await analyzed(stub(wrapped))).toHaveLength(1);
  });

  it("tolerates a bracket in the prose BEFORE the array", async () => {
    // First-bracket-to-last-bracket would start the slice at "[the added lines]"
    // and parse nothing — a model that explains itself would blind the gate.
    const chatty = `I reviewed [the added lines] and found:\n${validOutput}\nNothing else [of note].`;
    expect(await analyzed(stub(chatty))).toHaveLength(1);
  });

  // INPUT BUDGET — the prompt bound is shared across files, not spent
  // first-come-first-served.
  it("still reviews a later file when an earlier one is huge", async () => {
    // The blind spot this closes: prepend 400 lines of noise and everything after
    // it went unreviewed, with the attacker choosing the ordering.
    const noise = { path: "src/noise.ts", patch: newFile(Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`)) };
    const payload = { path: "src/db.ts", patch: newFile(["db.query('SELECT * FROM t WHERE id = ' + id);"]) };
    const model = stub(
      JSON.stringify([{ class: "sql-injection", path: "src/db.ts", line: 1, reason: "concatenated id" }]),
    );

    const result = await new ModelAnalyzer(model).analyze(SUBJECT, [noise, payload]);

    // Anchoring proves the payload file actually reached the prompt: a finding on
    // a file that was never indexed is dropped as hallucinated.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.primaryRegion.path).toBe("src/db.ts");
    // The noise file is still partially unread, and that is still reported.
    expect(result.gaps.map((g) => g.code)).toEqual(["input_truncated"]);
    expect(result.gaps[0]!.detail).toMatch(/reviewed 300 of 401 added lines/);
  });

  it("shows a small file in full rather than giving it a flat share", async () => {
    const files = [
      { path: "src/a.ts", patch: newFile(Array.from({ length: 500 }, (_, i) => `a${i}`)) },
      { path: "src/b.ts", patch: newFile(["b0", "b1"]) },
      { path: "src/c.ts", patch: newFile(Array.from({ length: 500 }, (_, i) => `c${i}`)) },
    ];
    // b is tiny, so it is shown whole and hands its unused share back to a and c.
    const onEachFile = JSON.stringify([
      { class: "sql-injection", path: "src/a.ts", line: 1, reason: "x" },
      { class: "sql-injection", path: "src/b.ts", line: 2, reason: "x" },
      { class: "sql-injection", path: "src/c.ts", line: 1, reason: "x" },
    ]);
    const result = await new ModelAnalyzer(stub(onEachFile)).analyze(SUBJECT, files);
    expect(result.findings.map((f) => f.primaryRegion.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("counts files it could not show AT ALL when they outnumber the budget", async () => {
    // 400 one-line files against a 300-line budget: 300 get a line, 100 get none.
    const many = Array.from({ length: 400 }, (_, i) => ({ path: `src/f${i}.ts`, patch: newFile([`const x = ${i};`]) }));
    const result = await new ModelAnalyzer(stub("[]")).analyze(SUBJECT, many);
    expect(result.gaps.map((g) => g.code)).toEqual(["input_truncated"]);
    expect(result.gaps[0]!.detail).toMatch(/reviewed 300 of 400 added lines.*100 file\(s\) not shown at all/);
  });

  it("collapses repeated findings BEFORE the cap, so padding cannot bury a real one", async () => {
    // The suppression vector: restate one trivial defect 30 times and the real
    // finding falls past MAX_FINDINGS. Repeats are the model's own restatement,
    // not independent evidence, so dropping them costs nothing.
    const lines = ["db.query('SELECT ' + a);", "db.query('SELECT ' + b);"];
    const files = [{ path: "src/db.ts", patch: newFile(lines) }];
    const padded = JSON.stringify([
      ...Array.from({ length: 30 }, (_, i) => ({ class: "sql-injection", path: "src/db.ts", line: 1, reason: `restated ${i}` })),
      { class: "sql-injection", path: "src/db.ts", line: 2, reason: "the one that matters" },
    ]);

    const result = await new ModelAnalyzer(stub(padded)).analyze(SUBJECT, files);

    expect(result.findings.map((f) => f.primaryRegion.startLine)).toEqual([1, 2]);
    expect(result.gaps, "nothing was actually dropped, so nothing to report").toEqual([]);
  });

  it("emits nothing when there are no added lines to review", async () => {
    expect(await analyzed(stub(validOutput), [])).toEqual([]);
  });
});
