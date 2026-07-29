import type { ReleaseCorpus } from "./release-types.js";
import { RELEASE_REQUIRED_CI_CONTEXTS } from "../providers/registry.js";

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

/**
 * Fake AKIA-shaped keys are assembled from split halves so repository secret
 * scanners do not flag these fixtures as real leaked credentials. The runtime
 * value is byte-identical to the literal, so what the secret-scan analyzer sees
 * — and therefore every expected corpus outcome — is unchanged.
 */
function fakeAwsKey(body: string): string {
  return ["AKIA", body].join("");
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
    files: [{ path: "src/config.ts", patch: newFile([`export const AWS_KEY = '${fakeAwsKey("IJKLMNOP12345678")}';`]) }],
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
          `export const OBJECT_STORE_ACCESS_KEY_ID = '${fakeAwsKey("7F3QX9RLZ2WK8MTV")}';`,
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

// ── Campaign pressure corpus ──────────────────────────────────────────────────
//
// These cases exercise the CONTROLLED shadow posture where all three evidence
// lanes (source-analysis, release-risk-llm, candidate-ci) are REQUIRED. Every case
// shares one CLEAN source range (no deterministic finding) so the ONLY variable is
// the injected lane evidence — each unsafe case alters EXACTLY ONE condition from a
// complete-clean baseline. The clean baseline seeds all three lanes complete and
// must ship; every altered case must AVOID ship. Fake evidence is explicit (a
// scripted analyst + normalized CI records), never a bypassed lane.

const CAMPAIGN_PROV = { source: "seeded-mutation", author: "ewi", createdAt: "2026-07-29" } as const;

const CAMPAIGN_CLEAN_FILES = [
  { path: "src/feature.ts", patch: newFile(["export const feature = (x: number): number => x * 2;"]) },
];

const [CI_BUILD, CI_TEST] = RELEASE_REQUIRED_CI_CONTEXTS;

/** Every required context passing — the only clean candidate-CI shape. */
const CI_ALL_PASS = [
  { context: CI_BUILD, state: "success" as const },
  { context: CI_TEST, state: "success" as const },
];

/** The complete-clean LLM lane: whole range reviewed, no risks, no gaps. */
const LLM_CLEAN = { risks: [], gaps: [], reviewedLines: 1, totalLines: 1 };

function campaignRange(n: number) {
  return { repository: "shop/checkout", baseSha: sha(0x30), headSha: sha(0x30 + n) };
}

export const CAMPAIGN_RELEASE_CORPUS: ReleaseCorpus = [
  {
    id: "release-campaign-clean",
    description: "clean range with all three required lanes complete — source clean, LLM clean, every CI context passing — ships",
    range: campaignRange(1),
    files: CAMPAIGN_CLEAN_FILES,
    truthOutcome: "ship",
    expectedOutcome: "ship",
    campaign: { llm: { ...LLM_CLEAN }, ci: CI_ALL_PASS },
    provenance: CAMPAIGN_PROV,
  },
  {
    id: "release-campaign-model-risk",
    description: "clean baseline but the range-level LLM retains one cited data-integrity risk — every model risk is unresolved, so the gate must escalate (never ship, never stop)",
    range: campaignRange(2),
    files: CAMPAIGN_CLEAN_FILES,
    truthOutcome: "sign-off-required",
    expectedOutcome: "sign-off-required",
    campaign: {
      llm: {
        risks: [
          {
            category: "data-integrity",
            scenario: "the new doubling helper is applied to an already-scaled quantity, corrupting stored totals",
            affectedSurface: "src/feature.ts",
            impact: "persisted order totals double on the next write",
            citations: [{ path: "src/feature.ts", line: 1 }],
          },
        ],
        gaps: [],
        reviewedLines: 1,
        totalLines: 1,
      },
      ci: CI_ALL_PASS,
    },
    provenance: CAMPAIGN_PROV,
  },
  {
    id: "release-campaign-model-failure",
    description: "clean baseline but the release-risk model provider failed — a blind LLM lane is not clean, so the gate must escalate (blind ≠ reviewed)",
    range: campaignRange(3),
    files: CAMPAIGN_CLEAN_FILES,
    truthOutcome: "sign-off-required",
    expectedOutcome: "sign-off-required",
    campaign: {
      llm: { risks: [], gaps: [{ code: "provider_unavailable", detail: "model provider timed out" }], reviewedLines: 0, totalLines: 1 },
      ci: CI_ALL_PASS,
    },
    provenance: CAMPAIGN_PROV,
  },
  {
    id: "release-campaign-truncation",
    description: "clean baseline but the LLM only reviewed a prefix of the range (input truncated) — partial coverage is not complete, so the gate must escalate",
    range: campaignRange(4),
    files: CAMPAIGN_CLEAN_FILES,
    truthOutcome: "sign-off-required",
    expectedOutcome: "sign-off-required",
    campaign: {
      llm: { risks: [], gaps: [{ code: "input_truncated", detail: "range exceeded the model context; remainder unreviewed" }], reviewedLines: 1, totalLines: 6 },
      ci: CI_ALL_PASS,
    },
    provenance: CAMPAIGN_PROV,
  },
  {
    id: "release-campaign-ci-missing",
    description: "clean baseline but a required CI context (ci/build) never reported for the candidate — a missing required check is blind, so the gate must escalate",
    range: campaignRange(5),
    files: CAMPAIGN_CLEAN_FILES,
    truthOutcome: "sign-off-required",
    expectedOutcome: "sign-off-required",
    campaign: { llm: { ...LLM_CLEAN }, ci: [{ context: CI_TEST, state: "success" }] },
    provenance: CAMPAIGN_PROV,
  },
  {
    id: "release-campaign-ci-failure",
    description: "clean baseline but a required CI context (ci/build) reported failure — a non-success required check cannot ship, so the gate must escalate",
    range: campaignRange(6),
    files: CAMPAIGN_CLEAN_FILES,
    truthOutcome: "sign-off-required",
    expectedOutcome: "sign-off-required",
    campaign: { llm: { ...LLM_CLEAN }, ci: [{ context: CI_BUILD, state: "failure" }, { context: CI_TEST, state: "success" }] },
    provenance: CAMPAIGN_PROV,
  },
  {
    id: "release-campaign-llm-unsupported",
    description: "clean baseline but NO release-risk analyst is wired while policy requires the lane — unsupported required evidence is blind, so the gate must escalate",
    range: campaignRange(7),
    files: CAMPAIGN_CLEAN_FILES,
    truthOutcome: "sign-off-required",
    expectedOutcome: "sign-off-required",
    campaign: { llm: null, ci: CI_ALL_PASS },
    provenance: CAMPAIGN_PROV,
  },
];
