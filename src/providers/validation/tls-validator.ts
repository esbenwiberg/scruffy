import type { Validator } from "../../domain/validation/port.js";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";
import { isTestPath } from "../analyzers/diff.js";

/**
 * Validator for disabled-tls-verification findings. Disabling certificate
 * verification in test/spec code is common and acceptable, so those are
 * refuted; a commented-out line is likewise refuted; anything else in
 * production code stands.
 */
const COMMENT_PREFIXES = ["//", "#", "*", "/*"];

export class TlsValidator implements Validator {
  readonly id = "tls-validator";

  async validate(finding: Finding): Promise<ValidationOutcome> {
    if (isTestPath(finding.primaryRegion.path)) return "refuted";
    const trimmed = finding.primaryRegion.snippet.trimStart();
    if (COMMENT_PREFIXES.some((p) => trimmed.startsWith(p))) return "refuted";
    return "validated";
  }
}
