import type { Finding } from "../../domain/evidence/types.js";
import type { ProposedEdit } from "../../domain/fixes/types.js";
import type { RemediationPolicy } from "../../domain/policy/types.js";
import type { Fixer } from "../../providers/fixers/port.js";
import type { ModelProvider } from "../../providers/models/port.js";
import type { ScmReader } from "../../providers/scm/port.js";
import { findingKey } from "../../domain/findings/identity.js";
import {
  deterministicFixerProvenance,
  modelFixerProvenance,
  type RemediationProvenance,
} from "../../domain/findings/work-identity.js";
import { isProtectedPath, validateProposal } from "../../domain/fixes/proposal-validation.js";
import {
  PROMPT_VERSION as FIX_PROMPT_VERSION,
  REMEDIATION_FIX_SYSTEM,
  buildRemediationInput,
  parseRemediationProposal,
} from "../../providers/prompts/remediation-fix.js";
import {
  PROMPT_VERSION as CRITIC_PROMPT_VERSION,
  REMEDIATION_CRITIC_SYSTEM,
  buildCriticInput,
  parseCriticVerdict,
  type CriticVerdict,
} from "../../providers/prompts/remediation-critic.js";

/**
 * The remediation-attempt boundary: every deduplicated, surfaced, non-refuted
 * nightly finding earns ONE attempt here, regardless of whether its evidence
 * is deterministic or model-asserted. A registered deterministic fixer is
 * always preferred; the configured LLM remediation provider serves whatever
 * is left. See `providers/registry.ts`'s `NIGHTLY_FIXABLE_CLASSES` comment —
 * a finding outside that list still earns an attempt, it just has no
 * deterministic fixer to serve it.
 *
 * This module produces a RICHER classification than the persisted, coarse
 * `RemediationState` (`domain/findings/work-graph.ts`): ready-vs-draft-vs-
 * rejected-vs-unavailable, plus critic provenance. Brief 04 maps this into the
 * persisted `FixProposalRecord`/`RemediationRecord` and the delivery axis
 * (draft PR / ready PR / no PR). No PR is opened, and no repository command
 * runs, here — see ADR 0001 and this brief's constraints.
 */

export const REMEDIATION_OUTCOMES = ["ready", "draft", "rejected", "unavailable"] as const;
export type RemediationOutcome = (typeof REMEDIATION_OUTCOMES)[number];

/**
 * Stable reason codes — part of the audit contract, never free-form. Every
 * attempt, including a failed or unavailable one, carries exactly one of
 * these plus an optional free-text `detail` for humans.
 */
export const REMEDIATION_REASON_CODES = [
  /** A registered deterministic fixer produced a policy-compliant patch. */
  "deterministic_patch_ready",
  /** A deterministic fixer's patch violates service-owned policy (protected path/size). */
  "deterministic_patch_rejected",
  /** No source context could be read to anchor a model attempt. */
  "no_source_context",
  /** No registered deterministic fixer AND no model backend is configured. */
  "no_fixer_no_model",
  /** The model asserted no coherent fix exists ({"edits": []}) — a real answer. */
  "model_no_fix",
  /** The model's reply could not be parsed into a proposal. */
  "model_unparseable",
  /** The model provider threw (timeout, auth, transport). */
  "model_provider_failed",
  /** Structural/preimage/policy validation rejected the model's proposal. */
  "proposal_invalid",
  /** The independent patch critic confirmed the (already-anchored) patch. */
  "critic_confirmed",
  /** The critic could not decide either way. */
  "critic_indeterminate",
  /** The critic provider failed or its output could not be parsed. */
  "critic_unavailable",
  /** The critic found the patch does not fix the finding, or is unsafe. */
  "critic_refuted",
] as const;
export type RemediationReasonCode = (typeof REMEDIATION_REASON_CODES)[number];

export interface RemediationAttempt {
  findingKey: string;
  defectClass: string;
  subjectSha: string;
  outcome: RemediationOutcome;
  reasonCode: RemediationReasonCode;
  detail?: string;
  /** Null exactly when no fixer/model ever produced or attempted a patch. */
  provenance: RemediationProvenance | null;
  /** Present exactly when outcome is `ready` or `draft`. */
  edits: ProposedEdit[] | null;
  criticVerdict: CriticVerdict | null;
  criticReason: string | null;
}

