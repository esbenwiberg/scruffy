import { describe, expect, it } from "vitest";
import { MigrationValidator } from "../../src/providers/validation/migration-validator.js";
import { deterministicFinding } from "../../src/providers/analyzers/finding.js";

function finding(ruleId: string) {
  return deterministicFinding({
    ruleId,
    defectClass: "destructive-schema-change",
    subject: { repository: "acme/web", commitSha: "a".repeat(40) },
    path: "migrations/001.sql",
    line: 1,
    snippet: "-- migration",
    analyzerId: "migration-scan",
    analyzerVersion: "1.0.0",
    statement: "destructive statement detected",
  });
}

const CONFIRMED = [
  "MIGRATION.DELETE_WITHOUT_WHERE",
  "MIGRATION.UPDATE_WITHOUT_WHERE",
  "MIGRATION.TRUNCATE",
];

describe("MigrationValidator", () => {
  const v = new MigrationValidator();

  it.each(CONFIRMED)("confirms %s as validated", async (ruleId) => {
    expect(await v.validate(finding(ruleId))).toBe("validated");
  });

  // Bare DROPs are ambiguous, not autonomously block-worthy: they escalate.
  it.each(["MIGRATION.DROP_TABLE", "MIGRATION.DROP_COLUMN"])(
    "escalates bare %s as indeterminate",
    async (ruleId) => {
      expect(await v.validate(finding(ruleId))).toBe("indeterminate");
    },
  );

  it("escalates an unknown rule id as indeterminate — never a fabricated validated", async () => {
    expect(await v.validate(finding("MIGRATION.SOMETHING_NEW"))).toBe("indeterminate");
    expect(await v.validate(finding("TOTALLY.UNRELATED"))).toBe("indeterminate");
  });
});
