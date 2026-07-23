import type { Validator } from "../../domain/validation/port.js";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";
import { isTestPath } from "../analyzers/diff.js";
import { tlsDisableMatches } from "../analyzers/disabled-tls.js";

/**
 * Validator for disabled-tls-verification findings. Disabling certificate
 * verification in test/spec code is common and acceptable, so those are refuted;
 * an occurrence that lives only inside a comment is likewise refuted; a live one
 * in production code stands.
 *
 * We decide "commented out?" by stripping comments and re-checking the pattern
 * against what remains, NOT by a prefix test. A prefix test refuted
 * `/* prod hack *​/ rejectUnauthorized: false` — a real disable after an inline
 * comment — waving a MITM hole straight through. It also refuted any line
 * starting with `*`, which matches live code. A `*` block-comment CONTINUATION
 * line cannot be told from live code without multi-line context, so we do not
 * refute it: for a security gate, over-blocking a doc line beats shipping a
 * disable.
 */

/** Strip inline `/* … *​/` spans and trailing `//` / `#` line comments. */
function codeOutsideComments(line: string): string {
  let s = line.replace(/\/\*.*?\*\//g, " ");
  const lineComment = s.search(/\/\/|#/);
  if (lineComment !== -1) s = s.slice(0, lineComment);
  return s;
}

export class TlsValidator implements Validator {
  readonly id = "tls-validator";

  async validate(finding: Finding): Promise<ValidationOutcome> {
    if (isTestPath(finding.primaryRegion.path)) return "refuted";
    // If the disable no longer appears once comments are stripped, it was only in
    // a comment — refute. If it survives, it is live code — it stands.
    const code = codeOutsideComments(finding.primaryRegion.snippet);
    if (!tlsDisableMatches(code, finding.ruleId)) return "refuted";
    return "validated";
  }
}
