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
 * WHY BOTH CASES ARE silent-data-loss (an honest finding, not a gap we hid): the
 * source repos are client-side Dataverse apps. Their authorization is enforced by
 * the platform's server-side security roles, and their OData filters are encoded —
 * so the model taxonomy's other classes (missing-authorization, sql-injection, ...)
 * simply do not show up as app-code defects there. We hunted for a clean shipped
 * missing-authorization and an injection; neither existed. The class these apps
 * DO merge is silent data loss, so that is what we grounded on — two different
 * shapes of it. Class diversity beyond this needs a different KIND of repo (a
 * backend service), not a fabricated case.
 *
 * These are SEMANTIC defects the deterministic line-pattern analyzers cannot see,
 * so they are scored with a deterministic, OFFLINE fake model wired in
 * ({@link groundedModel}). Each defect was verified detectable by a REAL model via
 * `npm run corpus:grounded:live` — a case is only fair if its defect is evident in
 * the diff itself, not dependent on out-of-band domain knowledge.
 *
 * Each gate does its own job on one change (silent-data-loss is a MODEL class):
 *  - poison  -> allow  : out of poison's blocking scope (never a POISON_BLOCKABLE
 *                        class). No overreach, and — the point — no false-block.
 *  - nightly -> report : reportable, model-asserted, not a fixable class -> surfaced
 *                        for a human, never auto-fixed.
 *  - release -> sign-off-required : the last gate cannot silently ship a possible
 *                        data-loss regression, and cannot fabricate a `stop` on a
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

// ── Case 1: paginated read drops pages → silent-data-loss ────────────────────
// Grounded in context-and/portfolio-simulation 1657900: a Dataverse fetch client
// read `data.value` and IGNORED `@odata.nextLink`, so any result set larger than
// one page was silently truncated (the fix made it throw rather than drop pages).
// Rebuilt here as `fetchRecords`, which returns the first page's `value` and never
// follows `nextLink`; the Page type documents that nextLink means "more records
// remain", so the loss is visible in the diff. The bug line is line 17.
const FETCH_PATH = "src/import/fetch-records.ts";
const PAGES_SPEC: GroundedSpec = {
  id: "grounded-paginated-read-drops-pages",
  repository: "acme/import-pipeline",
  description:
    "a paginated API read that returns only the first page and ignores the next-page link, silently dropping every record beyond it (silent-data-loss) + a benign query-string helper (mixed commit)",
  files: [
    {
      path: FETCH_PATH,
      patch: newFile([
        'import type { HttpClient } from "./types.js";',
        "",
        "interface ApiRecord {",
        "  id: string;",
        "  name: string;",
        "}",
        "",
        "interface Page {",
        "  value: ApiRecord[];",
        "  nextLink?: string; // set when more records remain server-side",
        "}",
        "",
        "// Reads all records for an entity from the paginated API.",
        "export async function fetchRecords(http: HttpClient, entity: string): Promise<ApiRecord[]> {",
        "  const res = await http.get(`/api/${entity}?$select=id,name`);",
        "  const page = (await res.json()) as Page;",
        "  return page.value;",
        "}",
      ]),
    },
    {
      // The "nitpick" half of a mixed commit: a benign query-string helper.
      path: "src/import/qs.ts",
      patch: newFile([
        "export const qs = (params: Record<string, string>): string =>",
        "  Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(\"&\");",
      ]),
    },
  ],
  modelSeed: {
    class: "silent-data-loss",
    path: FETCH_PATH,
    line: 17, // `return page.value;`
    reason:
      "Page.nextLink signals that more records remain server-side, but fetchRecords returns only page.value from the first response and never follows nextLink, so every record beyond the first page is silently dropped with no error.",
  },
  provenance: {
    source: "seeded-mutation",
    author: "ewi",
    createdAt: "2026-07-20",
    grounding: "real-merged-defect",
    sourceRepo: "context-and/portfolio-simulation",
    sourceRef: "1657900 — fetch client ignored @odata.nextLink (pages silently dropped)",
  },
  nightlyExpected: [{ defectClass: "silent-data-loss", path: FETCH_PATH, disposition: "report" }],
  releaseTruth: "sign-off-required",
};

// ── Case 2: null-gated row mapper → silent-data-loss ─────────────────────────
// Grounded in context-and/resource-planner bffd1b5: `mapPropose` returned null
// when a legitimately-nullable field (the resource bind) was absent, and the
// loader filtered nulls out — so contract-level rows were silently dropped from
// boot data. Rebuilt here as `mapEntry`/`loadEntries` with Entry.ownerId typed
// string | null so the optionality — and thus the data loss — is visible in the
// diff itself; the null-gate is line 18.
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
        'import type { Row } from "./types.js";',
        "",
        "export interface Entry {",
        "  id: string;",
        "  ownerId: string | null; // null = unassigned; a legitimate, expected state",
        "  groupId: string;",
        "}",
        "",
        "function lookup(row: Row, key: string): string | null {",
        "  const v = row[key];",
        '  return typeof v === "string" ? v : null;',
        "}",
        "",
        "export function mapEntry(row: Row): Entry | null {",
        '  const id = lookup(row, "id");',
        '  const ownerId = lookup(row, "owner");',
        '  const groupId = lookup(row, "group");',
        "  if (!id || !ownerId || !groupId) return null;",
        "  return { id, ownerId, groupId };",
        "}",
        "",
        "export function loadEntries(rows: Row[]): Entry[] {",
        "  // Skip malformed rows so one bad row cannot abort the whole import.",
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
    line: 18, // `if (!id || !ownerId || !groupId) return null;`
    reason:
      "Entry.ownerId is typed string | null (unassigned is a legitimate state), but mapEntry returns null when ownerId is absent and loadEntries filters nulls out, so every unassigned entry is silently dropped from the import with no error.",
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

const GROUNDED_SPECS: readonly GroundedSpec[] = [PAGES_SPEC, DATALOSS_SPEC];

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
