import type { Analyzer } from "./analyzers/port.js";
import type { EffectivePolicy } from "../domain/policy/types.js";
import type { Validator } from "../domain/validation/port.js";
import type { Fixer } from "./fixers/port.js";
import type { ModelProvider } from "./models/port.js";
import type { ReleaseRiskAnalyst } from "./release-risk/port.js";
import { SecretScanAnalyzer } from "./analyzers/secret-scan.js";
import { DestructiveMigrationAnalyzer } from "./analyzers/destructive-migration.js";
import { DisabledTlsAnalyzer } from "./analyzers/disabled-tls.js";
import { ModelAnalyzer, MODEL_DEFECT_CLASSES } from "./analyzers/model-analyzer.js";
import { ModelReleaseRiskAnalyst } from "./release-risk/model-release-risk.js";
import { SecretValidator } from "./validation/secret-validator.js";
import { MigrationValidator } from "./validation/migration-validator.js";
import { TlsValidator } from "./validation/tls-validator.js";
import { TlsFixer } from "./fixers/tls-fixer.js";
import { CompositeValidator } from "../domain/validation/composite.js";

/**
 * Single source of truth for the built-in deterministic analyzers, their
 * validators, and the defect classes the poison gate may block on. Harness,
 * corpus replay, and production wiring all build from here so they never drift.
 * Each blockable class MUST have a registered validator.
 */

export const POISON_BLOCKABLE_CLASSES = [
  "leaked-credential",
  "destructive-schema-change",
  "disabled-tls-verification",
] as const;

/**
 * Nightly reportable classes: the deterministic classes PLUS the model
 * analyzer's semantic vocabulary. Nightly re-reviews the day's range and surfaces
 * findings poison abstained on — including model-detected semantic defects. The
 * model classes are deliberately NOT in POISON_BLOCKABLE_CLASSES: a model finding
 * feeds nightly (report), never the fast blocking gate.
 */
export const NIGHTLY_REPORTABLE_CLASSES = [...POISON_BLOCKABLE_CLASSES, ...MODEL_DEFECT_CLASSES] as const;

/**
 * Subset eligible for an automated fix PR once validated + deterministically
 * supported. Kept narrow: a disabled TLS-verification flag is a mechanical,
 * low-ambiguity revert. A finding outside this list still earns a remediation
 * ATTEMPT — the nightly report records one for every surfaced finding — it just
 * has no deterministic fixer to serve it.
 */
export const NIGHTLY_FIXABLE_CLASSES = ["disabled-tls-verification"] as const;

/**
 * Release-gate class split, by REVERSIBILITY (see ReleasePolicy). A CONFIRMED
 * stop-class finding in the release range hard-stops publication; anything
 * serious-but-not-irreversible, or a stop-class finding we could not confirm,
 * escalates to human sign-off instead of shipping.
 *
 * `stop`: a leaked credential (the secret is burned) and silent data
 * loss/corruption (the data is gone) — no safe reading, no going back.
 * `sign-off`: disabled TLS verification (a serious regression, but a human may
 * accept it with context) plus every model-asserted semantic class (uncalibrated,
 * so it can never auto-stop — a human adjudicates). The lists are disjoint.
 */
export const RELEASE_STOP_CLASSES = ["leaked-credential", "destructive-schema-change"] as const;
export const RELEASE_SIGNOFF_CLASSES = ["disabled-tls-verification", ...MODEL_DEFECT_CLASSES] as const;

/**
 * Service-owned bounds on every proposed patch, deterministic or model-sourced.
 * Narrow on purpose: a nightly fix PR is a small, mechanical, low-ambiguity
 * change, never a repository-wide rewrite. Protected paths cover the gate's
 * own policy/prompt sources and common CI/lockfile surfaces a patch must never
 * touch regardless of what a finding or model claims.
 */
export const DEFAULT_REMEDIATION_POLICY = {
  maxFiles: 3,
  maxTotalLines: 60,
  maxTotalBytes: 4096,
  protectedPaths: [".github/", "src/domain/policy/", "src/providers/prompts/", "package-lock.json", "package.json"],
} as const;

/**
 * The exact GitHub check/status contexts a controlled candidate must pass for the
 * candidate-CI lane. Deliberately NON-Scruffy — the gate never depends on its own
 * `scruffy/release` context (that self-dependency is rejected at policy parsing).
 * These are the honest defaults for the controlled shadow repository; a real
 * deployment overrides them with the repo's actual required contexts.
 */
export const RELEASE_REQUIRED_CI_CONTEXTS = ["ci/build", "ci/test"] as const;

/**
 * Service-owned evidence-lane declarations for the default/shadow release policy.
 * Source analysis and candidate CI are REQUIRED — a controlled candidate cannot
 * ship without full deterministic review and every named CI context passing for the
 * exact SHA. The range-level LLM lane is applicable but not a ship precondition here
 * (a model backend is optional in the base wiring); when an analyst IS wired its
 * retained risks still force sign-off. Nothing is silently optional: every lane is
 * declared explicitly, and there is no permissive fallback.
 */
export const RELEASE_EVIDENCE_POLICY = {
  "source-analysis": { applicable: true, required: true },
  "release-risk-llm": { applicable: true, required: false },
  "candidate-ci": { applicable: true, required: true, requiredContexts: [...RELEASE_REQUIRED_CI_CONTEXTS] },
} as const;

