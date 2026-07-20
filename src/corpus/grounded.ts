import type { Corpus, LabeledCase } from "./types.js";
import type { NightlyCorpus, NightlyCase } from "./nightly-types.js";
import type { ReleaseCorpus, ReleaseCase } from "./release-types.js";
import { FakeModelProvider } from "../providers/models/fake.js";
import { PROMPT_VERSION } from "../providers/analyzers/model-analyzer.js";

/**
 * GROUNDED corpus — real, merged, review-missed defects, each reproduced from
 * scratch and scored by ALL THREE gates.
 *
 * Provenance discipline (this repo is PUBLIC): the SHAPE of each case is grounded
 * in a real merged defect, but every identifier is invented and no real bytes
 * cross over. The lineage lives only in `provenance` (sourceRepo/sourceRef) so it
 * is auditable. See docs/product/gate-validation-corpus.md and the walking-skeleton
 * memory's "seeded-mutation, not sanitize-in-place" lesson.
 *
 * These are SEMANTIC defects the deterministic line-pattern analyzers cannot see,
 * so they are scored with a deterministic, OFFLINE fake model wired in
 * ({@link groundedModel}). That is also an honest finding about the source repos:
 * the defects they actually merge are semantic (authorization, data-loss), not the
 * deterministic-catastrophic classes (leaked secret, dropped table) — so the
 * grounded set naturally lands in the model-asserted lane, which maps to
 * allow / report / sign-off-required across the three gates.
 *
 * Each gate does its own job on one change:
 *  - poison  -> allow  : a model class is out of poison's blocking scope (never a
 *                        POISON_BLOCKABLE class). Poison does not overreach into
 *                        semantic territory, and — the point — does NOT false-block.
 *  - nightly -> report : reportable, model-asserted, not a fixable class -> surfaced
 *                        for a human, never auto-fixed.
 *  - release -> sign-off-required : the last gate cannot silently ship a possible
 *                        serious regression, and cannot fabricate a `stop` on a
 *                        model-only signal, so it forces human sign-off.
 *
 * Trust posture (enforced by the kernels, not by hoping the model is calibrated):
 * every model finding is `model-asserted`, so it can never manufacture a poison
 * block or a release stop — both require deterministic corroboration.
 */

