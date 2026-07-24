import type { ReleaseCorpus } from "./release-types.js";

/**
 * Seeded release ranges. Invented identifiers, no real-repo lineage. These
 * exercise the three real outcomes (ship | sign-off-required | stop) over a
 * range, including the load-bearing "dangerous but unconfirmed -> sign-off, not a
 * fabricated stop" path — all reachable with the deterministic analyzers alone
 * (no model backend on the corpus path).
 */

const PROV = { source: "seeded-mutation", author: "ewi", createdAt: "2026-07-16" } as const;
const PROV24 = { source: "seeded-mutation", author: "ewi", createdAt: "2026-07-24" } as const;

function newFile(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

function sha(n: number): string {
  return ("f" + n.toString(16)).padStart(40, "0");
}

export const SEEDED_RELEASE_CORPUS: ReleaseCorpus = [
  {
    id: "release-ship-clean",
    description: "range of ordinary changes with no defect — the gate should ship",
    range: { repository: "shop/checkout", baseSha: sha(1), headSha: sha(2) },
    files: [
      { path: "src/total.ts", patch: newFile(["export const total = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);"]) },
      { path: "CHANGELOG.md", patch: newFile(["## 1.4.0", "Adds a total helper."]) },
    ],
    truthOutcome: "ship",
    expectedOutcome: "ship",
    provenance: PROV,
  },
  {
    id: "release-signoff-tls",
    description:
      "range with a prod disabled-TLS flag (serious but human-adjudicable) plus a refuted test-file copy — the gate should require sign-off, not stop",
    range: { repository: "shop/checkout", baseSha: sha(2), headSha: sha(3) },
    files: [
      { path: "src/http.ts", patch: newFile(["const agent = new https.Agent({ rejectUnauthorized: false });"]) },
      { path: "test/http.test.ts", patch: newFile(["const agent = new https.Agent({ rejectUnauthorized: false });"]) },
    ],
    truthOutcome: "sign-off-required",
    expectedOutcome: "sign-off-required",
    provenance: PROV,
  },
  {
    id: "release-stop-secret",
    description: "range that ships a live-looking AWS key (irreversible: the secret is burned) — the gate must stop",
    range: { repository: "shop/checkout", baseSha: sha(3), headSha: sha(4) },
    files: [{ path: "src/config.ts", patch: newFile(["export const AWS_KEY = 'AKIAIJKLMNOP12345678';"]) }],
    truthOutcome: "stop",
    expectedOutcome: "stop",
    provenance: PROV,
  },
  {
    id: "release-signoff-unconfirmed-drop",
    description:
      "range with a bare DROP TABLE — a stop-class defect the validator cannot confirm is unintended (a deprecated empty table may be legitimate). Must escalate to sign-off, NOT fabricate a stop",
    range: { repository: "shop/checkout", baseSha: sha(4), headSha: sha(5) },
    files: [{ path: "migrations/0007_drop_legacy.sql", patch: newFile(["DROP TABLE legacy_sessions;"]) }],
    truthOutcome: "sign-off-required",
    expectedOutcome: "sign-off-required",
    provenance: PROV,
  },
  {
    // Mirrors a real agent-harness's OUTBOUND push checkpoint: `onSecret: block`
    // at the boundary entering validation. A release candidate that ships a
    // hardcoded AWS key is an irreversible leak (the secret is burned) -> STOP.
    // The harness rewrites block->escalate for interactive "workspace" pods so a
    // human confirms — the same shape as scruffy's stop vs sign-off-required
    // split. Here the authoritative case: confirmed secret -> stop. Seeded from
    // the harness's secret-scan taxonomy; invented identifiers, fresh fake key.
    id: "release-harness-secret-stop",
    description:
      "release candidate shipping a hardcoded AWS key — irreversible leak, must STOP (mirrors a real harness push checkpoint blocking on secrets)",
    range: { repository: "agent-harness/daemon", baseSha: sha(0x10), headSha: sha(0x11) },
    files: [
      {
        path: "src/config/credentials.ts",
        patch: newFile([
          "export const OBJECT_STORE_ACCESS_KEY_ID = 'AKIA7F3QX9RLZ2WK8MTV';",
          "export const OBJECT_STORE_REGION = 'eu-north-1';",
        ]),
      },
    ],
    truthOutcome: "stop",
    expectedOutcome: "stop",
    provenance: PROV,
  },
  {
    // The other confirmed-destructive shape: an unguarded whole-table UPDATE is
    // validated (not escalated like a bare DROP), and destructive-schema-change
    // is a stop class — irreversible data corruption must not ship.
    id: "release-stop-update-without-where",
    description: "release candidate carrying an unguarded whole-table UPDATE in a migration — confirmed destructive, must STOP",
    range: { repository: "shop/checkout", baseSha: sha(0x20), headSha: sha(0x21) },
    files: [
      { path: "migrations/0031_backfill.sql", patch: newFile(["UPDATE orders SET status = 'archived';"]) },
      { path: "src/status.ts", patch: newFile(["export const ARCHIVED = 'archived';"]) },
    ],
    truthOutcome: "stop",
    expectedOutcome: "stop",
    provenance: PROV24,
  },
  {
    // Refuted noise must CLEAR, not accumulate into a sign-off: a docs example
    // key and a test-file TLS disable are both refuted, so the candidate ships.
    id: "release-ship-despite-refuted-noise",
    description: "candidate whose only findings are refuted false positives (docs example key + test-file TLS) — ships clean",
    range: { repository: "shop/checkout", baseSha: sha(0x22), headSha: sha(0x23) },
    files: [
      { path: "docs/setup.md", patch: newFile(["Use AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE for the sandbox walkthrough."]) },
      { path: "test/tls.test.ts", patch: newFile(["const agent = new https.Agent({ rejectUnauthorized: false });"]) },
    ],
    truthOutcome: "ship",
    expectedOutcome: "ship",
    provenance: PROV24,
  },
];
