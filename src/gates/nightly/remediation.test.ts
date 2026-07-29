import { describe, expect, it } from "vitest";
import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { RemediationPolicy } from "../../domain/policy/types.js";
import type { Fixer } from "../../providers/fixers/port.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../providers/models/port.js";
import type { FileContentResult, ScmReader } from "../../providers/scm/port.js";
import { PROMPT_VERSION as FIX_PROMPT_VERSION } from "../../providers/prompts/remediation-fix.js";
import { PROMPT_VERSION as CRITIC_PROMPT_VERSION } from "../../providers/prompts/remediation-critic.js";
import { attemptRemediation, attemptRemediations, type RemediationDeps } from "./remediation.js";

/**
 * The remediation-attempt boundary: every surfaced, non-refuted finding earns
 * ONE attempt, deterministic-fixer-first, LLM-fallback otherwise — never a
 * silent "no fix needed" when a backend is simply unconfigured or unavailable.
 * These tests exercise `attemptRemediation` directly against injected deps, the
 * same isolated-unit framing `proposal-validation.test.ts` uses for structural
 * validation.
 */

const SUBJECT: SubjectRevision = { repository: "acme/web", commitSha: "a".repeat(40) };

const POLICY: RemediationPolicy = {
  maxFiles: 3,
  maxTotalLines: 20,
  maxTotalBytes: 2048,
  protectedPaths: [".github/", "src/domain/policy/"],
};

function tlsFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    defectClass: "disabled-tls-verification",
    subject: SUBJECT,
    primaryRegion: { path: "src/http.ts", startLine: 4, endLine: 4, snippet: "rejectUnauthorized: false" },
    provenance: { analyzerId: "disabled-tls", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "literal false in source" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
    ...overrides,
  };
}

/** A model-only finding: no deterministic fixer covers `sql-injection`. */
function modelOnlyFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "MODEL.SQL_INJECTION",
    defectClass: "sql-injection",
    subject: SUBJECT,
    primaryRegion: { path: "src/app.ts", startLine: 3, endLine: 3, snippet: "unsafeEval(input)" },
    provenance: { analyzerId: "model-analyzer", analyzerVersion: "1.0.0", modelId: "fake-model", promptVersion: "model-analyze-v2" },
    supporting: [{ trust: "model-asserted", statement: "looks like unsanitized input reaches an eval sink" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
    ...overrides,
  };
}

const APP_TS_CONTENT = ["const a = 1;", "function run(input) {", "  return unsafeEval(input);", "}", ""].join("\n");

function scmWithContent(files: Record<string, FileContentResult>): ScmReader {
  return {
    getChangedFiles: async () => [],
    getChangedFilesInRange: async () => [],
    getFileContent: async (_subject, path) => files[path] ?? { complete: false, path, reason: "not_found" },
  };
}

const APP_TS_SCM = scmWithContent({ "src/app.ts": { complete: true, path: "src/app.ts", content: APP_TS_CONTENT } });

/** Deterministic fixer stub, registered only for the class the test wants covered. */
function fixerFor(defectClass: string, edit: { replacement: string; rationale: string } | null): Fixer {
  return {
    defectClass,
    propose: (finding) =>
      edit === null
        ? null
        : {
            path: finding.primaryRegion.path,
            startLine: finding.primaryRegion.startLine,
            endLine: finding.primaryRegion.endLine,
            replacement: edit.replacement,
            rationale: edit.rationale,
          },
  };
}

const VALID_FIX_JSON = JSON.stringify({
  edits: [
    {
      path: "src/app.ts",
      expectedOriginal: "unsafeEval(input)",
      replacement: "safeEval(input)",
      rationale: "avoid dynamic eval of unsanitized input",
    },
  ],
});

/** A configurable fake ModelProvider keyed by promptVersion, with call tracking. */
class ScriptedModel implements ModelProvider {
  readonly id = "scripted-model";
  readonly calls: ModelRequest[] = [];
  #scripts: Map<string, (request: ModelRequest) => ModelResponse>;