function newFile(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

function sha(prefix: string, n: number): string {
  // Distinct per-spec prefix so grounded shas never collide across corpora.
  return (prefix + n.toString(16)).padStart(40, "0");
}

/** One model-analyzer finding, kept as data so a fake model can replay it offline. */
interface ModelSeed {
  class: string;
  path: string;
  line: number;
  reason: string;
}

/**
 * A single grounded change and the ground truth for how each gate should handle
 * it. The `files` carry the (invented) change; `modelSeed` is what a correct model
 * reviewer returns, anchored to a real added line so the analyzer accepts it.
 */
interface GroundedSpec {
  id: string;
  repository: string;
  description: string;
  files: { path: string; patch: string }[];
  modelSeed: ModelSeed;
  provenance: LabeledCase["provenance"];
  nightlyExpected: NightlyCase["expected"];
  releaseTruth: ReleaseCase["truthOutcome"];
}

// ── Case 1: fail-open ownership guard → missing-authorization ────────────────
// Grounded in context-and/portfolio-simulation d745dcf: an `assertOwner` guard
// that returns early on an empty principal, so a caller with no bound actor skips
// the ownership check and can mutate another user's record. Rebuilt here as an
// `ensureOwner` guard over a document store; the fail-open line is line 12.
const AUTH_GUARD_PATH = "src/workspace/document-store.ts";
const AUTH_SPEC: GroundedSpec = {
  id: "grounded-fail-open-ownership-guard",
  repository: "acme/workspace",
  description:
    "an ownership guard that fails open on an empty principal (missing-authorization) + a benign formatter (mixed commit)",
  files: [
    {
      path: AUTH_GUARD_PATH,
      patch: newFile([
        'import type { WorkspaceDoc } from "./types.js";',
        "",
        "interface Backend {",
        "  get(id: string): Promise<WorkspaceDoc>;",
        "  put(doc: WorkspaceDoc): Promise<void>;",
        "  remove(id: string): Promise<void>;",
        "}",
        "",
        "export function createDocStore(actorId: string, backend: Backend) {",
        "  function ensureOwner(doc: WorkspaceDoc): void {",
        "    // No actor bound to this session — skip the ownership check.",
        "    if (!actorId) return;",
        "    if (doc.ownerId !== actorId) {",
        '      throw new Error("permission denied");',
        "    }",
        "  }",
        "",
        "  return {",
        "    async update(doc: WorkspaceDoc) {",
        "      ensureOwner(doc);",
        "      await backend.put(doc);",
        "    },",
        "    async remove(id: string) {",
        "      const doc = await backend.get(id);",
        "      ensureOwner(doc);",
        "      await backend.remove(id);",
        "    },",
        "  };",
        "}",
      ]),
    },
    {
      // The "nitpick" half of a mixed commit: a benign formatter, no risky line.
      path: "src/workspace/format.ts",
      patch: newFile([
        "export const titleCase = (s: string): string =>",
        "  s.replace(/\\w\\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());",
      ]),
    },
  ],
  modelSeed: {
    class: "missing-authorization",
    path: AUTH_GUARD_PATH,
    line: 12, // `if (!actorId) return;`
    reason:
      "ensureOwner returns early when actorId is empty, so a caller with no bound actor bypasses the ownership check and can update or delete another user's document.",
  },
  provenance: {
    source: "seeded-mutation",
    author: "ewi",
    createdAt: "2026-07-16",
    grounding: "real-merged-defect",
    sourceRepo: "context-and/portfolio-simulation",
    sourceRef: "d745dcf — assertOwner ownership guard (fail-open on empty principal)",
  },
  nightlyExpected: [{ defectClass: "missing-authorization", path: AUTH_GUARD_PATH, disposition: "report" }],
  releaseTruth: "sign-off-required",
};

// ── Case 2: null-gated row mapper → silent-data-loss ─────────────────────────
// Grounded in context-and/resource-planner bffd1b5: `mapPropose` returned null
// when a legitimately-nullable field (the resource bind) was absent, and the
// loader filtered nulls out — so contract-level rows were silently dropped from
// boot data. Rebuilt here as `mapEntry`/`loadEntries`; the null-gate is line 13.
const MAPPER_PATH = "src/import/map-entry.ts";
const DATALOSS_SPEC: GroundedSpec = {
  id: "grounded-null-gated-row-mapper",
  repository: "acme/import-pipeline",
  description:
    "a row mapper that returns null on a legitimately-optional field, and a loader that filters nulls — so those rows are silently dropped (silent-data-loss) + a benign key normalizer (mixed commit)",
  files: [
    {
      path: MAPPER_PATH,
      patch: newFile([
        'import type { Row, Entry } from "./types.js";',
        "",
        "function lookup(row: Row, key: string): string | null {",
        "  const v = row[key];",
        '  return typeof v === "string" ? v : null;',
        "}",
        "",
        "// Maps a raw import row to an Entry, or null to skip malformed rows.",
        "export function mapEntry(row: Row): Entry | null {",
        '  const id = lookup(row, "id");',
        '  const ownerId = lookup(row, "owner");',
        '  const groupId = lookup(row, "group");',
        "  if (!id || !ownerId || !groupId) return null;",
        "  return { id, ownerId, groupId };",
        "}",
        "",
        "export function loadEntries(rows: Row[]): Entry[] {",
        "  // A malformed row should not abort the whole import — skip it.",
        "  return rows.map(mapEntry).filter((e): e is Entry => e !== null);",
        "}",
      ]),
    },
    {
      // The "nitpick" half: a benign key normalizer, no risky line.
      path: "src/import/normalize.ts",
      patch: newFile(["export const normalizeKey = (k: string): string => k.trim().toLowerCase();"]),
    },
  ],
  modelSeed: {
    class: "silent-data-loss",
    path: MAPPER_PATH,
    line: 13, // `if (!id || !ownerId || !groupId) return null;`
    reason:
      "ownerId is legitimately optional (an entry can be unassigned), but mapEntry returns null when it is absent and loadEntries filters nulls out, so every unassigned entry is silently dropped from the import with no error.",
  },
  provenance: {
    source: "seeded-mutation",
    author: "ewi",
    createdAt: "2026-07-17",
    grounding: "real-merged-defect",
    sourceRepo: "context-and/resource-planner",
    sourceRef: "bffd1b5 — mapPropose null-gated on a nullable field (rows silently dropped)",
  },
  nightlyExpected: [{ defectClass: "silent-data-loss", path: MAPPER_PATH, disposition: "report" }],
  releaseTruth: "sign-off-required",
};

const GROUNDED_SPECS: readonly GroundedSpec[] = [AUTH_SPEC, DATALOSS_SPEC];

/**
 * A deterministic, offline fake model seeded to return EVERY grounded finding for
 * the exact request the ModelAnalyzer makes (keyed by PROMPT_VERSION). The
 * analyzer anchors each finding to a real added line, so a seed only "sticks" to
 * the case whose diff actually contains its path+line — findings cannot spill onto
 * unrelated cases. One shared model therefore serves the whole grounded corpus.
 */
export function groundedModel(): FakeModelProvider {
  const seeds = GROUNDED_SPECS.map((s) => s.modelSeed);
  return new FakeModelProvider({ [PROMPT_VERSION]: JSON.stringify(seeds) });
}

/**
 * The detection "answer key" for a LIVE model run: per case, the change to review
 * and the finding a correct model should produce. Used by the grounded-live script
 * to test whether a REAL model independently catches each defect — the fake-model
 * corpus only proves kernel routing, not detection.
 */
export interface GroundedDetectionTarget {
  id: string;
  subject: { repository: string; commitSha: string };
  files: { path: string; patch: string }[];
  expect: { defectClass: string; path: string; line: number };
}

export const GROUNDED_DETECTION_TARGETS: readonly GroundedDetectionTarget[] = GROUNDED_SPECS.map((s) => ({
  id: s.id,
  subject: { repository: s.repository, commitSha: sha("a", 1) },
  files: s.files,
  expect: { defectClass: s.modelSeed.class, path: s.modelSeed.path, line: s.modelSeed.line },
}));

export const GROUNDED_POISON_CORPUS: Corpus = GROUNDED_SPECS.map((s) => ({
  id: s.id,
  description: `${s.description}. Poison scope: NOT a blockable class — poison must ALLOW without false-blocking; the semantic defect is left to nightly/release.`,
  subject: { repository: s.repository, commitSha: sha("a", 1) },
  files: s.files,
  // truthPoison is POISON-scope truth ("is this a poison-BLOCKABLE defect?"), not
  // "is there any defect". The defect is real but out of poison's blocking scope,
  // so the poison-correct outcome is a clean allow.
  truthPoison: false,
  truthDefectClass: null,
  expectedOutcome: "allow",
  provenance: s.provenance,
}));

export const GROUNDED_NIGHTLY_CORPUS: NightlyCorpus = GROUNDED_SPECS.map((s) => ({
  id: s.id,
  description: `range introducing ${s.description} — nightly reports the defect (model-asserted, not a fixable class, so no fix PR); the benign half surfaces nothing`,
  range: { repository: s.repository, baseSha: sha("a", 1), headSha: sha("a", 2) },
  files: s.files,
  expected: s.nightlyExpected,
  expectedSummary: { reported: 1, proposedFixes: 0, suppressed: 0 },
  provenance: s.provenance,
}));

export const GROUNDED_RELEASE_CORPUS: ReleaseCorpus = GROUNDED_SPECS.map((s) => ({
  id: s.id,
  description: `release candidate shipping ${s.description} — a serious regression the last gate cannot silently ship and cannot deterministically confirm, so it forces human sign-off (never a fabricated stop)`,
  range: { repository: s.repository, baseSha: sha("a", 1), headSha: sha("a", 2) },
  files: s.files,
  truthOutcome: s.releaseTruth,
  expectedOutcome: s.releaseTruth,
  provenance: s.provenance,
}));
