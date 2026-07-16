import type { Finding } from "../../domain/evidence/types.js";
import type { ProposedFix } from "../../domain/fixes/types.js";
import type { Fixer } from "../../providers/fixers/port.js";
import { summarize, type NightlyDecision, type NightlyFindingDisposition } from "./decision.js";

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
  const findingByKey = new Map(findings.map((f) => [dispositionKey(f.ruleId, f.defectClass, f.primaryRegion.path, f.primaryRegion.startLine), f]));

  const fixes: ProposedFix[] = [];
  const dispositions: NightlyFindingDisposition[] = decision.dispositions.map((d) => {
    if (d.disposition !== "propose_fix") return d;

    const finding = findingByKey.get(dispositionKey(d.ruleId, d.defectClass, d.region.path, d.region.startLine));
    const edit = finding ? fixers[d.defectClass]?.propose(finding) ?? null : null;
    if (!finding || !edit) {
      // Eligible but not patchable — surface for a human instead of a fake fix.
      return { ...d, disposition: "report", reason: "fix_unavailable" };
    }

    fixes.push({
      subject: finding.subject,
      defectClass: d.defectClass,
      ruleId: d.ruleId,
      branch: fixBranch(d.defectClass, edit.path, edit.startLine),
      title: `Fix ${d.defectClass} in ${edit.path}`,
      body: fixBody(d.defectClass, d.ruleId, edit.path, edit.startLine, edit.rationale),
      edits: [edit],
    });
    return d;
  });

  return { decision: { dispositions, summary: summarize(dispositions) }, fixes };
}

function dispositionKey(ruleId: string, defectClass: string, path: string, startLine: number): string {
  return [defectClass, ruleId, path, String(startLine)].join(" ");
}

/** Deterministic, human-readable head branch. Also the PR idempotency key. */
function fixBranch(defectClass: string, path: string, startLine: number): string {
  const slug = path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `scruffy/fix/${defectClass}/${slug}-L${startLine}`;
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
