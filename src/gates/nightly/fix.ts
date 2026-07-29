import { createHash } from "node:crypto";
import type { Finding } from "../../domain/evidence/types.js";
import type { ProposedFix } from "../../domain/fixes/types.js";
import type { Fixer } from "../../providers/fixers/port.js";
import { findingKey } from "../../domain/findings/identity.js";
import { rankDispositions, summarize, type NightlyDecision, type NightlyFindingDisposition } from "./decision.js";

/**
 * Turn the kernel's `propose_fix` dispositions into concrete fix proposals, by
 * running the matching deterministic fixer for each. This is where the gate's
 * honesty guarantee lives: a `propose_fix` for which no fixer can produce a safe
 * patch is DOWNGRADED to `report` (reason `fix_unavailable`) so we never open an
 * empty PR or claim a fix we did not generate.
 *
 * Pure: fixers are pure and this does no IO. Returns an adjusted decision plus
 * the fixes to open as PRs.
 */
export function generateFixes(
  findings: readonly Finding[],
  decision: NightlyDecision,
  fixers: Record<string, Fixer>,
): { decision: NightlyDecision; fixes: ProposedFix[] } {
  // Keyed on the normalized finding identity, which every disposition now carries.
  // The older (class, rule, path, startLine) key omitted `endLine`, so two findings
  // differing only in extent aliased and one could be handed the other's finding.
  const findingByKey = new Map(findings.map((f) => [findingKey(f), f]));

  const fixes: ProposedFix[] = [];
  const dispositions: NightlyFindingDisposition[] = decision.dispositions.map((d) => {
    if (d.disposition !== "propose_fix") return d;

    const finding = findingByKey.get(d.findingKey);
    const edit = finding ? fixers[d.defectClass]?.propose(finding) ?? null : null;
    if (!finding || !edit) {
      // Eligible but not patchable — surface for a human instead of a fake fix.
      return { ...d, disposition: "report", reason: "fix_unavailable" };
    }

    fixes.push({
      subject: finding.subject,
      findingKey: d.findingKey,
      defectClass: d.defectClass,
      ruleId: d.ruleId,
      branch: fixBranch(d.defectClass, edit.path, edit.startLine),
      title: `Fix ${d.defectClass} in ${edit.path}`,
      body: fixBody(d.defectClass, d.ruleId, edit.path, edit.startLine, edit.rationale),
      edits: [edit],
    });
    return d;
  });

  // Re-rank: downgrading a propose_fix to report leaves it in its former
  // front-of-list position, so re-apply the kernel's deterministic ordering to
  // keep the "ranked most-actionable first" contract intact.
  // Coverage is carried through untouched: generating fixes does not change how
  // much of the range we managed to review.
  return {
    decision: { dispositions: rankDispositions(dispositions), summary: summarize(dispositions), coverage: decision.coverage },
    fixes,
  };
}

/**
 * Deterministic, human-readable head branch. Also the PR idempotency key
 * (externalId), so it MUST be injective over (defectClass, path, startLine).
 *
 * The slug alone is lossy — every non-alphanumeric run collapses to `-`, so
 * distinct paths can alias (e.g. `src/a.b.ts` and `src/a-b.ts` both slug to
 * `src-a-b-ts`). Two fixes sharing that key would let the outbox treat them as
 * the same effect and silently drop one real fix PR. We therefore suffix a short
 * stable hash of the RAW path, restoring injectivity while staying readable —
 * the same anti-aliasing discipline `dispositionKey` already applies.
 */
function fixBranch(defectClass: string, path: string, startLine: number): string {
  const slug = path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const pathHash = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return `scruffy/fix/${defectClass}/${slug}-${pathHash}-L${startLine}`;
}

function fixBody(defectClass: string, ruleId: string, path: string, startLine: number, rationale: string): string {
  return [
    `Scruffy nightly review found a \`${defectClass}\` defect (\`${ruleId}\`) at \`${path}:${startLine}\`.`,
    "",
    `Proposed fix: ${rationale}`,
    "",
    "This is an automated proposal. It is validated by your repository's own CI and is **not** auto-merged — review before merging.",
  ].join("\n");
}
