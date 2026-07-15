import type { Validator } from "../../domain/validation/port.js";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";

/**
 * Deterministic validator for leaked-credential findings. Independent of the
 * analyzer's own signal: it tries to refute the match by checking whether the
 * quoted secret is an obvious placeholder/dummy rather than a live credential.
 *
 * This is the skeleton's stand-in for a real adversarial critic. It is
 * deterministic so replays are reproducible; a real validator would gather
 * additional independent evidence (entropy, git history, reachability).
 */

const PLACEHOLDER_MARKERS = [
  "EXAMPLE",
  "PLACEHOLDER",
  "YOUR_KEY_HERE",
  "YOUR-KEY-HERE",
  "XXXXXXXX",
  "AKIAIOSFODNN7EXAMPLE", // the canonical AWS docs example key
  "0000000000000000",
];

export class SecretValidator implements Validator {
  readonly id = "secret-validator";

  async validate(finding: Finding): Promise<ValidationOutcome> {
    const snippet = finding.primaryRegion.snippet.toUpperCase();
    if (PLACEHOLDER_MARKERS.some((m) => snippet.includes(m))) {
      return "refuted";
    }
    // Independent corroboration succeeded: the introduced value is not a known
    // placeholder, so the deterministic match stands.
    return "validated";
  }
}
