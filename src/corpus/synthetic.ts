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
];
