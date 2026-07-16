import { describe, expect, it } from "vitest";
import { ModelAnalyzer } from "../../src/providers/analyzers/model-analyzer.js";
import { evaluatePoison } from "../../src/gates/poison/decision.js";
import { evaluateNightly } from "../../src/gates/nightly/decision.js";
import type { PoisonPolicy, NightlyPolicy } from "../../src/domain/policy/types.js";
import type { ChangedFile } from "../../src/providers/scm/port.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/providers/models/port.js";

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

describe("ModelAnalyzer", () => {
  it("emits a model-asserted finding anchored to the real added line", async () => {
    const findings = await new ModelAnalyzer(stub(validOutput, "claude-x")).analyze(SUBJECT, FILES);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.ruleId).toBe("MODEL.sql-injection");
    expect(f.defectClass).toBe("sql-injection");
    expect(f.primaryRegion).toMatchObject({ path: "src/db.ts", startLine: 2, endLine: 2 });
    // snippet comes from the actual diff line, not from anything the model claimed.
    expect(f.primaryRegion.snippet).toContain("SELECT * FROM users WHERE id");
    expect(f.provenance).toMatchObject({ analyzerId: "model-analyzer", modelId: "claude-x", promptVersion: "model-analyze-v1" });
    expect(f.validation).toBe("pending");
  });

  it("marks support as model-asserted, NEVER deterministic", async () => {
    const [f] = await new ModelAnalyzer(stub(validOutput)).analyze(SUBJECT, FILES);
    expect(f!.supporting.every((s) => s.trust === "model-asserted")).toBe(true);
    expect(f!.supporting.some((s) => s.trust === "deterministic")).toBe(false);
  });

  it("SAFETY: a model finding cannot block the poison gate even for a blockable class", async () => {
    const [f] = await new ModelAnalyzer(stub(validOutput)).analyze(SUBJECT, FILES);
    // Even if policy made this class blockable and did not require validation, a
    // model-asserted finding has no deterministic corroboration -> must abstain.
    const policy: PoisonPolicy = { blockableDefectClasses: ["sql-injection"], requireValidation: false };
    const decision = evaluatePoison([f!], policy);
    expect(decision.outcome).toBe("indeterminate");
    expect(decision.outcome).not.toBe("block");
  });

  it("feeds nightly: the same model finding surfaces as a report (never auto-fixed)", async () => {
    const [f] = await new ModelAnalyzer(stub(validOutput)).analyze(SUBJECT, FILES);
    const policy: NightlyPolicy = { reportableDefectClasses: ["sql-injection"], fixableDefectClasses: [] };
    const decision = evaluateNightly([f!], policy);
    expect(decision.dispositions[0]!.disposition).toBe("report");
    expect(decision.dispositions[0]!.reason).toBe("reportable_unvalidated");
    expect(decision.summary.proposedFixes).toBe(0);
  });

  it("drops a finding whose path/line is not a real added line (anti-hallucination)", async () => {
    const hallucinated = JSON.stringify([
      { class: "sql-injection", path: "src/db.ts", line: 99, reason: "made-up line" },
      { class: "command-injection", path: "src/nope.ts", line: 1, reason: "made-up file" },
    ]);
    expect(await new ModelAnalyzer(stub(hallucinated)).analyze(SUBJECT, FILES)).toEqual([]);
  });

  it("drops a finding whose class is outside the fixed vocabulary", async () => {
    const bad = JSON.stringify([{ class: "vibes-off", path: "src/db.ts", line: 2, reason: "feels wrong" }]);
    expect(await new ModelAnalyzer(stub(bad)).analyze(SUBJECT, FILES)).toEqual([]);
  });

  it("returns nothing for unparseable output, empty text, or a provider failure", async () => {
    expect(await new ModelAnalyzer(stub("not json at all")).analyze(SUBJECT, FILES)).toEqual([]);
    expect(await new ModelAnalyzer(stub("")).analyze(SUBJECT, FILES)).toEqual([]);
    expect(
      await new ModelAnalyzer(
        stub(() => {
          throw new Error("network down");
        }),
      ).analyze(SUBJECT, FILES),
    ).toEqual([]);
  });

  it("tolerates prose around the JSON array", async () => {
    const wrapped = "Here are the findings:\n" + validOutput + "\nThat's all.";
    expect(await new ModelAnalyzer(stub(wrapped)).analyze(SUBJECT, FILES)).toHaveLength(1);
  });

  it("emits nothing when there are no added lines to review", async () => {
    expect(await new ModelAnalyzer(stub(validOutput)).analyze(SUBJECT, [])).toEqual([]);
  });
});
