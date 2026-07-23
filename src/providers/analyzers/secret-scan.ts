import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { ChangedFile } from "../scm/port.js";
import type { Analyzer } from "./port.js";
import { addedLines } from "./diff.js";

/**
 * Deterministic secret-introduction analyzer — the skeleton's one poison defect
 * class ("leaked-credential"). Chosen because it is genuinely catastrophic
 * (credential leak into main) yet fully deterministic, so it exercises the whole
 * pipeline without depending on an uncalibrated model.
 *
 * It scans only ADDED lines of each patch: the poison gate cares about what this
 * change introduces, not what already existed.
 */

const VERSION = "1.0.0";

interface SecretPattern {
  ruleId: string;
  description: string;
  regex: RegExp;
}

const PATTERNS: SecretPattern[] = [
  {
    ruleId: "SECRET.PRIVATE_KEY",
    description: "PEM private-key header",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    ruleId: "SECRET.AWS_ACCESS_KEY",
    description: "AWS access key id",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
];

/**
 * The credential token(s) a line matches, for a given rule (or all rules). The
 * validator reasons about the MATCHED token, not the surrounding line — an
 * attacker-written comment ("// example") must not be able to refute a live key.
 */
export function matchedSecretTokens(text: string, ruleId?: string): string[] {
  const tokens: string[] = [];
  for (const pattern of PATTERNS) {
    if (ruleId !== undefined && pattern.ruleId !== ruleId) continue;
    const m = pattern.regex.exec(text);
    if (m) tokens.push(m[0]);
  }
  return tokens;
}

export class SecretScanAnalyzer implements Analyzer {
  readonly id = "secret-scan";

  async analyze(subject: SubjectRevision, files: ChangedFile[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of files) {
      for (const { text, line } of addedLines(file.patch)) {
        for (const pattern of PATTERNS) {
          if (!pattern.regex.test(text)) continue;
          findings.push({
            ruleId: pattern.ruleId,
            defectClass: "leaked-credential",
            subject,
            primaryRegion: { path: file.path, startLine: line, endLine: line, snippet: text },
            provenance: {
              analyzerId: this.id,
              analyzerVersion: VERSION,
              modelId: null,
              promptVersion: null,
            },
            supporting: [{ trust: "deterministic", statement: `added line matches ${pattern.description}` }],
            contradicting: [],
            completeness: { requiredEvidencePresent: true, contextTruncated: false },
            validation: "pending",
          });
        }
      }
    }
    return findings;
  }
}