export interface RemediationDeps {
  /** Deterministic fixers keyed by defect class (see `providers/registry.ts`). */
  fixers: Record<string, Fixer>;
  /** Absent = no LLM backend configured. A missing model never becomes "no fix needed". */
  model?: ModelProvider;
  scmReader: ScmReader;
  policy: RemediationPolicy;
}

function unavailable(
  finding: Finding,
  reasonCode: RemediationReasonCode,
  detail: string,
  provenance: RemediationProvenance | null,
): RemediationAttempt {
  return {
    findingKey: findingKey(finding),
    defectClass: finding.defectClass,
    subjectSha: finding.subject.commitSha,
    outcome: "unavailable",
    reasonCode,
    detail,
    provenance,
    edits: null,
    criticVerdict: null,
    criticReason: null,
  };
}

function rejected(
  finding: Finding,
  reasonCode: RemediationReasonCode,
  detail: string,
  provenance: RemediationProvenance,
  criticVerdict: CriticVerdict | null = null,
  criticReason: string | null = null,
): RemediationAttempt {
  return {
    findingKey: findingKey(finding),
    defectClass: finding.defectClass,
    subjectSha: finding.subject.commitSha,
    outcome: "rejected",
    reasonCode,
    detail,
    provenance,
    edits: null,
    criticVerdict,
    criticReason,
  };
}

/** Deterministic-fixer output is already service-trusted; still bound by policy. */
function rejectDeterministicEdit(edit: ProposedEdit, policy: RemediationPolicy): string | null {
  if (isProtectedPath(edit.path, policy.protectedPaths)) {
    return `path '${edit.path}' is protected by policy`;
  }
  const lines = edit.replacement.length === 0 ? 1 : edit.replacement.split("\n").length;
  if (lines > policy.maxTotalLines) {
    return `edit replaces ${lines} lines, policy allows ${policy.maxTotalLines}`;
  }
  const bytes = Buffer.byteLength(edit.replacement, "utf8");
  if (bytes > policy.maxTotalBytes) {
    return `edit replaces ${bytes} bytes, policy allows ${policy.maxTotalBytes}`;
  }
  return null;
}

/**
 * Attempt remediation for ONE surfaced, non-refuted finding. Pure orchestration
 * over injected deps — no wiring to the wider nightly service here (see
 * `attemptRemediations` for the batch driver used by `gates/nightly/service.ts`).
 */
