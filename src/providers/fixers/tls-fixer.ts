import type { Finding } from "../../domain/evidence/types.js";
import type { ProposedEdit } from "../../domain/fixes/types.js";
import type { Fixer } from "./port.js";

/**
 * Deterministic remediation for disabled-tls-verification findings: flip the
 * offending flag back to its secure value on the single offending line. One
 * transform per analyzer rule; keyed by ruleId so a fix is only attempted for a
 * pattern this fixer actually understands.
 *
 * Deliberately mechanical — no model. A flag that re-enables certificate
 * verification is the safe default across all four ecosystems the analyzer
 * covers, and the narrow single-line replacement stays trivially reviewable.
 */

interface Transform {
  regex: RegExp;
  replacement: string;
  rationale: string;
}

const TRANSFORMS: Record<string, Transform> = {
  "TLS.REJECT_UNAUTHORIZED_FALSE": {
    regex: /(rejectUnauthorized\s*:\s*)false\b/i,
    replacement: "$1true",
    rationale: "Re-enable Node TLS certificate verification (rejectUnauthorized: true).",
  },
  "TLS.NODE_TLS_REJECT_UNAUTHORIZED": {
    regex: /(NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]?)0/,
    replacement: "$11",
    rationale: "Restore Node TLS certificate verification (NODE_TLS_REJECT_UNAUTHORIZED = 1).",
  },
  "TLS.GO_INSECURE_SKIP_VERIFY": {
    regex: /(InsecureSkipVerify\s*:\s*)true\b/,
    replacement: "$1false",
    rationale: "Re-enable Go TLS certificate verification (InsecureSkipVerify: false).",
  },
  "TLS.PY_VERIFY_FALSE": {
    regex: /(\bverify\s*=\s*)False\b/,
    replacement: "$1True",
    rationale: "Re-enable Python TLS certificate verification (verify=True).",
  },
};

export class TlsFixer implements Fixer {
  readonly defectClass = "disabled-tls-verification";

  propose(finding: Finding): ProposedEdit | null {
    const transform = TRANSFORMS[finding.ruleId];
    if (!transform) return null; // unknown rule variant — no safe deterministic fix

    const { snippet, path, startLine, endLine } = finding.primaryRegion;
    const replacement = snippet.replace(transform.regex, transform.replacement);
    if (replacement === snippet) return null; // pattern did not match — refuse to guess

    return { path, startLine, endLine, replacement, rationale: transform.rationale };
  }
}
