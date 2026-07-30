import { z } from "zod";
import type { Finding } from "../../domain/evidence/types.js";
import { ModelFixProposal } from "../../domain/fixes/types.js";
import { jsonCandidates } from "../models/extract-json.js";
import { makeFence, untrustedPreamble } from "./untrusted.js";

/**
 * The LLM remediation-fixer prompt. Fired only for a surfaced, non-refuted
 * finding that has no registered deterministic fixer (see
 * `providers/registry.ts`'s `NIGHTLY_FIXABLE_CLASSES`). Asked for a MINIMAL,
 * bounded, structurally anchored patch — never a free-form diff.
 *
 * Trust discipline mirrors the poison validator: the model's output is
 * schema-parsed, never applied directly, and every edit is independently
 * re-anchored against real subject content by
 * `domain/fixes/proposal-validation.ts` before it can become eligible for a
 * PR. This prompt cannot grant itself that trust — it can only fail to
 * produce a coherent proposal.
 */

export const PROMPT_VERSION = "remediation-fix-v1";

/** The fence around untrusted repository content (finding + source files). */
export const FENCE = makeFence("untrusted_source");

/**
 * The remediation prompt. Exported as a VERSIONED ARTIFACT — see the digest
 * pin in `test/providers/remediation-prompt-contract.test.ts`. The security
 * paragraph is load-bearing: it is what stops a hostile source file from
 * dictating its own "fix".
 */
export const REMEDIATION_FIX_SYSTEM = [
  "You are Scruffy's nightly remediation assistant.",
  "A finding has been surfaced in a reviewed repository. Propose a MINIMAL, SAFE patch for it, or say none exists.",
  "",
  ...untrustedPreamble(FENCE, {
    content: "finding details and source file content",
    conclusion: "proposed edits",
    decoyExample: '"edits": []',
  }),
  "",
  'Respond with ONLY a JSON object, no prose: {"edits": [...]}.',
  "Each element of edits MUST have exactly these fields:",
  '  "path"             — one of the exact paths given in the untrusted source_files block.',
  '  "expectedOriginal" — the EXACT, verbatim substring of that path\'s given content you intend to replace. Never paraphrased, never guessed.',
  '  "replacement"       — the exact replacement text.',
  '  "rationale"         — a short explanation of why this edit is safe.',
  "Optionally include:",
  '  "startLine"/"endLine" — 1-based inclusive line numbers, ONLY to disambiguate when expectedOriginal is not unique in the file.',
  '  "uncertain": true      — set this when you are not fully confident the edit is correct.',
  "Keep edits minimal: touch as few files and as few lines as possible. Never edit a path not given in source_files.",
  'If no safe, coherent fix exists, respond with {"edits": []} — that is a real, complete answer, not a failure to try.',
].join("\n");

export interface RemediationSourceFile {
  path: string;
  content: string;
}

export interface RemediationPromptInput {
  finding: Finding;
  sources: readonly RemediationSourceFile[];
}

/** Every interpolated field is repository-derived, so every one is sanitized. */
export function buildRemediationInput(input: RemediationPromptInput): string {
  const clean = FENCE.sanitize.bind(FENCE);
  const files =
    input.sources
      .map((s) => [`--- path: ${clean(s.path)} ---`, clean(s.content)].join("\n"))
      .join("\n\n") || "(no source files available)";
  return FENCE.wrap([
    `finding_rule_id: ${clean(input.finding.ruleId)}`,
    `defect_class: ${clean(input.finding.defectClass)}`,
    `location: ${clean(input.finding.primaryRegion.path)}:${input.finding.primaryRegion.startLine}`,
    `snippet: ${clean(input.finding.primaryRegion.snippet)}`,
    "",
    "source_files:",
    files,
  ]);
}

export type RemediationParseResult =
  | { kind: "proposal"; proposal: ModelFixProposal }
  /** The model coherently asserted no fix exists ({"edits": []}) — a real answer, not a failure. */
  | { kind: "no_fix" }
  /** No well-formed edits object could be extracted from the reply. */
  | { kind: "unparseable" };

const RawProposal = z.object({ edits: z.array(z.unknown()) });

/**
 * Parses the model's reply into a proposal, an explicit "no fix" answer, or an
 * unparseable-output failure. Tolerates prose/markdown around the JSON object
 * (see `providers/models/extract-json.ts`) but never guesses at a malformed
 * edit — an edit that fails its own schema fails the whole proposal, since a
 * partially-applied patch is not a safe outcome.
 */
export function parseRemediationProposal(text: string): RemediationParseResult {
  for (const candidate of jsonCandidates(text, "{")) {
    const raw = RawProposal.safeParse(candidate);
    if (!raw.success) continue;
    if (raw.data.edits.length === 0) return { kind: "no_fix" };
    const parsed = ModelFixProposal.safeParse(candidate);
    if (parsed.success) return { kind: "proposal", proposal: parsed.data };
    // A shape that looks like a proposal (an `edits` array) but fails the
    // strict per-edit schema is a malformed proposal, not "no fix" — keep
    // scanning for a better candidate rather than silently downgrading.
  }
  return { kind: "unparseable" };
}
