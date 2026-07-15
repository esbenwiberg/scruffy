import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { ChangedFile } from "../scm/port.js";
import type { Analyzer } from "./port.js";
import { addedLines } from "./diff.js";
import { deterministicFinding } from "./finding.js";

/**
 * Detects disabling of TLS certificate verification across the v1 ecosystems —
 * an immediately exploitable (MITM) security defect. Cross-language:
 * Node/JS, Go, and Python.
 *
 * The analyzer flags every occurrence; the validator refutes occurrences in
 * test code, where disabling verification is a common and acceptable practice.
 */

const VERSION = "1.0.0";
const DEFECT_CLASS = "disabled-tls-verification";

interface Rule {
  ruleId: string;
  description: string;
  regex: RegExp;
}

const RULES: Rule[] = [
  {
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    description: "Node rejectUnauthorized: false",
    regex: /rejectUnauthorized\s*:\s*false/i,
  },
  {
    ruleId: "TLS.NODE_TLS_REJECT_UNAUTHORIZED",
    description: "NODE_TLS_REJECT_UNAUTHORIZED = 0",
    regex: /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]?0/,
  },
  {
    ruleId: "TLS.GO_INSECURE_SKIP_VERIFY",
    description: "Go InsecureSkipVerify: true",
    regex: /InsecureSkipVerify\s*:\s*true/,
  },
  {
    ruleId: "TLS.PY_VERIFY_FALSE",
    description: "Python verify=False",
    regex: /\bverify\s*=\s*False\b/,
  },
];

export class DisabledTlsAnalyzer implements Analyzer {
  readonly id = "disabled-tls";

  async analyze(subject: SubjectRevision, files: ChangedFile[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of files) {
      for (const { text, line } of addedLines(file.patch)) {
        for (const rule of RULES) {
          if (!rule.regex.test(text)) continue;
          findings.push(
            deterministicFinding({
              ruleId: rule.ruleId,
              defectClass: DEFECT_CLASS,
              subject,
              path: file.path,
              line,
              snippet: text,
              analyzerId: this.id,
              analyzerVersion: VERSION,
              statement: `added line disables TLS verification (${rule.description})`,
            }),
          );
        }
      }
    }
    return findings;
  }
}
