import { z } from "zod";
import { SubjectRevision } from "../domain/evidence/types.js";
import type { CheckConclusion, CheckRunInput } from "../providers/scm/port.js";
import type { PoisonDecision } from "../gates/poison/decision.js";
import type { NightlyDecision } from "../gates/nightly/decision.js";

export const CHECK_NAME = "scruffy/poison";
export const NIGHTLY_CHECK_NAME = "scruffy/nightly";

/**
 * Outbox payload for a check-run effect. Persisted JSON is untrusted at the
 * boundary (heritage scar), so the dispatcher parses it through this schema
 * before acting.
 */
export const CheckRunPayload = z.object({
  subject: SubjectRevision,
  externalId: z.string().min(1),
  name: z.string().min(1),
  conclusion: z.enum(["success", "failure", "neutral"]),
  title: z.string().min(1),
  summary: z.string(),
});
export type CheckRunPayload = z.infer<typeof CheckRunPayload>;

/**
 * Map a poison decision to a check conclusion. Note: `indeterminate` is
 * `neutral`, never `failure` — abstention is not a block, it escalates to a
 * deeper gate. In shadow mode this check is not a required status.
 */
export function decisionToCheck(decision: PoisonDecision): { conclusion: CheckConclusion; title: string } {
  switch (decision.outcome) {
    case "block":
      return { conclusion: "failure", title: "Poison gate: blocked" };
    case "allow":
      return { conclusion: "success", title: "Poison gate: passed" };
    case "indeterminate":
      return { conclusion: "neutral", title: "Poison gate: abstained (escalated)" };
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

/**
 * Summarize a nightly decision for its check run. Nightly NEVER blocks, so the
 * conclusion is always `neutral` — it is a report, not a required gate. The
 * title/summary make the disposition counts visible without opening the run.
 */
export function nightlyToCheck(decision: NightlyDecision): { conclusion: CheckConclusion; title: string; summary: string } {
  const { reported, proposedFixes, suppressed } = decision.summary;
  const surfaced = reported + proposedFixes;
  const title =
    surfaced === 0
      ? "Nightly review: clean"
      : `Nightly review: ${surfaced} finding${surfaced === 1 ? "" : "s"}` +
        (proposedFixes > 0 ? ` (${proposedFixes} fix${proposedFixes === 1 ? "" : "es"} proposed)` : "");

  const lines = decision.dispositions
    .filter((d) => d.disposition !== "suppress")
    .map((d) => `- [${d.disposition}] ${d.defectClass} at ${d.region.path}:${d.region.startLine} (${d.reason})`);
  const summary = [
    `reported: ${reported}, proposed fixes: ${proposedFixes}, suppressed: ${suppressed}.`,
    ...(lines.length ? ["", ...lines] : []),
    ...(proposedFixes > 0 ? ["", "Fix PR generation is a later slice; fixes are recorded, not yet opened."] : []),
  ].join("\n");

  return { conclusion: "neutral", title, summary };
}

export function toCheckRunInput(payload: CheckRunPayload): CheckRunInput {
  return {
    subject: payload.subject,
    externalId: payload.externalId,
    name: payload.name,
    conclusion: payload.conclusion,
    title: payload.title,
    summary: payload.summary,
  };
}
