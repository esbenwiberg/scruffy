import type { Analyzer } from "./analyzers/port.js";
import type { Validator } from "../domain/validation/port.js";
import { SecretScanAnalyzer } from "./analyzers/secret-scan.js";
import { DestructiveMigrationAnalyzer } from "./analyzers/destructive-migration.js";
import { DisabledTlsAnalyzer } from "./analyzers/disabled-tls.js";
import { SecretValidator } from "./validation/secret-validator.js";
import { MigrationValidator } from "./validation/migration-validator.js";
import { TlsValidator } from "./validation/tls-validator.js";
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

export function defaultAnalyzers(): Analyzer[] {
  return [new SecretScanAnalyzer(), new DestructiveMigrationAnalyzer(), new DisabledTlsAnalyzer()];
}

export function defaultValidator(): Validator {
  return new CompositeValidator({
    "leaked-credential": new SecretValidator(),
    "destructive-schema-change": new MigrationValidator(),
    "disabled-tls-verification": new TlsValidator(),
  });
}
