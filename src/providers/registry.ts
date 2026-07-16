import type { Analyzer } from "./analyzers/port.js";
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
  return new CompositeValidator({
    "leaked-credential": new SecretValidator(),
    "destructive-schema-change": new MigrationValidator(),
    "disabled-tls-verification": new TlsValidator(),
  });
}

/**
 * Fixers indexed by defect class, for nightly fix-PR generation. INVARIANT:
 * every class in NIGHTLY_FIXABLE_CLASSES must have a fixer here — a fixable class
 * with no fixer would always downgrade to report, defeating its own eligibility.
 */
export function defaultFixers(): Record<string, Fixer> {
  return {
    "disabled-tls-verification": new TlsFixer(),
  };
}
