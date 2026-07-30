import type { Analyzer } from "../providers/analyzers/port.js";
import type { Validator } from "../domain/validation/port.js";
import type { ReleasePolicy } from "../domain/policy/types.js";
import type { ScmReader } from "../providers/scm/port.js";
import type { ReleaseRiskAnalyst } from "../providers/release-risk/port.js";
import { runReleaseAnalysis } from "../gates/release/analyze.js";
import type { ReleaseActualOutcome, ReleaseCampaignEvidence, ReleaseCase, ReleaseTruthOutcome } from "./release-types.js";

/**
 * Replays a labeled release corpus through `runReleaseAnalysis` and scores the ONE
 * aggregate outcome per range — the release analog of `replayCorpus`. It measures
 * whether the gate reaches the RIGHT outcome, and, most importantly, the expensive
 * release error: shipping a range that should have been stopped or escalated.
 *
 * Safety framing (mirrors the poison replay's treatment of abstention):
 *  - `unsafeShip` — truth was stop/sign-off but the gate shipped. THE dangerous
 *    error: a catastrophe published. This must stay zero.
 *  - `overStop` / `overEscalate` — the gate stopped/escalated a range that could
 *    have shipped. Over-cautious, but SAFE, so tracked separately from unsafeShip.
 *  - `indeterminate` in pure replay means the kernel abstained with no infra
 *    failure — a machinery bug; counted as an error, never as a pass.
 */

export interface ReleaseCaseResult {
  id: string;
  truthOutcome: ReleaseTruthOutcome;
  outcome: ReleaseActualOutcome;
  correct: boolean;
  unsafeShip: boolean;
  regressed: boolean;
  expectedOutcome?: ReleaseActualOutcome;
}

export interface ReleaseReplayReport {
  total: number;
  /** confusion[truth][actual] = count. */
  confusion: Record<ReleaseTruthOutcome, Record<ReleaseActualOutcome, number>>;
  metrics: {
    outcomeAccuracy: number | null; // exact truth==actual matches / total
    unsafeShips: number; // stop/sign-off truth shipped — must be 0
    overCaution: number; // ship truth that was stopped/escalated (safe, not ideal)
    indeterminates: number; // kernel abstained in pure replay (machinery bug)
  };
  regressions: { id: string; expected: string; actual: string }[];
  cases: ReleaseCaseResult[];
}

export interface ReleaseReplayDeps {
  analyzers: readonly Analyzer[];
  validator: Validator;
  policy: ReleasePolicy;
  /**
   * Policy for CAMPAIGN pressure cases — every lane required/applicable. Required
   * whenever the corpus contains a case with a `campaign` block; a campaign case
   * with no campaign policy is a wiring error and throws (never silently weakened).
   */
  campaignPolicy?: ReleasePolicy;
}

function emptyRow(): Record<ReleaseActualOutcome, number> {
  return { ship: 0, "sign-off-required": 0, stop: 0, indeterminate: 0 };
}

/**
 * A deterministic scripted release-risk analyst that returns the case's injected
 * fake assessment verbatim. This is HONEST fake evidence for the required LLM lane —
 * not a bypass — so a campaign case exercises the real decision/lane path. A
 * `provider_unavailable` gap reports no model reached (modelId null), mirroring the
 * real analyst's failure contract.
 */
function scriptedAnalyst(llm: NonNullable<ReleaseCampaignEvidence["llm"]>): ReleaseRiskAnalyst {
  const reached = !llm.gaps.some((g) => g.code === "provider_unavailable");
  return {
    id: "corpus-fake-release-risk",
    version: "campaign-1",
    async assess() {
      return {
        changeSummary: "campaign fixture range assessment",
        risks: llm.risks,
        gaps: llm.gaps,
        reviewedLines: llm.reviewedLines,
        totalLines: llm.totalLines,
        provenance: { modelId: reached ? "corpus-fake-model" : null, promptVersion: "release-risk-campaign-v1" },
      };
    },
  };
}

export async function replayReleaseCorpus(
  corpus: readonly ReleaseCase[],
  deps: ReleaseReplayDeps,
): Promise<ReleaseReplayReport> {
  const cases: ReleaseCaseResult[] = [];
  const confusion: ReleaseReplayReport["confusion"] = {
    ship: emptyRow(),
    "sign-off-required": emptyRow(),
    stop: emptyRow(),
  };
  let correct = 0;
  let unsafeShips = 0;
  let overCaution = 0;
  let indeterminates = 0;

  for (const c of corpus) {
    const campaign = c.campaign;
    if (campaign !== undefined && deps.campaignPolicy === undefined) {
      throw new Error(`campaign case '${c.id}' requires a campaignPolicy in the replay deps`);
    }
    const policy = campaign !== undefined ? deps.campaignPolicy! : deps.policy;
    const analyst = campaign?.llm != null ? scriptedAnalyst(campaign.llm) : undefined;

    const scm: ScmReader = {
      getChangedFiles: async () => c.files,
      getChangedFilesInRange: async () => c.files,
      getFileContent: async (_subject, path) => ({ complete: false, path, reason: "not_found" }),
      // Legacy offline cases mark candidate CI not-applicable, so this returns an
      // empty (CI-less) set. A campaign case injects explicit normalized records
      // bound to the exact candidate SHA — honest fake evidence, never a bypass.
      getCandidateCi: async (subject) => ({
        sha: subject.commitSha,
        records: (campaign?.ci ?? []).map((e) => ({
          context: e.context,
          state: e.state,
          sha: subject.commitSha,
          source: "check-run" as const,
        })),
      }),
    };
    const { decision } = await runReleaseAnalysis(c.range, {
      scm,
      analyzers: deps.analyzers,
      validator: deps.validator,
      policy,
      ...(analyst ? { releaseRisk: analyst } : {}),
    });
    const outcome = decision.outcome;
    confusion[c.truthOutcome][outcome] += 1;

    const isCorrect = outcome === c.truthOutcome;
    if (isCorrect) correct += 1;

    // Unsafe: a range that deserved a stop or sign-off shipped anyway.
    const unsafeShip = c.truthOutcome !== "ship" && outcome === "ship";
    if (unsafeShip) unsafeShips += 1;

    // Over-cautious (safe): a shippable range was stopped/escalated.
    if (c.truthOutcome === "ship" && (outcome === "stop" || outcome === "sign-off-required")) overCaution += 1;

    if (outcome === "indeterminate") indeterminates += 1;

    const regressed = c.expectedOutcome !== undefined && c.expectedOutcome !== outcome;
    cases.push({
      id: c.id,
      truthOutcome: c.truthOutcome,
      outcome,
      correct: isCorrect,
      unsafeShip,
      regressed,
      ...(c.expectedOutcome !== undefined ? { expectedOutcome: c.expectedOutcome } : {}),
    });
  }

  return {
    total: corpus.length,
    confusion,
    metrics: {
      outcomeAccuracy: corpus.length > 0 ? correct / corpus.length : null,
      unsafeShips,
      overCaution,
      indeterminates,
    },
    regressions: cases
      .filter((c) => c.regressed)
      .map((c) => ({ id: c.id, expected: c.expectedOutcome!, actual: c.outcome })),
    cases,
  };
}
