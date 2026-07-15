import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { ChangedFile } from "../scm/port.js";
import type { Analyzer } from "./port.js";

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

interface AddedLine {
  text: string;
  line: number;
}

/**
 * Extract added lines with their new-file line numbers from a unified diff.
 * Hunk headers look like `@@ -a,b +c,d @@`; c is the starting new-file line.
 */
function addedLines(patch: string): AddedLine[] {
  const out: AddedLine[] = [];
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+++")) continue;
    if (raw.startsWith("+")) {
      out.push({ text: raw.slice(1), line: newLine });
      newLine += 1;
    } else if (!raw.startsWith("-")) {
      // context line advances the new-file counter
      newLine += 1;
    }
  }
  return out;
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
            primaryRegion: { path: file.path, startLine: line, endLine: line, snippet: text.trim() },
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
