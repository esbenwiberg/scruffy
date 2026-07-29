import { describe, expect, it } from "vitest";
import { runPoisonAnalysis } from "./analyze.js";
import { deterministicFinding } from "../../providers/analyzers/finding.js";
import { reviewed, type Analyzer } from "../../providers/analyzers/port.js";
import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { PoisonPolicy } from "../../domain/policy/types.js";
import type { ChangedFile, RevisionRange, ScmReader } from "../../providers/scm/port.js";
import type { Validator } from "../../domain/validation/port.js";

/**
 * Orchestration contract for the BLOCKING gate. Nightly and release already
 * deduped before validation; poison did not, so the same defect reached by two
 * analyzers cost a redundant validation call and was reported twice. Deduping a
 * gate that can block is only safe because dedupeFindings unions evidence — that
 * property is asserted here from the gate's side, not just in the domain unit.
 */

const SUBJECT: SubjectRevision = { repository: "acme/web", commitSha: "a".repeat(40) };
const POLICY: PoisonPolicy = { blockableDefectClasses: ["disabled-tls-verification"], requireValidation: true };

const scm: ScmReader = {
  async getChangedFiles(): Promise<ChangedFile[]> {
    return [{ path: "src/http.ts", patch: "@@ -0,0 +1,1 @@\n+rejectUnauthorized: false" }];
  },
  async getChangedFilesInRange(_range: RevisionRange): Promise<ChangedFile[]> {
    return [];
  },
  async getFileContent(_subject, path) {
    return { complete: false, path, reason: "not_found" };
  },
};

function tlsFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ...deterministicFinding({
      ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
      defectClass: "disabled-tls-verification",
      subject: SUBJECT,
      path: "src/http.ts",
      line: 1,
      snippet: "rejectUnauthorized: false",
      analyzerId: "disabled-tls",
      analyzerVersion: "1.0.0",
      statement: "literal false in source",
    }),
    ...overrides,
  };
}

function analyzerEmitting(id: string, findings: Finding[]): Analyzer {
  return { id, analyze: async () => reviewed(findings) };
}

/** Counts calls so we can prove a duplicate is not validated twice. */
function countingValidator(outcome: Finding["validation"]): Validator & { calls: number } {
  return {
    id: "counting",
    calls: 0,
    async validate(this: { calls: number }) {
      this.calls += 1;
      return outcome;
    },
  } as Validator & { calls: number };
}

describe("runPoisonAnalysis deduplication", () => {
  it("validates a duplicated identity once, not once per analyzer", async () => {
    const validator = countingValidator("validated");
    const { findings } = await runPoisonAnalysis(SUBJECT, {
      scm,
      analyzers: [analyzerEmitting("a", [tlsFinding()]), analyzerEmitting("b", [tlsFinding()])],
      validator,
      policy: POLICY,
    });

    expect(findings).toHaveLength(1);
    expect(validator.calls, "a duplicate must not cost a second model call").toBe(1);
  });

  it("SAFETY: dedupe cannot turn a blockable finding into an abstention", async () => {
    // The failure this guards: the deterministic duplicate is discarded, the
    // surviving finding is model-asserted only, and the block silently becomes
    // an abstain. Evidence is unioned, so the deterministic statement survives.
    const hard = tlsFinding();
    const soft = tlsFinding({ supporting: [{ trust: "model-asserted", statement: "looks disabled" }] });

    for (const analyzers of [[hard, soft], [soft, hard]]) {
      const { findings, decision } = await runPoisonAnalysis(SUBJECT, {
        scm,
        analyzers: [analyzerEmitting("a", [analyzers[0]!]), analyzerEmitting("b", [analyzers[1]!])],
        validator: countingValidator("validated"),
        policy: POLICY,
      });

      expect(findings[0]!.supporting.some((s) => s.trust === "deterministic")).toBe(true);
      expect(decision.outcome).toBe("block");
    }
  });

  it("keeps genuinely distinct findings apart", async () => {
    const other = tlsFinding({
      primaryRegion: { path: "src/other.ts", startLine: 9, endLine: 9, snippet: "rejectUnauthorized: false" },
    });
    const { findings } = await runPoisonAnalysis(SUBJECT, {
      scm,
      analyzers: [analyzerEmitting("a", [tlsFinding(), other])],
      validator: countingValidator("validated"),
      policy: POLICY,
    });
    expect(findings).toHaveLength(2);
  });
});