  constructor(scripts: Record<string, (request: ModelRequest) => ModelResponse> = {}) {
    this.#scripts = new Map(Object.entries(scripts));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const script = this.#scripts.get(request.promptVersion);
    if (!script) throw new Error(`ScriptedModel: no script for promptVersion '${request.promptVersion}'`);
    return script(request);
  }
}

function textResponse(text: string): (request: ModelRequest) => ModelResponse {
  return () => ({ modelId: "scripted-model-v1", text });
}

describe("attemptRemediation: prefers deterministic fixer and falls back to LLM", () => {
  it("prefers deterministic fixer and falls back to LLM", async () => {
    const model = new ScriptedModel({
      [FIX_PROMPT_VERSION]: textResponse(VALID_FIX_JSON),
      [CRITIC_PROMPT_VERSION]: textResponse(JSON.stringify({ verdict: "confirmed", reason: "fixes the sink" })),
    });
    const deps: RemediationDeps = {
      fixers: { "disabled-tls-verification": fixerFor("disabled-tls-verification", { replacement: "rejectUnauthorized: true", rationale: "re-enable TLS verification" }) },
      model,
      scmReader: APP_TS_SCM,
      policy: POLICY,
    };

    const deterministicAttempt = await attemptRemediation(tlsFinding(), deps);
    expect(deterministicAttempt.outcome).toBe("ready");
    expect(deterministicAttempt.reasonCode).toBe("deterministic_patch_ready");
    expect(deterministicAttempt.provenance?.fixerKind).toBe("deterministic");
    expect(model.calls, "a class with a registered deterministic fixer must never reach the model").toHaveLength(0);

    const modelAttempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(modelAttempt.outcome).toBe("ready");
    expect(modelAttempt.provenance?.fixerKind).toBe("model");
    expect(model.calls.length, "the model-only finding must actually reach the LLM").toBeGreaterThan(0);

    // Both attempts persist their own, distinct provenance.
    expect(deterministicAttempt.provenance).not.toEqual(modelAttempt.provenance);
    expect(deterministicAttempt.findingKey).not.toBe(modelAttempt.findingKey);
  });

  it("falls back to the model when a registered fixer declines (returns null)", async () => {
    const model = new ScriptedModel({
      [FIX_PROMPT_VERSION]: textResponse(VALID_FIX_JSON),
      [CRITIC_PROMPT_VERSION]: textResponse(JSON.stringify({ verdict: "confirmed", reason: "ok" })),
    });
    const deps: RemediationDeps = {
      fixers: { "sql-injection": fixerFor("sql-injection", null) },
      model,
      scmReader: APP_TS_SCM,
      policy: POLICY,
    };
    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.provenance?.fixerKind).toBe("model");
    expect(model.calls.length).toBeGreaterThan(0);
  });
});

describe("attemptRemediation: classifies uncertain safe patch as draft eligible", () => {
  it("classifies uncertain safe patch as draft eligible", async () => {
    const model = new ScriptedModel({
      [FIX_PROMPT_VERSION]: textResponse(VALID_FIX_JSON),
      [CRITIC_PROMPT_VERSION]: textResponse(JSON.stringify({ verdict: "indeterminate", reason: "cannot tell from given context" })),
    });
    const deps: RemediationDeps = { fixers: {}, model, scmReader: APP_TS_SCM, policy: POLICY };

    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("draft");
    expect(attempt.reasonCode).toBe("critic_indeterminate");
    expect(attempt.edits).not.toBeNull();
    expect(attempt.criticVerdict).toBe("indeterminate");
  });

  it("classifies a safe patch as draft eligible when the critic provider fails", async () => {
    const model = new ScriptedModel({
      [FIX_PROMPT_VERSION]: textResponse(VALID_FIX_JSON),
      [CRITIC_PROMPT_VERSION]: () => {
        throw new Error("critic backend unreachable");
      },
    });
    const deps: RemediationDeps = { fixers: {}, model, scmReader: APP_TS_SCM, policy: POLICY };

    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("draft");
    expect(attempt.reasonCode).toBe("critic_unavailable");
    expect(attempt.edits).not.toBeNull();
  });

  it("classifies a safe patch as draft eligible when the critic reply is unparseable", async () => {
    const model = new ScriptedModel({
      [FIX_PROMPT_VERSION]: textResponse(VALID_FIX_JSON),
      [CRITIC_PROMPT_VERSION]: textResponse("I'm not sure, sorry."),
    });
    const deps: RemediationDeps = { fixers: {}, model, scmReader: APP_TS_SCM, policy: POLICY };

    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("draft");
    expect(attempt.reasonCode).toBe("critic_unavailable");
  });
});

