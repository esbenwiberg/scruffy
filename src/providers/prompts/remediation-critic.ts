import { z } from "zod";
import type { Finding } from "../../domain/evidence/types.js";
import type { ProposedEdit } from "../../domain/fixes/types.js";
import { jsonCandidates } from "../models/extract-json.js";
import { makeFence, untrustedPreamble } from "./untrusted.js";

/**
 * The patch-critic (falsification) prompt. Runs AFTER a proposal has already
 * passed structural/preimage/policy validation. Its job is narrow: try to
 * find a reason the already-anchored patch is wrong, incomplete, or
 * dangerous. It is independent evidence toward ready-vs-draft classification
 * — it can never itself grant release authority, close a finding, or weaken
 * policy (see `gates/nightly/remediation.ts`, which treats a "confirmed"
 * verdict as necessary but not sufficient for "ready").
 */

export const PROMPT_VERSION = "remediation-critic-v1";

/** The fence around the untrusted finding + already-anchored patch content. */
export const FENCE = makeFence("untrusted_patch");

export const CRITIC_VERDICTS = ["confirmed", "refuted", "indeterminate"] as const;
export type CriticVerdict = (typeof CRITIC_VERDICTS)[number];

/**
 * The critic prompt. Exported as a VERSIONED ARTIFACT — see the digest pin in
 * `test/providers/remediation-prompt-contract.test.ts`.
 */
export const REMEDIATION_CRITIC_SYSTEM = [
  "You are Scruffy's nightly remediation critic.",
  "A patch has already been structurally validated: every edit's original text was matched exactly against the real reviewed source. Your job is to judge whether the patch actually, semantically fixes the finding, without introducing an obvious new defect.",
  "",
  ...untrustedPreamble(FENCE, {
    content: "the finding and the proposed before/after edits",
    conclusion: "your verdict",
    decoyExample: '"verdict": "indeterminate"',
  }),
  "",
  'Respond with ONLY a JSON object, no prose: {"verdict": "confirmed" | "refuted" | "indeterminate", "reason": "..."}.',
  '  "confirmed"     — you are confident the patch fixes the finding and introduces no new obvious defect.',
  '  "refuted"        — you are confident the patch does NOT fix the finding, or introduces a clear new defect.',
  '  "indeterminate"  — you cannot tell either way from the given context.',
  "You cannot approve merges, change policy, or mark a finding resolved — your verdict is only one input to a review humans still perform.",
  "If you are unsure, say so with \"indeterminate\" rather than guessing at \"confirmed\".",
].join("\n");

export interface RemediationCriticInput {
  finding: Finding;
  edits: readonly ProposedEdit[];
}

/** Every interpolated field is repository- or model-derived, so every one is sanitized. */
export function buildCriticInput(input: RemediationCriticInput): string {
  const clean = FENCE.sanitize.bind(FENCE);
  const edits =
    input.edits
      .map((e, i) =>
        [
          `--- edit ${i + 1}: ${clean(e.path)} (lines ${e.startLine}-${e.endLine}) ---`,
          `replacement: ${clean(e.replacement)}`,
          `rationale: ${clean(e.rationale)}`,
        ].join("\n"),
      )
      .join("\n\n") || "(no edits)";
  return FENCE.wrap([
    `finding_rule_id: ${clean(input.finding.ruleId)}`,
    `defect_class: ${clean(input.finding.defectClass)}`,
    `location: ${clean(input.finding.primaryRegion.path)}:${input.finding.primaryRegion.startLine}`,
    "",
    "proposed_edits:",
    edits,
  ]);
}

export type CriticParseResult =
  | { kind: "verdict"; verdict: CriticVerdict; reason: string }
  | { kind: "unparseable" };

const Verdict = z.object({
  verdict: z.enum(CRITIC_VERDICTS),
  reason: z.string(),
});

/**
 * Parses the critic's reply. Any provider throw or unparseable output must be
 * treated as `unparseable` by the caller and mapped to `indeterminate` for
 * classification purposes — never silently upgraded to `confirmed`.
 */
export function parseCriticVerdict(text: string): CriticParseResult {
  for (const candidate of jsonCandidates(text, "{")) {
    const parsed = Verdict.safeParse(candidate);
    if (parsed.success) return { kind: "verdict", verdict: parsed.data.verdict, reason: parsed.data.reason };
  }
  return { kind: "unparseable" };
}