export async function attemptRemediation(finding: Finding, deps: RemediationDeps): Promise<RemediationAttempt> {
  const deterministicFixer = deps.fixers[finding.defectClass];
  if (deterministicFixer) {
    const edit = deterministicFixer.propose(finding);
    if (edit) {
      const provenance = deterministicFixerProvenance(finding.defectClass);
      const violation = rejectDeterministicEdit(edit, deps.policy);
      if (violation) {
        return rejected(finding, "deterministic_patch_rejected", violation, provenance);
      }
      return {
        findingKey: findingKey(finding),
        defectClass: finding.defectClass,
        subjectSha: finding.subject.commitSha,
        outcome: "ready",
        reasonCode: "deterministic_patch_ready",
        provenance,
        edits: [edit],
        criticVerdict: null,
        criticReason: null,
      };
    }
    // Registered but declined (returned null): fall through to the LLM path
    // rather than reporting unavailable on a fixer that merely does not cover
    // this particular finding's shape.
  }

  if (!deps.model) {
    return unavailable(
      finding,
      "no_fixer_no_model",
      "no registered deterministic fixer for this defect class and no model backend configured",
      null,
    );
  }
  const model = deps.model;

  const region = finding.primaryRegion;
  const content = await deps.scmReader.getFileContent(finding.subject, region.path);
  if (!content.complete) {
    return unavailable(
      finding,
      "no_source_context",
      `could not read '${region.path}' at ${finding.subject.commitSha}: ${content.reason}${content.detail ? ` (${content.detail})` : ""}`,
      null,
    );
  }

  const fixInput = buildRemediationInput({ finding, sources: [{ path: region.path, content: content.content }] });
  let fixResponseText: string;
  let fixModelId: string;
  try {
    const response = await model.complete({ promptVersion: FIX_PROMPT_VERSION, system: REMEDIATION_FIX_SYSTEM, input: fixInput });
    fixResponseText = response.text;
    fixModelId = response.modelId;
  } catch (err) {
    return unavailable(
      finding,
      "model_provider_failed",
      `remediation model call failed: ${err instanceof Error ? err.message : String(err)}`,
      modelFixerProvenance({ fixerId: model.id, modelId: model.id, promptVersion: FIX_PROMPT_VERSION }),
    );
  }

  const provenance = modelFixerProvenance({ fixerId: model.id, modelId: fixModelId, promptVersion: FIX_PROMPT_VERSION });
  const parsed = parseRemediationProposal(fixResponseText);
  if (parsed.kind === "no_fix") {
    return unavailable(finding, "model_no_fix", "model asserted no safe fix exists for this finding", provenance);
  }
  if (parsed.kind === "unparseable") {
    return unavailable(finding, "model_unparseable", "model reply did not parse into a coherent fix proposal", provenance);
  }

  const validation = validateProposal({
    proposal: parsed.proposal,
    subjectSha: finding.subject.commitSha,
    sources: [{ path: region.path, content: content.content, subjectSha: finding.subject.commitSha }],
    policy: deps.policy,
  });
  if (!validation.ok) {
    return rejected(finding, "proposal_invalid", `${validation.reason}: ${validation.detail}`, provenance);
  }

  const criticInput = buildCriticInput({ finding, edits: validation.edits });
  let criticText: string;
  try {
    const criticResponse = await model.complete({
      promptVersion: CRITIC_PROMPT_VERSION,
      system: REMEDIATION_CRITIC_SYSTEM,
      input: criticInput,
    });
    criticText = criticResponse.text;
  } catch (err) {
    return {
      findingKey: findingKey(finding),
      defectClass: finding.defectClass,
      subjectSha: finding.subject.commitSha,
      outcome: "draft",
      reasonCode: "critic_unavailable",
      detail: `critic model call failed: ${err instanceof Error ? err.message : String(err)}`,
      provenance,
      edits: validation.edits,
      criticVerdict: null,
      criticReason: null,
    };
  }

  const criticParsed = parseCriticVerdict(criticText);
  if (criticParsed.kind === "unparseable") {
    return {
      findingKey: findingKey(finding),
      defectClass: finding.defectClass,
      subjectSha: finding.subject.commitSha,
      outcome: "draft",
      reasonCode: "critic_unavailable",
      detail: "critic reply did not parse into a verdict",
      provenance,
      edits: validation.edits,
      criticVerdict: null,
      criticReason: null,
    };
  }

  if (criticParsed.verdict === "refuted") {
    return rejected(finding, "critic_refuted", criticParsed.reason, provenance, criticParsed.verdict, criticParsed.reason);
  }
  if (criticParsed.verdict === "indeterminate") {
    return {
      findingKey: findingKey(finding),
      defectClass: finding.defectClass,
      subjectSha: finding.subject.commitSha,
      outcome: "draft",
      reasonCode: "critic_indeterminate",
      detail: criticParsed.reason,
      provenance,
      edits: validation.edits,
      criticVerdict: criticParsed.verdict,
      criticReason: criticParsed.reason,
    };
  }

  return {
    findingKey: findingKey(finding),
    defectClass: finding.defectClass,
    subjectSha: finding.subject.commitSha,
    outcome: "ready",
    reasonCode: "critic_confirmed",
    detail: criticParsed.reason,
    provenance,
    edits: validation.edits,
    criticVerdict: criticParsed.verdict,
    criticReason: criticParsed.reason,
  };
}

/**
 * Batch driver: attempts remediation for every given finding and returns a map
 * keyed by finding identity. Findings are attempted independently — one
 * provider failure does not abort the batch (mirrors `getFileContent`'s
 * per-path failure isolation).
 */
export async function attemptRemediations(
  findings: readonly Finding[],
  deps: RemediationDeps,
): Promise<Map<string, RemediationAttempt>> {
  const results = new Map<string, RemediationAttempt>();
  for (const finding of findings) {
    const attempt = await attemptRemediation(finding, deps);
    results.set(attempt.findingKey, attempt);
  }
  return results;
}
