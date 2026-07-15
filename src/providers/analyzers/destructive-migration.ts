import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { ChangedFile } from "../scm/port.js";
import type { Analyzer } from "./port.js";
import { addedLines } from "./diff.js";
import { deterministicFinding } from "./finding.js";

/**
 * Detects destructive schema changes — the "silent data loss or corruption"
 * poison category. Scoped to SQL / migration files to avoid matching ORM query
 * strings in application code.
 *
 * Deterministic detection only establishes that a statement IS destructive, not
 * that it is UNINTENDED. That judgment is left to the validator: unguarded
 * whole-table operations are confirmed; a bare DROP is escalated (indeterminate)
 * because dropping a deprecated empty table can be legitimate.
 */

const VERSION = "1.0.0";
const DEFECT_CLASS = "destructive-schema-change";

interface Rule {
  ruleId: string;
  description: string;
  matches(line: string): boolean;
}

function hasWhere(line: string): boolean {
  return /\bWHERE\b/i.test(line);
}

const RULES: Rule[] = [
  { ruleId: "MIGRATION.DROP_TABLE", description: "DROP TABLE", matches: (l) => /\bDROP\s+TABLE\b/i.test(l) },
  { ruleId: "MIGRATION.DROP_COLUMN", description: "DROP COLUMN", matches: (l) => /\bDROP\s+COLUMN\b/i.test(l) },
  { ruleId: "MIGRATION.TRUNCATE", description: "TRUNCATE", matches: (l) => /\bTRUNCATE\b/i.test(l) },
  {
    ruleId: "MIGRATION.DELETE_WITHOUT_WHERE",
    description: "DELETE without WHERE",
    matches: (l) => /\bDELETE\s+FROM\s+\S+/i.test(l) && !hasWhere(l),
  },
  {
    ruleId: "MIGRATION.UPDATE_WITHOUT_WHERE",
    description: "UPDATE without WHERE",
    matches: (l) => /\bUPDATE\s+\S+\s+SET\b/i.test(l) && !hasWhere(l),
  },
];

function isSqlFile(path: string): boolean {
  return path.toLowerCase().endsWith(".sql") || /migrat/i.test(path);
}

/** Strip inline SQL comment so `WHERE` inside a comment doesn't count as a guard. */
function codeBeforeComment(line: string): string {
  const idx = line.indexOf("--");
  return idx === -1 ? line : line.slice(0, idx);
}

export class DestructiveMigrationAnalyzer implements Analyzer {
  readonly id = "destructive-migration";

  async analyze(subject: SubjectRevision, files: ChangedFile[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of files) {
      if (!isSqlFile(file.path)) continue;
      for (const { text, line } of addedLines(file.patch)) {
        const code = codeBeforeComment(text);
        if (code.trim() === "") continue; // whole line is a comment
        for (const rule of RULES) {
          if (!rule.matches(code)) continue;
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
              statement: `added migration line contains ${rule.description}`,
            }),
          );
        }
      }
    }
    return findings;
  }
}
