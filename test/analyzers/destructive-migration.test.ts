import { describe, expect, it } from "vitest";
import { DestructiveMigrationAnalyzer } from "../../src/providers/analyzers/destructive-migration.js";
import type { SubjectRevision } from "../../src/domain/evidence/types.js";

const SUBJECT: SubjectRevision = { repository: "acme/api", commitSha: "d".repeat(40) };

function newFile(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

async function findings(path: string, lines: string[]) {
  return new DestructiveMigrationAnalyzer().analyze(SUBJECT, [{ path, patch: newFile(lines) }]);
}

describe("DestructiveMigrationAnalyzer statement matching", () => {
  it("matches a destructive statement that spans lines (guard on the next line counts)", async () => {
    const guarded = await findings("migrations/0007_cleanup.sql", ["DELETE FROM sessions", "WHERE expires_at < now();"]);
    expect(guarded).toHaveLength(0);

    const unguarded = await findings("migrations/0007_cleanup.sql", ["DELETE FROM", "  sessions;"]);
    expect(unguarded.map((f) => f.ruleId)).toEqual(["MIGRATION.DELETE_WITHOUT_WHERE"]);
  });

  it("ignores destructive keywords inside a string LITERAL — literal content must not drive a block", async () => {
    const result = await findings("migrations/0008_audit.sql", [
      "INSERT INTO audit_log (note)",
      "VALUES ('cleanup: DELETE FROM temp_rows');",
    ]);
    expect(result).toHaveLength(0);
  });

  it("does NOT let a 'where' inside a string literal masquerade as the missing guard", async () => {
    const result = await findings("migrations/0009_flags.sql", ["UPDATE flags SET note = 'where applicable';"]);
    expect(result.map((f) => f.ruleId)).toEqual(["MIGRATION.UPDATE_WITHOUT_WHERE"]);
  });

  it("ignores statements living entirely in -- comments", async () => {
    const result = await findings("migrations/0010_note.sql", ["-- DELETE FROM users;", "CREATE INDEX idx_users_email ON users (email);"]);
    expect(result).toHaveLength(0);
  });

  it("keeps the RAW literal text in the snippet (evidence stays faithful)", async () => {
    const result = await findings("migrations/0009_flags.sql", ["UPDATE flags SET note = 'where applicable';"]);
    expect(result[0]!.primaryRegion.snippet).toContain("'where applicable'");
  });

  it("still scopes to SQL/migration files — an ORM string in app code is not a migration", async () => {
    const result = await findings("src/jobs/cleanup.ts", ['await db.query("DELETE FROM sessions");']);
    expect(result).toHaveLength(0);
  });
});
