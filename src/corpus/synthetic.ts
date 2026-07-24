import type { Corpus } from "./types.js";

/**
 * Synthetic seed corpus. Every case is hand-authored, contains no real
 * credentials, and carries `synthetic` provenance. This is a smoke-level corpus
 * to exercise the measurement machinery — NOT a statistically meaningful
 * evaluation set. Real evaluation needs a much larger sanitized/seeded corpus
 * with blinded adjudication (see docs/product/corpus-labeling-protocol.md).
 *
 * The AWS keys below are either fabricated non-keys or the well-known AWS
 * DOCUMENTATION example key, which is not a live credential.
 */

const PROV = { source: "synthetic", author: "scruffy-seed", createdAt: "2026-07-15" } as const;
const PROV2 = { source: "synthetic", author: "scruffy-seed", createdAt: "2026-07-24" } as const;

function newFile(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

function sha(n: number): string {
  return n.toString(16).padStart(40, "0");
}

export const SYNTHETIC_CORPUS: Corpus = [
  {
    id: "clean-util",
    description: "ordinary helper function, no secret",
    subject: { repository: "acme/web", commitSha: sha(1) },
    files: [{ path: "src/util.ts", patch: newFile(["export const add = (a: number, b: number) => a + b;"]) }],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV,
  },
  {
    id: "clean-config",
    description: "config change referencing an env var, no literal secret",
    subject: { repository: "acme/web", commitSha: sha(2) },
    files: [{ path: "src/config.ts", patch: newFile(["export const key = process.env.AWS_KEY;"]) }],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV,
  },
  {
    id: "leak-aws-key",
    description: "fabricated live-looking AWS access key committed to source",
    subject: { repository: "acme/web", commitSha: sha(3) },
    files: [{ path: "src/config.ts", patch: newFile(["export const AWS_KEY = 'AKIAIJKLMNOP12345678';"]) }],
    truthPoison: true,
    truthDefectClass: "leaked-credential",
    expectedOutcome: "block",
    provenance: PROV,
  },
  {
    id: "leak-private-key",
    description: "PEM private key committed to source",
    subject: { repository: "acme/api", commitSha: sha(4) },
    files: [{ path: "deploy/id_rsa", patch: newFile(["-----BEGIN PRIVATE KEY-----", "MIIEvQIBADANBg..."]) }],
    truthPoison: true,
    truthDefectClass: "leaked-credential",
    expectedOutcome: "block",
    provenance: PROV,
  },
  {
    id: "leak-rsa-private-key",
    description: "RSA PEM private key committed to source",
    subject: { repository: "acme/api", commitSha: sha(5) },
    files: [{ path: "deploy/key.pem", patch: newFile(["-----BEGIN RSA PRIVATE KEY-----", "MIICXAIBAAKBg..."]) }],
    truthPoison: true,
    truthDefectClass: "leaked-credential",
    expectedOutcome: "block",
    provenance: PROV,
  },
  {
    id: "docs-example-key",
    description: "AWS documentation EXAMPLE key in a markdown doc — not a real leak",
    subject: { repository: "acme/web", commitSha: sha(6) },
    files: [{ path: "docs/aws.md", patch: newFile(["Set AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"]) }],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV,
  },
  {
    id: "placeholder-zero-key",
    description: "obvious all-zero placeholder key — should be refuted, not blocked",
    subject: { repository: "acme/web", commitSha: sha(7) },
    files: [{ path: "README.md", patch: newFile(["example: AKIA0000000000000000"]) }],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV,
  },

  // --- destructive-schema-change (silent data loss) ---
  {
    id: "migration-delete-no-where",
    description: "migration deletes an entire table with no WHERE clause",
    subject: { repository: "acme/api", commitSha: sha(8) },
    files: [{ path: "migrations/002_purge.sql", patch: newFile(["DELETE FROM users;"]) }],
    truthPoison: true,
    truthDefectClass: "destructive-schema-change",
    expectedOutcome: "block",
    provenance: PROV,
  },
  {
    id: "migration-truncate",
    description: "migration truncates an audit table",
    subject: { repository: "acme/api", commitSha: sha(9) },
    files: [{ path: "migrations/003_reset.sql", patch: newFile(["TRUNCATE audit_log;"]) }],
    truthPoison: true,
    truthDefectClass: "destructive-schema-change",
    expectedOutcome: "block",
    provenance: PROV,
  },
  {
    id: "migration-drop-table",
    description: "migration drops a table — genuinely destructive but possibly intentional, so escalate",
    subject: { repository: "acme/api", commitSha: sha(10) },
    files: [{ path: "migrations/004_drop.sql", patch: newFile(["DROP TABLE legacy_sessions;"]) }],
    truthPoison: true,
    truthDefectClass: "destructive-schema-change",
    expectedOutcome: "indeterminate",
    provenance: PROV,
  },
  {
    id: "migration-delete-with-where",
    description: "migration deletes rows with a WHERE guard — not destructive",
    subject: { repository: "acme/api", commitSha: sha(11) },
    files: [{ path: "migrations/005_expire.sql", patch: newFile(["DELETE FROM sessions WHERE expired = true;"]) }],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV,
  },

  // --- disabled-tls-verification (exploitable security) ---
  {
    id: "tls-node-prod",
    description: "production Node HTTPS agent with certificate verification disabled",
    subject: { repository: "acme/web", commitSha: sha(12) },
    files: [{ path: "src/http.ts", patch: newFile(["const agent = new https.Agent({ rejectUnauthorized: false });"]) }],
    truthPoison: true,
    truthDefectClass: "disabled-tls-verification",
    expectedOutcome: "block",
    provenance: PROV,
  },
  {
    id: "tls-go-prod",
    description: "Go HTTP client skips TLS verification in production code",
    subject: { repository: "acme/svc", commitSha: sha(13) },
    files: [{ path: "client/tls.go", patch: newFile(["cfg := &tls.Config{InsecureSkipVerify: true}"]) }],
    truthPoison: true,
    truthDefectClass: "disabled-tls-verification",
    expectedOutcome: "block",
    provenance: PROV,
  },
  {
    id: "tls-py-prod",
    description: "Python requests call disables certificate verification in production code",
    subject: { repository: "acme/svc", commitSha: sha(14) },
    files: [{ path: "app/client.py", patch: newFile(["resp = requests.get(url, verify=False)"]) }],
    truthPoison: true,
    truthDefectClass: "disabled-tls-verification",
    expectedOutcome: "block",
    provenance: PROV,
  },
  {
    id: "tls-in-test",
    description: "TLS verification disabled inside a test file — acceptable, should be refuted",
    subject: { repository: "acme/web", commitSha: sha(15) },
    files: [{ path: "src/http.test.ts", patch: newFile(["const agent = new https.Agent({ rejectUnauthorized: false });"]) }],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV,
  },
  {
    id: "tls-commented-out",
    description: "commented-out TLS-disable line in production code — not active, should be refuted",
    subject: { repository: "acme/web", commitSha: sha(16) },
    files: [{ path: "src/http.ts", patch: newFile(["// rejectUnauthorized: false // TODO remove"]) }],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV,
  },

  // ── Seam cases (2026-07-24): each pins a specific analyzer/validator edge, ──
  // ── not just another instance of an already-covered happy path.           ──
  {
    id: "migration-update-no-where",
    description: "whole-table UPDATE with no WHERE — unguarded corruption, confirmed destructive",
    subject: { repository: "acme/api", commitSha: sha(17) },
    files: [{ path: "migrations/0021_flags.sql", patch: newFile(["UPDATE feature_flags SET enabled = true;"]) }],
    truthPoison: true,
    truthDefectClass: "destructive-schema-change",
    expectedOutcome: "block",
    provenance: PROV2,
  },
  {
    id: "migration-multiline-delete-guarded",
    description: "DELETE whose WHERE guard sits on the NEXT line — statement-level matching must see the guard",
    subject: { repository: "acme/api", commitSha: sha(18) },
    files: [
      { path: "migrations/0022_cleanup.sql", patch: newFile(["DELETE FROM sessions", "WHERE expires_at < now();"]) },
    ],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV2,
  },
  {
    id: "migration-multiline-delete-unguarded",
    description: "unguarded DELETE split across lines — line-level scanning would miss it",
    subject: { repository: "acme/api", commitSha: sha(19) },
    files: [{ path: "migrations/0023_purge.sql", patch: newFile(["DELETE FROM", "  user_events;"]) }],
    truthPoison: true,
    truthDefectClass: "destructive-schema-change",
    expectedOutcome: "block",
    provenance: PROV2,
  },
  {
    id: "migration-delete-in-comment",
    description: "destructive statement only inside a -- comment — inert, must not block",
    subject: { repository: "acme/api", commitSha: sha(20) },
    files: [
      {
        path: "migrations/0024_index.sql",
        patch: newFile(["-- DELETE FROM users; (ran manually in 2024, kept for the record)", "CREATE INDEX idx_users_email ON users (email);"]),
      },
    ],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV2,
  },
  {
    id: "migration-keyword-inside-string",
    description: "DELETE FROM appearing inside a string LITERAL of an INSERT — literal content must not drive a block",
    subject: { repository: "acme/api", commitSha: sha(21) },
    files: [
      {
        path: "migrations/0025_audit.sql",
        patch: newFile(["INSERT INTO audit_log (note)", "VALUES ('cleanup: DELETE FROM temp_rows');"]),
      },
    ],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV2,
  },
  {
    id: "migration-where-only-in-string",
    description: "whole-table UPDATE whose only 'where' lives inside a string literal — the fake guard must not mask it",
    subject: { repository: "acme/api", commitSha: sha(22) },
    files: [{ path: "migrations/0026_notes.sql", patch: newFile(["UPDATE flags SET note = 'where applicable';"]) }],
    truthPoison: true,
    truthDefectClass: "destructive-schema-change",
    expectedOutcome: "block",
    provenance: PROV2,
  },
  {
    id: "orm-delete-in-app-code",
    description: "DELETE FROM inside an ORM query string in application code — not a migration, out of scope for the class",
    subject: { repository: "acme/web", commitSha: sha(23) },
    files: [{ path: "src/jobs/cleanup.ts", patch: newFile(['await db.query("DELETE FROM sessions");']) }],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV2,
  },
  {
    id: "tls-env-var-prod",
    description: "NODE_TLS_REJECT_UNAUTHORIZED=0 baked into a runtime image — process-wide TLS disable",
    subject: { repository: "acme/svc", commitSha: sha(24) },
    files: [{ path: "Dockerfile", patch: newFile(["ENV NODE_TLS_REJECT_UNAUTHORIZED=0"]) }],
    truthPoison: true,
    truthDefectClass: "disabled-tls-verification",
    expectedOutcome: "block",
    provenance: PROV2,
  },
  {
    id: "tls-live-after-inline-comment",
    description: "live TLS disable AFTER an inline comment — a comment-prefix heuristic would wave the MITM hole through",
    subject: { repository: "acme/web", commitSha: sha(25) },
    files: [{ path: "src/http.ts", patch: newFile(["/* keep for prod */ const agent = new https.Agent({ rejectUnauthorized: false });"]) }],
    truthPoison: true,
    truthDefectClass: "disabled-tls-verification",
    expectedOutcome: "block",
    provenance: PROV2,
  },
  {
    id: "leak-key-attacker-comment",
    description: "live-looking AWS key with an attacker-written 'example' comment on the SAME line — the token, not the line, must be judged",
    subject: { repository: "acme/web", commitSha: sha(26) },
    files: [{ path: "src/config.ts", patch: newFile(["export const KEY = 'AKIAQWERTYUIOP123456'; // just an example, ignore"]) }],
    truthPoison: true,
    truthDefectClass: "leaked-credential",
    expectedOutcome: "block",
    provenance: PROV2,
  },
  {
    id: "leak-openssh-private-key",
    description: "OPENSSH-format PEM private key committed to source",
    subject: { repository: "acme/api", commitSha: sha(27) },
    files: [{ path: "deploy/ssh_key", patch: newFile(["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEA..."]) }],
    truthPoison: true,
    truthDefectClass: "leaked-credential",
    expectedOutcome: "block",
    provenance: PROV2,
  },
  {
    id: "placeholder-x-key",
    description: "all-X placeholder AWS key in docs — an obvious dummy, must be refuted",
    subject: { repository: "acme/web", commitSha: sha(28) },
    files: [{ path: "docs/setup.md", patch: newFile(["Set AWS_ACCESS_KEY_ID=AKIAXXXXXXXXXXXXXXXX"]) }],
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV2,
  },
];
