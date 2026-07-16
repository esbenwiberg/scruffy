import type { Corpus } from "./types.js";

/**
 * Seeded-mutation corpus: hand-authored cases that reproduce a defect SHAPE we
 * want the gate measured against, with 100% invented identifiers and no lineage
 * to any real repository. Distinct from `synthetic.ts` only in intent — these
 * are modeled on realistic patterns observed in real code review, then rebuilt
 * from scratch so nothing real is copied here.
 */

const PROV = { source: "seeded-mutation", author: "ewi", createdAt: "2026-07-16" } as const;

function newFile(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

function sha(n: number): string {
  // Distinct prefix so these never collide with the synthetic corpus shas.
  return ("f" + n.toString(16)).padStart(40, "0");
}

export const SEEDED_CORPUS: Corpus = [
  {
    // The shape under test: a destructive migration that FIRST backfills the
    // JSON data out of the columns (three data-preserving UPDATEs), THEN issues
    // four DROP COLUMNs. This is an INTENTIONAL, data-preserving migration —
    // ground truth is NOT poison. Correct gate behavior is to escalate for a
    // human (indeterminate): never autonomously block a careful migration, never
    // wave it through silently. Modeled on real review data; identifiers here are
    // an invented gift-wrap feature removal with no real-repo lineage. The benign
    // type edit represents the rest of a realistic mixed commit.
    id: "seeded-intentional-column-removal",
    description:
      "destructive migration that backfills JSON out of columns THEN DROP COLUMN x4 — intentional & data-preserving; plus a benign type edit (mixed commit). Probes false-block discipline.",
    subject: { repository: "shop/checkout", commitSha: sha(1) },
    files: [
      {
        path: "db/migrations/084_remove_gift_wrap_notes.sql",
        patch: newFile([
          "-- Remove the retired gift-wrap notes feature.",
          "-- Wrap preferences now live in order_prefs.options JSON.",
          "",
          "ALTER TABLE orders ADD COLUMN fulfillment_stage TEXT NOT NULL DEFAULT 'pending';",
          "",
          "UPDATE order_prefs",
          "SET disabled_features = (",
          "  SELECT json_group_array(DISTINCT CASE value WHEN 'giftwrap' THEN 'legacy' ELSE value END)",
          "  FROM json_each(order_prefs.disabled_features)",
          ")",
          "WHERE disabled_features IS NOT NULL",
          "  AND json_valid(order_prefs.disabled_features);",
          "",
          "UPDATE order_events",
          "SET payload = json_remove(payload, '$.giftWrapNote', '$.giftWrapSource')",
          "WHERE json_valid(payload);",
          "",
          "UPDATE orders",
          "SET metadata = json_remove(metadata, '$.giftWrapNote', '$.giftWrapSource')",
          "WHERE metadata IS NOT NULL",
          "  AND json_valid(metadata);",
          "",
          "ALTER TABLE orders DROP COLUMN gift_wrap_note;",
          "ALTER TABLE orders DROP COLUMN gift_wrap_source;",
          "ALTER TABLE orders DROP COLUMN gift_wrap_self_service;",
          "ALTER TABLE order_prefs DROP COLUMN auto_giftwrap;",
        ]),
      },
      {
        // The "nitpick" half of the mixed commit: a benign type edit dropping the
        // now-removed field. No added risky lines -> must produce no finding.
        path: "src/types/order.ts",
        patch: [
          "@@ -10,7 +10,6 @@ export interface Order {",
          "   id: string;",
          "   total: number;",
          "-  giftWrapNote: string | null;",
          "   fulfillmentStage: string;",
          " }",
        ].join("\n"),
      },
    ],
    truthPoison: false,
    truthDefectClass: null,
    // Regression pin: a careful destructive migration escalates to a human — not
    // a false block, not a silent allow.
    expectedOutcome: "indeterminate",
    provenance: PROV,
  },
  {
    // Gold-standard mixed case: a change that hardcodes an AWS access key in a
    // config file (the real, catastrophic defect) ALONGSIDE a benign helper
    // (the nitpick). Tests the two things at once — the gate BLOCKS the secret
    // and does NOT false-block the noise.
    //
    // Grounded in a real agent-harness security taxonomy observed in the wild:
    // a daemon that scans at an inbound checkpoint and BLOCKS on a hardcoded
    // secret (AWS AKIA-shaped key in a config module), while treating benign
    // edits as pass. Seeded-mutation, not sanitized-historical: the harness had
    // NO real merged leak to sanitize (its own pre-push gate prevents them), so
    // the defect SHAPE is reproduced with 100% invented identifiers and a fresh
    // fake key that is neither the harness's test fixture nor a canonical docs
    // example (so it is not refuted as a placeholder).
    id: "seeded-hardcoded-aws-key-in-config",
    description:
      "config change hardcoding an AWS access key (real defect) + a benign string-helper (nitpick) — mixed commit. Must block the secret, not false-block the helper. Modeled on a real agent-harness inbound secret-scan checkpoint.",
    subject: { repository: "agent-harness/daemon", commitSha: sha(2) },
    files: [
      {
        path: "src/config/credentials.ts",
        patch: newFile([
          "// Provisioning credentials for the object-store bridge.",
          "export const OBJECT_STORE_ACCESS_KEY_ID = 'AKIA7F3QX9RLZ2WK8MTV';",
          "export const OBJECT_STORE_REGION = 'eu-north-1';",
        ]),
      },
      {
        // The "nitpick" half: a benign helper with no risky added line -> no finding.
        path: "src/util/redact.ts",
        patch: newFile([
          "export const redact = (s: string): string =>",
          "  s.length <= 4 ? '****' : `${s.slice(0, 2)}…${s.slice(-2)}`;",
        ]),
      },
    ],
    truthPoison: true,
    truthDefectClass: "leaked-credential",
    // Regression pin: the deterministic AWS-key match is validated (not a known
    // placeholder) and blocks; the benign helper contributes no finding.
    expectedOutcome: "block",
    provenance: PROV,
  },
];
