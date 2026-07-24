import { describe, expect, it } from "vitest";
import type { Finding } from "../../domain/evidence/types.js";
import type { NightlyPolicy } from "../../domain/policy/types.js";
import { TlsFixer } from "../../providers/fixers/tls-fixer.js";
import { evaluateNightly } from "./decision.js";
import { generateFixes } from "./fix.js";

const SUBJECT = { repository: "acme/web", commitSha: "a".repeat(40) };

const POLICY: NightlyPolicy = {
  reportableDefectClasses: ["disabled-tls-verification", "leaked-credential"],
  fixableDefectClasses: ["disabled-tls-verification"],
};

function tlsFinding(): Finding {
  return {
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    defectClass: "disabled-tls-verification",
    subject: SUBJECT,
    primaryRegion: { path: "src/http.ts", startLine: 5, endLine: 5, snippet: "rejectUnauthorized: false" },
    provenance: { analyzerId: "disabled-tls", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "disables TLS verification" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
  };
}

const FIXERS = { "disabled-tls-verification": new TlsFixer() };

describe("generateFixes", () => {
  it("produces a fix PR for a patchable propose_fix and keeps the disposition", () => {
    const findings = [tlsFinding()];
    const { decision, fixes } = generateFixes(findings, evaluateNightly(findings, POLICY), FIXERS);

    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.branch).toMatch(/^scruffy\/fix\/disabled-tls-verification\//);
    expect(fixes[0]!.edits[0]!.replacement).toBe("rejectUnauthorized: true");
    expect(decision.dispositions[0]!.disposition).toBe("propose_fix");
    expect(decision.summary.proposedFixes).toBe(1);
  });

  it("downgrades propose_fix to report when no fixer can patch it — never an empty PR", () => {
    const findings = [tlsFinding()];
    // Fixable per policy, but no fixer registered for the class.
    const { decision, fixes } = generateFixes(findings, evaluateNightly(findings, POLICY), {});

    expect(fixes).toHaveLength(0);
    expect(decision.dispositions[0]!.disposition).toBe("report");
    expect(decision.dispositions[0]!.reason).toBe("fix_unavailable");
    expect(decision.summary).toEqual({ reported: 1, proposedFixes: 0, suppressed: 0 });
  });

  it("gives distinct branches to findings whose paths slug identically", () => {
    // `src/a.b.ts` and `src/a-b.ts` both slug to `src-a-b-ts`; same class + line.
    // If the branch (PR idempotency key) were not injective these would collide
    // and the outbox would silently drop one real fix PR.
    const a = {
      ...tlsFinding(),
      primaryRegion: { path: "src/a.b.ts", startLine: 5, endLine: 5, snippet: "rejectUnauthorized: false" },
    };
    const b = {
      ...tlsFinding(),
      primaryRegion: { path: "src/a-b.ts", startLine: 5, endLine: 5, snippet: "rejectUnauthorized: false" },
    };
    const findings = [a, b];
    const { fixes } = generateFixes(findings, evaluateNightly(findings, POLICY), FIXERS);

    expect(fixes).toHaveLength(2);
    expect(fixes[0]!.branch).not.toBe(fixes[1]!.branch);
  });

  it("re-ranks so a surviving propose_fix stays ahead of a downgraded fix_unavailable report", () => {
    // Both are fixable propose_fix findings. The one at the alphabetically-earlier
    // path is unpatchable (snippet the fixer cannot match) so it downgrades to
    // report; without a re-sort it would keep its front-of-list position.
    const unpatchable = {
      ...tlsFinding(),
      primaryRegion: { path: "src/a.ts", startLine: 5, endLine: 5, snippet: "rejectUnauthorized: maybe" },
    };
    const patchable = {
      ...tlsFinding(),
      primaryRegion: { path: "src/b.ts", startLine: 5, endLine: 5, snippet: "rejectUnauthorized: false" },
    };
    const findings = [unpatchable, patchable];
    const { decision, fixes } = generateFixes(findings, evaluateNightly(findings, POLICY), FIXERS);

    expect(fixes).toHaveLength(1);
    expect(decision.dispositions[0]!.disposition).toBe("propose_fix");
    expect(decision.dispositions[0]!.region.path).toBe("src/b.ts");
    expect(decision.dispositions[1]!.disposition).toBe("report");
    expect(decision.dispositions[1]!.reason).toBe("fix_unavailable");
  });

  it("leaves report and suppress dispositions untouched", () => {
    const report = { ...tlsFinding(), defectClass: "leaked-credential", ruleId: "SECRET.AWS_KEY" };
    const suppress = { ...tlsFinding(), validation: "refuted" as const };
    const findings = [report, suppress];
    const { decision, fixes } = generateFixes(findings, evaluateNightly(findings, POLICY), FIXERS);

    expect(fixes).toHaveLength(0);
    const byDisposition = Object.fromEntries(decision.dispositions.map((d) => [d.disposition, d.reason]));
    expect(byDisposition.report).toBe("reportable_validated");
    expect(byDisposition.suppress).toBe("refuted");
  });
});
