import type { Validator } from "../../domain/validation/port.js";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";
import { matchedSecretTokens } from "../analyzers/secret-scan.js";

/**
 * Deterministic validator for leaked-credential findings. Independent of the
 * analyzer's own signal: it tries to refute the match by checking whether the
 * quoted secret is an obvious placeholder/dummy rather than a live credential.
 *
 * CRITICAL: the placeholder test runs against the MATCHED credential token, not
 * the whole line. Scanning the whole line let any occurrence of "example" —
 * including an attacker-written comment on the same line — refute a real key and
 * ship it. So we re-derive the token the analyzer matched and judge only that.
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
  "0000000000000000",
];

function isPlaceholderToken(token: string): boolean {
  const upper = token.toUpperCase();
  return PLACEHOLDER_MARKERS.some((m) => upper.includes(m));
}

export class SecretValidator implements Validator {
  readonly id = "secret-validator";

  async validate(finding: Finding): Promise<ValidationOutcome> {
    const tokens = matchedSecretTokens(finding.primaryRegion.snippet, finding.ruleId);

    // The analyzer matched, but the token isn't visible in the stored snippet
    // (e.g. it was truncated). We cannot judge the token, so we cannot refute —
    // the deterministic match stands rather than being waved through.
    if (tokens.length === 0) return "validated";

    // Refute only when EVERY matched token is a known placeholder/example. A
    // single live-looking token means a real secret is being introduced.
    if (tokens.every(isPlaceholderToken)) return "refuted";
    return "validated";
  }
}
