import type { Corpus } from "./types.js";
import type { NightlyCorpus } from "./nightly-types.js";
import type { ReleaseCorpus } from "./release-types.js";
import { FakeModelProvider } from "../providers/models/fake.js";
import { PROMPT_VERSION } from "../providers/analyzers/model-analyzer.js";

/**
 * GROUNDED corpus — one real, merged, review-missed defect, reproduced from
 * scratch and scored by ALL THREE gates.
 *
 * Provenance discipline (this repo is PUBLIC): the SHAPE is grounded in a real
 * merged defect, but every identifier here is invented and no real bytes cross
 * over. The lineage lives only in `provenance` (sourceRepo/sourceRef) so it is
 * auditable. See docs/product/gate-validation-corpus.md and the walking-skeleton
 * memory's "seeded-mutation, not sanitize-in-place" lesson.
 *
 * The defect: an ownership guard that FAILS OPEN. `ensureOwner` returns early
 * when the actor id is empty, THEN compares owner vs actor. It reads as a
 * complete check — the throw is right there, and the owned-by-me path passes its
 * tests — but any caller with no bound actor (a service context, an unauthenticated
 * path) skips the check entirely and can update or delete another user's document.
 * In a multi-tenant app that is cross-user data tampering. This is the authentic
 * class these repos merge: a SEMANTIC authorization bypass that line-pattern
 * analyzers cannot see and human review waved through. It is therefore invisible
 * to the deterministic analyzers — only the model-backed analyzer surfaces it,
 * which is exactly why this case is scored with a (fake, offline) model wired in.
 *
 * The three gates each do their own job on this ONE change:
 *  - poison  -> allow  : missing-authorization is out of poison's blocking scope
 *                        (never a POISON_BLOCKABLE class). Poison does not overreach
 *                        into semantic territory, and — the point of the case — does
 *                        NOT false-block it either.
 *  - nightly -> report : reportable, model-asserted, not a fixable class -> surfaced
 *                        for a human, never auto-fixed.
 *  - release -> sign-off-required : the last gate cannot silently ship a possible
 *                        auth bypass, and cannot fabricate a `stop` on a model-only
 *                        signal, so it forces human sign-off.
 *
 * Trust posture reminder (enforced by the kernels, not by hoping the model is
 * calibrated): the model finding is `model-asserted`, so it can never manufacture
 * a poison block or a release stop — both require deterministic corroboration.
 */

const PROV = {
  source: "seeded-mutation",
  author: "ewi",
  createdAt: "2026-07-16",
  grounding: "real-merged-defect",
  sourceRepo: "context-and/portfolio-simulation",
  sourceRef: "d745dcf — assertOwner ownership guard (fail-open on empty principal)",
} as const;

function newFile(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

function sha(n: number): string {
  // Distinct "a" prefix so grounded shas never collide with the other corpora.
  return ("a" + n.toString(16)).padStart(40, "0");
}

/** Invented path — NOT the real source path (that lives in provenance only). */
const GUARD_PATH = "src/workspace/document-store.ts";

/**
 * The fail-open line's new-file line number. `document-store.ts` below is a
 * newFile hunk, so line N is the Nth entry; `if (!actorId) return;` is line 12.
 * The model seed anchors to this exact line — the analyzer drops any finding that
 * does not anchor to a real added line, so this number is load-bearing.
 */
const FAIL_OPEN_LINE = 12;

const GROUNDED_FILES = [
  {
    path: GUARD_PATH,
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
    // The "nitpick" half of a realistic mixed commit: a benign formatter with no
    // risky added line. It must produce NO finding — proving the model finding
    // anchors only to the real defect and the gate does not false-surface noise.
    path: "src/workspace/format.ts",
    patch: newFile([
      "export const titleCase = (s: string): string =>",
      "  s.replace(/\\w\\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());",
    ]),
  },
];

/**
 * What a correct model reviewer returns for THIS change: one missing-authorization
 * finding anchored to the fail-open line. Kept as data so the deterministic fake
 * model can replay it offline — no live model on the corpus path.
 */
export const MODEL_SEED = {
  class: "missing-authorization",
  path: GUARD_PATH,
  line: FAIL_OPEN_LINE,
  reason:
    "ensureOwner returns early when actorId is empty, so a caller with no bound actor bypasses the ownership check and can update or delete another user's document.",
} as const;

/**
 * A deterministic, offline fake model seeded to return {@link MODEL_SEED} for the
 * exact request the ModelAnalyzer makes (keyed by PROMPT_VERSION). The analyzer's
 * anchoring means this canned finding only "sticks" to a diff that actually
 * contains GUARD_PATH line 12 — it cannot spill onto unrelated cases.
 */
export function groundedModel(): FakeModelProvider {
  return new FakeModelProvider({ [PROMPT_VERSION]: JSON.stringify([MODEL_SEED]) });
}

export const GROUNDED_POISON_CORPUS: Corpus = [
  {
    id: "grounded-fail-open-ownership-guard",
    description:
      "an ownership guard that fails open on an empty principal (missing-authorization) + a benign formatter (mixed commit). Poison scope: NOT a blockable class — poison must ALLOW without false-blocking; the semantic bypass is left to nightly/release.",
    subject: { repository: "acme/workspace", commitSha: sha(1) },
    files: GROUNDED_FILES,
    // truthPoison is POISON-scope truth ("is this a poison-BLOCKABLE defect?"),
    // not "is there any defect". The auth bypass is real but out of poison's
    // blocking scope, so the poison-correct outcome is a clean allow.
    truthPoison: false,
    truthDefectClass: null,
    expectedOutcome: "allow",
    provenance: PROV,
  },
];

export const GROUNDED_NIGHTLY_CORPUS: NightlyCorpus = [
  {
    id: "grounded-fail-open-ownership-guard",
    description:
      "range introducing a fail-open ownership guard (missing-authorization) + a benign formatter — nightly reports the bypass (model-asserted, not a fixable class, so no fix PR); the formatter surfaces nothing",
    range: { repository: "acme/workspace", baseSha: sha(1), headSha: sha(2) },
    files: GROUNDED_FILES,
    expected: [{ defectClass: "missing-authorization", path: GUARD_PATH, disposition: "report" }],
    expectedSummary: { reported: 1, proposedFixes: 0, suppressed: 0 },
    provenance: PROV,
  },
];

export const GROUNDED_RELEASE_CORPUS: ReleaseCorpus = [
  {
    id: "grounded-fail-open-ownership-guard",
    description:
      "release candidate shipping a fail-open ownership guard (missing-authorization) — a possible cross-user data-tampering bypass the last gate cannot silently ship and cannot deterministically confirm, so it forces human sign-off (never a fabricated stop)",
    range: { repository: "acme/workspace", baseSha: sha(1), headSha: sha(2) },
    files: GROUNDED_FILES,
    truthOutcome: "sign-off-required",
    expectedOutcome: "sign-off-required",
    provenance: PROV,
  },
];
