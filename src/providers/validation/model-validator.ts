import { z } from "zod";
import type { Validator } from "../../domain/validation/port.js";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";
import type { ModelProvider } from "../models/port.js";
import { jsonCandidates } from "../models/extract-json.js";
import { makeFence, untrustedPreamble } from "../prompts/untrusted.js";

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

export const PROMPT_VERSION = "poison-validate-v1";

/** The fence around untrusted repository content. See providers/prompts/untrusted.ts. */
export const FENCE = makeFence("untrusted_evidence");

/**
 * The critic prompt. Exported as a VERSIONED ARTIFACT — see the digest pin in
 * `prompt-contract.test.ts`. The security paragraph is load-bearing, not
 * decoration: it is what stops a hostile diff from dictating its own verdict.
 */
export const POISON_VALIDATE_SYSTEM = [
  "You are an adversarial security reviewer for an automated code-review gate.",
  "A deterministic analyzer has flagged a candidate defect in a code change.",
  "Your job is to try to REFUTE it using the evidence provided — decide whether it is a genuine, harmful defect or a false positive.",
  "",
  ...untrustedPreamble(FENCE, { content: "candidate", conclusion: "verdict", decoyExample: '"verdict: refuted"' }),
  "",
  'Respond with ONLY a JSON object, no prose: {"verdict": "...", "reason": "..."}.',
  "verdict must be one of:",
  '  "validated"     — you independently confirm this is a real, harmful/exploitable defect being introduced.',
  '  "refuted"       — this is a false positive (e.g. a placeholder, example, test fixture, or otherwise not a real defect).',
  '  "indeterminate" — the evidence is insufficient to decide. Default to this when unsure; do NOT guess "validated".',
].join("\n");

/** The only verdicts the model may return. The prompt must offer exactly these. */
export const MODEL_VERDICTS = ["validated", "refuted", "indeterminate"] as const;

const Verdict = z.object({
  verdict: z.enum(MODEL_VERDICTS),
  reason: z.string(),
});

export function buildInput(finding: Finding): string {
  const clean = FENCE.sanitize.bind(FENCE);
  const support = finding.supporting.map((s) => `- (${s.trust}) ${clean(s.statement)}`).join("\n") || "- none";
  // EVERY interpolated field is repository-derived, so every one is sanitized —
  // not just the snippet. A rule id or path can carry a fence marker too.
  return FENCE.wrap([
    `defect_class: ${clean(finding.defectClass)}`,
    `rule_id: ${clean(finding.ruleId)}`,
    `file: ${clean(finding.primaryRegion.path)}:${finding.primaryRegion.startLine}`,
    `introduced_line: ${clean(finding.primaryRegion.snippet)}`,
    `supporting_evidence:\n${support}`,
  ]);
}

/**
 * First JSON object in the reply that is a well-formed verdict, tolerating prose
 * and markdown fences around it (see providers/models/extract-json.ts). Also
 * survives an enveloped reply — `{"result": {"verdict": …}}` fails the schema at
 * the outer object and matches at the inner one.
 *
 * `null` means unusable output, which the caller turns into `failed` — abstain,
 * never a fabricated verdict.
 */
function parseVerdict(text: string): z.infer<typeof Verdict> | null {
  for (const candidate of jsonCandidates(text, "{")) {
    const parsed = Verdict.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export class ModelValidator implements Validator {
  readonly id = "model-validator";

  constructor(private readonly model: ModelProvider) {}

  async validate(finding: Finding): Promise<ValidationOutcome> {
    let text: string;
    try {
      const response = await this.model.complete({
        promptVersion: PROMPT_VERSION,
        system: POISON_VALIDATE_SYSTEM,
        input: buildInput(finding),
      });
      text = response.text;
    } catch {
      return "failed"; // provider/network failure — abstain, never validated
    }

    const parsed = parseVerdict(text);
    if (parsed === null) return "failed"; // unparseable output — abstain
    return parsed.verdict;
  }
}
