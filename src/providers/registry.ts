import type { Analyzer } from "./analyzers/port.js";
import type { EffectivePolicy } from "../domain/policy/types.js";
import type { Validator } from "../domain/validation/port.js";
import type { Fixer } from "./fixers/port.js";
import type { ModelProvider } from "./models/port.js";
import { SecretScanAnalyzer } from "./analyzers/secret-scan.js";
import { DestructiveMigrationAnalyzer } from "./analyzers/destructive-migration.js";
import { DisabledTlsAnalyzer } from "./analyzers/disabled-tls.js";
import { ModelAnalyzer, MODEL_DEFECT_CLASSES } from "./analyzers/model-analyzer.js";
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
 * low-ambiguity revert. Fix *generation* is a later slice.
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
    release: { stopDefectClasses: [...RELEASE_STOP_CLASSES], signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES] },
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
