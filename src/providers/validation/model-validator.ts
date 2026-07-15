import { z } from "zod";
import type { Validator } from "../../domain/validation/port.js";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";
import type { ModelProvider } from "../models/port.js";

/**
 * Model-backed adversarial validator — the heritage doc's "critic", firing a
 * real LLM. It is asked to REFUTE a candidate finding, and its verdict maps to
 * the validation lifecycle.
 *
 * Safety semantics (unchanged from the deterministic validators):
 *  - the model can only return validated / refuted / indeterminate; even a
 *    `validated` still requires deterministic supporting evidence for the poison
 *    kernel to block, so the model cannot manufacture a block on its own;
 *  - any failure to reach the model, or output that doesn't parse, becomes
 *    `failed` — never a fabricated `validated`. Infra failure => the gate
 *    abstains.
 *
 * Off the deterministic critical path: tests, harness, and corpus use the
 * deterministic validators; this runs only when a model backend is wired in.
 */

const PROMPT_VERSION = "poison-validate-v1";

const SYSTEM = [
  "You are an adversarial security reviewer for an automated code-review gate.",
  "A deterministic analyzer has flagged a candidate defect in a code change.",
  "Your job is to try to REFUTE it using the evidence provided — decide whether it is a genuine, harmful defect or a false positive.",
  "",
  'Respond with ONLY a JSON object, no prose: {"verdict": "...", "reason": "..."}.',
  "verdict must be one of:",
  '  "validated"     — you independently confirm this is a real, harmful/exploitable defect being introduced.',
  '  "refuted"       — this is a false positive (e.g. a placeholder, example, test fixture, or otherwise not a real defect).',
  '  "indeterminate" — the evidence is insufficient to decide. Default to this when unsure; do NOT guess "validated".',
].join("\n");

const Verdict = z.object({
  verdict: z.enum(["validated", "refuted", "indeterminate"]),
  reason: z.string(),
});

function buildInput(finding: Finding): string {
  const support = finding.supporting.map((s) => `- (${s.trust}) ${s.statement}`).join("\n") || "- none";
  return [
    `defect_class: ${finding.defectClass}`,
    `rule_id: ${finding.ruleId}`,
    `file: ${finding.primaryRegion.path}:${finding.primaryRegion.startLine}`,
    `introduced_line: ${finding.primaryRegion.snippet}`,
    `supporting_evidence:\n${support}`,
  ].join("\n");
}

/** Pull the first JSON object out of the model text, tolerating minor prose. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class ModelValidator implements Validator {
  readonly id = "model-validator";

  constructor(private readonly model: ModelProvider) {}

  async validate(finding: Finding): Promise<ValidationOutcome> {
    let text: string;
    try {
      const response = await this.model.complete({
        promptVersion: PROMPT_VERSION,
        system: SYSTEM,
        input: buildInput(finding),
      });
      text = response.text;
    } catch {
      return "failed"; // provider/network failure — abstain, never validated
    }

    const parsed = Verdict.safeParse(extractJson(text));
    if (!parsed.success) return "failed"; // unparseable output — abstain
    return parsed.data.verdict;
  }
}