describe("attemptRemediation: classifies critic confirmed patch as ready eligible", () => {
  it("classifies critic confirmed patch as ready eligible", async () => {
    const model = new ScriptedModel({
      [FIX_PROMPT_VERSION]: textResponse(VALID_FIX_JSON),
      [CRITIC_PROMPT_VERSION]: textResponse(JSON.stringify({ verdict: "confirmed", reason: "matches the finding, no new defect" })),
    });
    const deps: RemediationDeps = { fixers: {}, model, scmReader: APP_TS_SCM, policy: POLICY };

    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("ready");
    expect(attempt.reasonCode).toBe("critic_confirmed");
    expect(attempt.criticVerdict).toBe("confirmed");
    expect(attempt.edits).not.toBeNull();
  });
});

describe("attemptRemediation: rejected and unavailable outcome classes", () => {
  it("rejects when the critic refutes the patch — no PR eligibility, finding stays open", async () => {
    const model = new ScriptedModel({
      [FIX_PROMPT_VERSION]: textResponse(VALID_FIX_JSON),
      [CRITIC_PROMPT_VERSION]: textResponse(JSON.stringify({ verdict: "refuted", reason: "does not address the actual sink" })),
    });
    const deps: RemediationDeps = { fixers: {}, model, scmReader: APP_TS_SCM, policy: POLICY };

    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("rejected");
    expect(attempt.reasonCode).toBe("critic_refuted");
    expect(attempt.edits).toBeNull();
  });

  it("rejects a structurally invalid (hallucinated preimage) proposal without ever calling the critic", async () => {
    const badProposal = JSON.stringify({
      edits: [{ path: "src/app.ts", expectedOriginal: "this text is not in the file", replacement: "x", rationale: "r" }],
    });
    const model = new ScriptedModel({ [FIX_PROMPT_VERSION]: textResponse(badProposal) });
    const deps: RemediationDeps = { fixers: {}, model, scmReader: APP_TS_SCM, policy: POLICY };

    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("rejected");
    expect(attempt.reasonCode).toBe("proposal_invalid");
    expect(attempt.detail).toContain("preimage_mismatch");
    expect(model.calls).toHaveLength(1); // the fix call only — critic never runs on a rejected proposal
  });

  it("rejects a deterministic fixer's patch that would touch a protected path", async () => {
    const finding = tlsFinding({ primaryRegion: { path: ".github/workflows/ci.yml", startLine: 1, endLine: 1, snippet: "rejectUnauthorized: false" } });
    const deps: RemediationDeps = {
      fixers: { "disabled-tls-verification": fixerFor("disabled-tls-verification", { replacement: "rejectUnauthorized: true", rationale: "re-enable" }) },
      scmReader: APP_TS_SCM,
      policy: POLICY,
    };
    const attempt = await attemptRemediation(finding, deps);
    expect(attempt.outcome).toBe("rejected");
    expect(attempt.reasonCode).toBe("deterministic_patch_rejected");
  });

  it("is unavailable — not silently 'no fix needed' — when no fixer is registered and no model is configured", async () => {
    const deps: RemediationDeps = { fixers: {}, scmReader: APP_TS_SCM, policy: POLICY };
    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("unavailable");
    expect(attempt.reasonCode).toBe("no_fixer_no_model");
    expect(attempt.provenance).toBeNull();
  });

  it("is unavailable when the model asserts no coherent fix exists", async () => {
    const model = new ScriptedModel({ [FIX_PROMPT_VERSION]: textResponse(JSON.stringify({ edits: [] })) });
    const deps: RemediationDeps = { fixers: {}, model, scmReader: APP_TS_SCM, policy: POLICY };
    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("unavailable");
    expect(attempt.reasonCode).toBe("model_no_fix");
    expect(attempt.provenance?.fixerKind).toBe("model");
  });

  it("is unavailable when the model reply is unparseable", async () => {
    const model = new ScriptedModel({ [FIX_PROMPT_VERSION]: textResponse("not json, sorry") });
    const deps: RemediationDeps = { fixers: {}, model, scmReader: APP_TS_SCM, policy: POLICY };
    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("unavailable");
    expect(attempt.reasonCode).toBe("model_unparseable");
  });

  it("is unavailable, with recorded provenance, when the fix-model provider throws — never silently clean", async () => {
    const model = new ScriptedModel({
      [FIX_PROMPT_VERSION]: () => {
        throw new Error("provider timeout");
      },
    });
    const deps: RemediationDeps = { fixers: {}, model, scmReader: APP_TS_SCM, policy: POLICY };
    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("unavailable");
    expect(attempt.reasonCode).toBe("model_provider_failed");
    expect(attempt.provenance?.fixerKind).toBe("model");
  });

  it("is unavailable when the source file cannot be read at the subject sha", async () => {
    const model = new ScriptedModel({ [FIX_PROMPT_VERSION]: textResponse(VALID_FIX_JSON) });
    const deps: RemediationDeps = {
      fixers: {},
      model,
      scmReader: scmWithContent({}), // no content seeded -> not_found
      policy: POLICY,
    };
    const attempt = await attemptRemediation(modelOnlyFinding(), deps);
    expect(attempt.outcome).toBe("unavailable");
    expect(attempt.reasonCode).toBe("no_source_context");
    expect(model.calls).toHaveLength(0);
  });
});

