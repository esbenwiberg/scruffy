import type { ReleaseCorpus } from "./release-types.js";

/**
 * Seeded release ranges. Invented identifiers, no real-repo lineage. These
 * exercise the three real outcomes (ship | sign-off-required | stop) over a
 * range, including the load-bearing "dangerous but unconfirmed -> sign-off, not a
 * fabricated stop" path — all reachable with the deterministic analyzers alone
 * (no model backend on the corpus path).
 */

const PROV = { source: "seeded-mutation", author: "ewi", createdAt: "2026-07-16" } as const;

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
];
