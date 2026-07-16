import type { NightlyCorpus } from "./nightly-types.js";

/**
 * Seeded nightly ranges. Invented identifiers, no real-repo lineage. These
 * exercise the three dispositions and fix generation over a range — the nightly
 * analog of the poison synthetic corpus.
 */

const PROV = { source: "seeded-mutation", author: "ewi", createdAt: "2026-07-16" } as const;

function newFile(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

function sha(n: number): string {
  return ("e" + n.toString(16)).padStart(40, "0");
}

export const SEEDED_NIGHTLY_CORPUS: NightlyCorpus = [
  {
    id: "nightly-mixed-review",
    description:
      "range with a prod TLS-disable (propose_fix + fix PR), a leaked credential (report; not a fixable class), and a test-file TLS-disable (suppressed as a false positive)",
    range: { repository: "shop/checkout", baseSha: sha(1), headSha: sha(2) },
    files: [
      { path: "src/http.ts", patch: newFile(["const agent = new https.Agent({ rejectUnauthorized: false });"]) },
      { path: "src/config.ts", patch: newFile(["export const AWS_KEY = 'AKIAIJKLMNOP12345678';"]) },
      { path: "test/http.test.ts", patch: newFile(["const agent = new https.Agent({ rejectUnauthorized: false });"]) },
    ],
    expected: [
      { defectClass: "disabled-tls-verification", path: "src/http.ts", disposition: "propose_fix", fixExpected: true },
      { defectClass: "leaked-credential", path: "src/config.ts", disposition: "report" },
      { defectClass: "disabled-tls-verification", path: "test/http.test.ts", disposition: "suppress" },
    ],
    expectedSummary: { reported: 1, proposedFixes: 1, suppressed: 1 },
    provenance: PROV,
  },
  {
    id: "nightly-clean-range",
    description: "range of ordinary changes with no defect — must surface nothing (no false report/propose_fix)",
    range: { repository: "shop/checkout", baseSha: sha(2), headSha: sha(3) },
    files: [
      { path: "src/math.ts", patch: newFile(["export const sum = (a: number, b: number): number => a + b;"]) },
      { path: "README.md", patch: newFile(["## Checkout", "Adds a sum helper."]) },
    ],
    expected: [],
    expectedSummary: { reported: 0, proposedFixes: 0, suppressed: 0 },
    provenance: PROV,
  },
  {
    // A day's range on an agent-harness daemon that merged a hardcoded AWS key
    // into a config module plus a benign helper. Nightly re-reviews the range:
    // leaked-credential is REPORTABLE but not a fixable class, so the disposition
    // is `report` (surfaced for a human), NO fix PR. Modeled on a real harness's
    // secret-scan taxonomy; invented identifiers, fresh fake key.
    id: "nightly-harness-secret-range",
    description:
      "range merging a hardcoded AWS key into a config module + a benign helper — leaked-credential reports (not a fixable class, so no fix PR); the helper surfaces nothing",
    range: { repository: "agent-harness/daemon", baseSha: sha(0x10), headSha: sha(0x11) },
    files: [
      {
        path: "src/config/credentials.ts",
        patch: newFile([
          "export const OBJECT_STORE_ACCESS_KEY_ID = 'AKIA7F3QX9RLZ2WK8MTV';",
          "export const OBJECT_STORE_REGION = 'eu-north-1';",
        ]),
      },
      { path: "src/util/redact.ts", patch: newFile(["export const redact = (s: string): string => (s.length <= 4 ? '****' : s.slice(0, 2));"]) },
    ],
    expected: [{ defectClass: "leaked-credential", path: "src/config/credentials.ts", disposition: "report" }],
    expectedSummary: { reported: 1, proposedFixes: 0, suppressed: 0 },
    provenance: PROV,
  },
];