describe("attemptRemediations: batch driver", () => {
  it("proves a model-only surviving finding receives an attempted and persisted remediation", async () => {
    const model = new ScriptedModel({
      [FIX_PROMPT_VERSION]: textResponse(VALID_FIX_JSON),
      [CRITIC_PROMPT_VERSION]: textResponse(JSON.stringify({ verdict: "confirmed", reason: "ok" })),
    });
    const deps: RemediationDeps = { fixers: {}, model, scmReader: APP_TS_SCM, policy: POLICY };

    const finding = modelOnlyFinding();
    const results = await attemptRemediations([finding], deps);

    expect(results.size).toBe(1);
    const attempt = results.get([...results.keys()][0]!)!;
    expect(attempt.outcome).toBe("ready");
    expect(attempt.provenance?.fixerKind).toBe("model");
    expect(attempt.provenance?.promptVersion).toBe(FIX_PROMPT_VERSION);
  });

  it("attempts every finding independently — one unavailable finding does not block another's ready outcome", async () => {
    const model = new ScriptedModel({
      [FIX_PROMPT_VERSION]: textResponse(VALID_FIX_JSON),
      [CRITIC_PROMPT_VERSION]: textResponse(JSON.stringify({ verdict: "confirmed", reason: "ok" })),
    });
    const deps: RemediationDeps = {
      fixers: { "disabled-tls-verification": fixerFor("disabled-tls-verification", { replacement: "rejectUnauthorized: true", rationale: "re-enable" }) },
      model,
      scmReader: APP_TS_SCM,
      policy: POLICY,
    };
    const unreadable = modelOnlyFinding({
      ruleId: "MODEL.OTHER",
      primaryRegion: { path: "src/missing.ts", startLine: 1, endLine: 1, snippet: "x" },
    });

    const results = await attemptRemediations([tlsFinding(), modelOnlyFinding(), unreadable], deps);
    const outcomes = [...results.values()].map((a) => a.outcome);
    expect(outcomes).toContain("ready");
    expect(outcomes).toContain("unavailable");
  });
});
