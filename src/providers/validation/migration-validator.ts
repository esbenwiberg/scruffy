import type { Validator } from "../../domain/validation/port.js";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";

/**
 * Validator for destructive-schema-change findings. Deterministic detection
 * proves a statement is destructive; this decides whether it is confidently
 * UNINTENDED harm (block-worthy) or merely ambiguous (escalate).
 *
 *  - whole-table operations with no guard (DELETE/UPDATE without WHERE,
 *    TRUNCATE) are confirmed: there is no safe reading of them in a migration;
 *  - a bare DROP is `indeterminate`: dropping a deprecated/empty table can be
 *    legitimate, so it escalates to a deeper gate / human rather than being
 *    autonomously blocked.
 */

const CONFIRMED = new Set([
  "MIGRATION.DELETE_WITHOUT_WHERE",
  "MIGRATION.UPDATE_WITHOUT_WHERE",
  "MIGRATION.TRUNCATE",
]);

export class MigrationValidator implements Validator {
  readonly id = "migration-validator";

  async validate(finding: Finding): Promise<ValidationOutcome> {
    if (CONFIRMED.has(finding.ruleId)) return "validated";
    // Everything else — bare DROPs (DROP_TABLE/DROP_COLUMN) and any rule we
    // don't recognise — escalates rather than being autonomously blocked.
    return "indeterminate";
  }
}
