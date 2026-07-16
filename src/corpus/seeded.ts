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
];
