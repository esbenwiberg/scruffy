import { describe, expect, it } from "vitest";
import { DestructiveMigrationAnalyzer } from "../../src/providers/analyzers/destructive-migration.js";
import { DisabledTlsAnalyzer } from "../../src/providers/analyzers/disabled-tls.js";
import { deterministicFinding } from "../../src/providers/analyzers/finding.js";
import { MigrationValidator } from "../../src/providers/validation/migration-validator.js";
import { TlsValidator } from "../../src/providers/validation/tls-validator.js";
import { CompositeValidator } from "../../src/domain/validation/composite.js";
import type { ChangedFile } from "../../src/providers/scm/port.js";

const SUBJECT = { repository: "acme/x", commitSha: "a".repeat(40) };

function file(path: string, lines: string[]): ChangedFile {
  return { path, patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n") };
}

function findingFor(ruleId: string, defectClass: string, path: string, snippet: string) {
  return deterministicFinding({
    ruleId,
    defectClass,
    subject: SUBJECT,
    path,
    line: 1,
    snippet,
    analyzerId: "t",
    analyzerVersion: "0",
    statement: "s",
  });
}

describe("DestructiveMigrationAnalyzer", () => {
  const a = new DestructiveMigrationAnalyzer();

  it("flags DELETE without WHERE, TRUNCATE, and DROP TABLE", async () => {
    const rules = (await a.analyze(SUBJECT, [file("migrations/1.sql", ["DELETE FROM users;", "TRUNCATE t;", "DROP TABLE t;"])])).map((f) => f.ruleId);
    expect(rules).toContain("MIGRATION.DELETE_WITHOUT_WHERE");
    expect(rules).toContain("MIGRATION.TRUNCATE");
    expect(rules).toContain("MIGRATION.DROP_TABLE");
  });

  it("does not flag DELETE guarded by a real WHERE", async () => {
    const f = await a.analyze(SUBJECT, [file("migrations/1.sql", ["DELETE FROM users WHERE id = 1;"])]);
    expect(f).toHaveLength(0);
  });

  it("does not treat a WHERE inside a comment as a guard", async () => {
    const f = await a.analyze(SUBJECT, [file("migrations/1.sql", ["DELETE FROM users; -- WHERE clause was here"])]);
    expect(f.map((x) => x.ruleId)).toEqual(["MIGRATION.DELETE_WITHOUT_WHERE"]);
  });

  it("skips fully commented lines", async () => {
    const f = await a.analyze(SUBJECT, [file("migrations/1.sql", ["-- DROP TABLE t;"])]);
    expect(f).toHaveLength(0);
  });

  it("is scoped to SQL/migration files, not application code", async () => {
    const f = await a.analyze(SUBJECT, [file("src/repo.ts", ['db.query("DELETE FROM users");'])]);
    expect(f).toHaveLength(0);
  });
});

describe("DisabledTlsAnalyzer", () => {
  const a = new DisabledTlsAnalyzer();

  it("flags Node, Go, and Python TLS-disable patterns", async () => {
    const rules = (
      await a.analyze(SUBJECT, [
        file("a.ts", ["rejectUnauthorized: false"]),
        file("b.go", ["InsecureSkipVerify: true"]),
        file("c.py", ["requests.get(u, verify=False)"]),
      ])
    ).map((f) => f.ruleId);
    expect(rules).toEqual([
      "TLS.REJECT_UNAUTHORIZED_FALSE",
      "TLS.GO_INSECURE_SKIP_VERIFY",
      "TLS.PY_VERIFY_FALSE",
    ]);
  });

  it("ignores ordinary lines", async () => {
    expect(await a.analyze(SUBJECT, [file("a.ts", ["const verify = true;"])])).toHaveLength(0);
  });
});

describe("MigrationValidator", () => {
  const v = new MigrationValidator();
  it("confirms unguarded whole-table ops", async () => {
    expect(await v.validate(findingFor("MIGRATION.DELETE_WITHOUT_WHERE", "destructive-schema-change", "m.sql", "DELETE FROM t;"))).toBe("validated");
    expect(await v.validate(findingFor("MIGRATION.TRUNCATE", "destructive-schema-change", "m.sql", "TRUNCATE t;"))).toBe("validated");
  });
  it("escalates a bare DROP rather than autonomously blocking", async () => {
    expect(await v.validate(findingFor("MIGRATION.DROP_TABLE", "destructive-schema-change", "m.sql", "DROP TABLE t;"))).toBe("indeterminate");
  });
});

describe("TlsValidator", () => {
  const v = new TlsValidator();
  it("validates a production disable", async () => {
    expect(await v.validate(findingFor("TLS.REJECT_UNAUTHORIZED_FALSE", "disabled-tls-verification", "src/http.ts", "rejectUnauthorized: false"))).toBe("validated");
  });
  it("refutes a disable in test code", async () => {
    expect(await v.validate(findingFor("TLS.REJECT_UNAUTHORIZED_FALSE", "disabled-tls-verification", "src/http.test.ts", "rejectUnauthorized: false"))).toBe("refuted");
  });
  it("refutes a commented-out disable", async () => {
    expect(await v.validate(findingFor("TLS.REJECT_UNAUTHORIZED_FALSE", "disabled-tls-verification", "src/http.ts", "// rejectUnauthorized: false"))).toBe("refuted");
  });
});

describe("CompositeValidator", () => {
  it("abstains (indeterminate) for a defect class with no registered validator", async () => {
    const composite = new CompositeValidator({ "leaked-credential": new TlsValidator() });
    const outcome = await composite.validate(findingFor("X.Y", "unregistered-class", "a.ts", "whatever"));
    expect(outcome).toBe("indeterminate");
  });
});