/**
 * Evidence declarations for OFFLINE corpus replay: source analysis is still
 * required (the corpus scores real deterministic review), but the release-risk-llm
 * and candidate-CI lanes are EXPLICITLY not applicable — no `ReleaseRiskAnalyst` is
 * wired on the replay paths and there is no live GitHub to read CI from. Note this
 * is also used by the GROUNDED release lane, which does wire a line-level
 * `ModelAnalyzer`: that feeds source analysis, not the range-level release-risk
 * lane, so declaring release-risk-llm not-applicable stays accurate there. This is
 * an explicit, honest declaration, NOT a permissive fallback: the schema still
 * parses it and rejects contradictions.
 */
export function releaseOfflineEvidence() {
  return {
    "source-analysis": { applicable: true, required: true },
    "release-risk-llm": { applicable: false, required: false },
    "candidate-ci": { applicable: false, required: false, requiredContexts: [] as string[] },
  };
}

/**
 * Evidence declarations for the CONTROLLED CAMPAIGN corpus lane: all three lanes
 * are applicable AND required — the honest posture the controlled first shadow
 * integration demands. Campaign cases inject explicit fake LLM + candidate-CI
 * evidence for these lanes; this is NOT a permissive default, and it deliberately
 * does not mark any lane not-applicable to dodge coverage.
 */
export function releaseCampaignEvidence() {
  return {
    "source-analysis": { applicable: true, required: true },
    "release-risk-llm": { applicable: true, required: true },
    "candidate-ci": { applicable: true, required: true, requiredContexts: [...RELEASE_REQUIRED_CI_CONTEXTS] },
  };
}

/**
 * The production policy derived from the registry's class lists — the single
 * place the class↔gate bindings become an EffectivePolicy, so entrypoints
 * (server, scripts) cannot drift from each other. The harness keeps its own
 * copy in test fixtures on purpose (tests pin behavior, not this function).
 */
export function defaultPolicy(version = "policy-v1"): EffectivePolicy {
  return {
    version,
    poison: { blockableDefectClasses: [...POISON_BLOCKABLE_CLASSES], requireValidation: true },
    nightly: { reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES], fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES] },
    release: {
      stopDefectClasses: [...RELEASE_STOP_CLASSES],
      signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES],
      evidence: {
        "source-analysis": { ...RELEASE_EVIDENCE_POLICY["source-analysis"] },
        "release-risk-llm": { ...RELEASE_EVIDENCE_POLICY["release-risk-llm"] },
        "candidate-ci": {
          ...RELEASE_EVIDENCE_POLICY["candidate-ci"],
          requiredContexts: [...RELEASE_EVIDENCE_POLICY["candidate-ci"].requiredContexts],
        },
      },
    },
    remediation: {
      maxFiles: DEFAULT_REMEDIATION_POLICY.maxFiles,
      maxTotalLines: DEFAULT_REMEDIATION_POLICY.maxTotalLines,
      maxTotalBytes: DEFAULT_REMEDIATION_POLICY.maxTotalBytes,
      protectedPaths: [...DEFAULT_REMEDIATION_POLICY.protectedPaths],
    },
  };
}

export function defaultAnalyzers(): Analyzer[] {
  return [new SecretScanAnalyzer(), new DestructiveMigrationAnalyzer(), new DisabledTlsAnalyzer()];
}

/**
 * Model-backed analyzers, wired only when a model backend is configured. Kept
 * OUT of defaultAnalyzers so tests, corpus replay, and the deterministic
 * critical path never make a model call. Append to defaultAnalyzers() for a
 * model-enabled run: `[...defaultAnalyzers(), ...modelAnalyzers(model)]`.
 */
export function modelAnalyzers(model: ModelProvider): Analyzer[] {
  return [new ModelAnalyzer(model)];
}

/**
 * The range-level LLM release-risk analyst, wired only when a model backend is
 * configured. Deliberately SEPARATE from the line-level analyzers: it feeds the
 * release report's release-risk-llm lane (a change summary + cited, model-asserted
 * risks over the whole range), not the poison/nightly finding pipeline. Kept out
 * of the deterministic default so tests and corpus replay never make a model call.
 */
export function releaseRiskAnalyst(model: ModelProvider): ReleaseRiskAnalyst {
  return new ModelReleaseRiskAnalyst(model);
}

export function defaultValidator(): Validator {
  // Keyed over POISON_BLOCKABLE_CLASSES so a blockable class without a validator
  // is a compile error, not a runtime abstain on the fast blocking path.
  const byClass: Record<(typeof POISON_BLOCKABLE_CLASSES)[number], Validator> = {
    "leaked-credential": new SecretValidator(),
    "destructive-schema-change": new MigrationValidator(),
    "disabled-tls-verification": new TlsValidator(),
  };
  return new CompositeValidator(byClass);
}

/**
 * Fixers indexed by defect class, for nightly fix-PR generation. INVARIANT:
 * every class in NIGHTLY_FIXABLE_CLASSES must have a fixer here — a fixable class
 * with no fixer would always downgrade to report, defeating its own eligibility.
 */
export function defaultFixers(): Record<(typeof NIGHTLY_FIXABLE_CLASSES)[number], Fixer> {
  return {
    "disabled-tls-verification": new TlsFixer(),
  };
}
