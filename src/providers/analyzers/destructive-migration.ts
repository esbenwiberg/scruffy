import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { ChangedFile } from "../scm/port.js";
import type { Analyzer } from "./port.js";
import { addedLines, type AddedLine } from "./diff.js";
import { deterministicFinding } from "./finding.js";

/**
 * Detects destructive schema changes — the "silent data loss or corruption"
 * poison category. Scoped to SQL / migration files to avoid matching ORM query
 * strings in application code.
 *
 * Matching is STATEMENT-level, not line-level. SQL statements routinely span
 * several lines (`DELETE FROM t` on one line, `WHERE …` on the next), so a
 * per-line regex both false-BLOCKS a guarded multi-line delete (the guard is on
 * the next line) and MISSES an unguarded multi-line one. We reassemble added
 * lines into statements at `;` boundaries — ignoring `--` comments and `;`
 * inside string literals — and match the whole statement.
 *
 * Deterministic detection only establishes that a statement IS destructive, not
 * that it is UNINTENDED. That judgment is left to the validator: unguarded
 * whole-table operations are confirmed; a bare DROP is escalated (indeterminate)
 * because dropping a deprecated empty table can be legitimate.
 */

const VERSION = "1.1.0";
const DEFECT_CLASS = "destructive-schema-change";

interface Rule {
  ruleId: string;
  description: string;
  matches(statement: string): boolean;
}

function hasWhere(statement: string): boolean {
  return /\bWHERE\b/i.test(statement);
}

const RULES: Rule[] = [
  { ruleId: "MIGRATION.DROP_TABLE", description: "DROP TABLE", matches: (s) => /\bDROP\s+TABLE\b/i.test(s) },
  { ruleId: "MIGRATION.DROP_COLUMN", description: "DROP COLUMN", matches: (s) => /\bDROP\s+COLUMN\b/i.test(s) },
  { ruleId: "MIGRATION.TRUNCATE", description: "TRUNCATE", matches: (s) => /\bTRUNCATE\b/i.test(s) },
  {
    ruleId: "MIGRATION.DELETE_WITHOUT_WHERE",
    description: "DELETE without WHERE",
    matches: (s) => /\bDELETE\s+FROM\s+\S+/i.test(s) && !hasWhere(s),
  },
  {
    ruleId: "MIGRATION.UPDATE_WITHOUT_WHERE",
    description: "UPDATE without WHERE",
    matches: (s) => /\bUPDATE\s+\S+\s+SET\b/i.test(s) && !hasWhere(s),
  },
];

/**
 * Only genuine SQL: a `.sql` file, or a file living under a `migration(s)`
 * directory. The old `/migrat/` substring test also matched prose like
 * `docs/migration-guide.md`, where an example `DELETE FROM users;` would
 * false-block.
 */
function isSqlFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".sql") || /(^|\/)migrations?(\/|$)/.test(lower);
}

interface Statement {
  text: string;
  line: number;
}

/**
 * Reassemble added lines into logical SQL statements. Scans char by char so that
 * `--` line comments are dropped and `;` / `--` inside single- or double-quoted
 * string literals are not treated as a terminator/comment. Each statement is
 * attributed to the line of its first non-whitespace character.
 */
function statements(added: readonly AddedLine[]): Statement[] {
  const out: Statement[] = [];
  let buf = "";
  let startLine = -1;
  let inSingle = false;
  let inDouble = false;

  const flush = () => {
    const text = buf.trim();
    if (text !== "") out.push({ text, line: startLine });
    buf = "";
  };

  for (const { text, line } of added) {
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]!;
      if (!inSingle && !inDouble && c === "-" && text[i + 1] === "-") break; // rest of line is a comment
      if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === '"' && !inSingle) inDouble = !inDouble;

      if (buf.trim() === "" && c.trim() !== "") startLine = line;
      if (c === ";" && !inSingle && !inDouble) {
        flush();
      } else {
        buf += c;
      }
    }
    // A physical newline separates tokens across lines; never glue them together.
    if (buf !== "") buf += " ";
  }
  flush();
  return out;
}

export class DestructiveMigrationAnalyzer implements Analyzer {
  readonly id = "destructive-migration";

  async analyze(subject: SubjectRevision, files: ChangedFile[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of files) {
      if (!isSqlFile(file.path)) continue;
      for (const stmt of statements(addedLines(file.patch))) {
        for (const rule of RULES) {
          if (!rule.matches(stmt.text)) continue;
          findings.push(
            deterministicFinding({
              ruleId: rule.ruleId,
              defectClass: DEFECT_CLASS,
              subject,
              path: file.path,
              line: stmt.line,
              snippet: stmt.text,
              analyzerId: this.id,
              analyzerVersion: VERSION,
              statement: `added migration statement contains ${rule.description}`,
            }),
          );
        }
      }
    }
    return findings;
  }
}
