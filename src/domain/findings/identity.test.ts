import { describe, expect, it } from "vitest";
import type { Finding } from "../evidence/types.js";
import { dedupeFindings, findingKey } from "./identity.js";

const SUBJECT = { repository: "acme/web", commitSha: "a".repeat(40) };

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    defectClass: "disabled-tls-verification",
    subject: SUBJECT,
    primaryRegion: { path: "src/http.ts", startLine: 5, endLine: 5, snippet: "rejectUnauthorized: false" },
    provenance: { analyzerId: "disabled-tls", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "x" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "pending",
    ...overrides,
  };
}

describe("findingKey", () => {
  it("is identical for the same class/rule/location and differs on location", () => {
    expect(findingKey(finding())).toBe(findingKey(finding({ validation: "validated" })));
    expect(findingKey(finding())).not.toBe(findingKey(finding({ primaryRegion: { path: "src/other.ts", startLine: 5, endLine: 5, snippet: "x" } })));
  });
});

describe("dedupeFindings", () => {
  it("collapses duplicates at the same identity to one", () => {
    const out = dedupeFindings([finding(), finding(), finding()]);
    expect(out).toHaveLength(1);
  });

  it("keeps distinct findings at different locations", () => {
    const a = finding();
    const b = finding({ primaryRegion: { path: "src/other.ts", startLine: 9, endLine: 9, snippet: "rejectUnauthorized: false" } });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("keeps the strongest-validation survivor among duplicates regardless of order", () => {
    const weak = finding({ validation: "pending" });
    const strong = finding({ validation: "validated" });
    for (const input of [[weak, strong], [strong, weak]]) {
      const [survivor] = dedupeFindings(input);
      expect(survivor!.validation).toBe("validated");
    }
  });

  it("SAFETY: never drops deterministic evidence by collapsing onto a model-asserted duplicate", () => {
    // Two analyzers can reach the same identity with different evidence. Keeping
    // one and discarding the other would silently demote a blockable finding to
    // model-asserted — a detection loss hidden inside a helper called "dedupe".
    const hard = finding({ supporting: [{ trust: "deterministic", statement: "literal false in source" }] });
    const soft = finding({ supporting: [{ trust: "model-asserted", statement: "looks disabled" }] });
    for (const input of [[hard, soft], [soft, hard]]) {
      const [merged] = dedupeFindings(input);
      expect(merged!.supporting.some((s) => s.trust === "deterministic")).toBe(true);
      expect(merged!.supporting).toHaveLength(2);
    }
  });

  it("unions evidence in input order, so the result does not depend on which side won", () => {
    const a = finding({ validation: "pending", supporting: [{ trust: "deterministic", statement: "one" }] });
    const b = finding({ validation: "validated", supporting: [{ trust: "deterministic", statement: "two" }] });
    const [merged] = dedupeFindings([a, b]);
    expect(merged!.supporting.map((s) => s.statement)).toEqual(["one", "two"]);
    expect(merged!.validation, "scalars still come from the stronger side").toBe("validated");
  });

  it("does not duplicate identical evidence statements", () => {
    const [merged] = dedupeFindings([finding(), finding()]);
    expect(merged!.supporting).toHaveLength(1);
  });

  it("merges contradicting evidence too — a refutation must not be lost", () => {
    const plain = finding();
    const refuted = finding({ contradicting: [{ trust: "deterministic", statement: "it is a test fixture" }] });
    const [merged] = dedupeFindings([plain, refuted]);
    expect(merged!.contradicting).toHaveLength(1);
  });

  it("keeps truncation sticky and evidence-presence optimistic", () => {
    // Truncation: if either view was partial, the merged one is partial.
    // Presence: the merged finding holds the union, so either side having what
    // its class requires makes the merged one complete.
    const partial = finding({ completeness: { requiredEvidencePresent: false, contextTruncated: true } });
    const full = finding({ completeness: { requiredEvidencePresent: true, contextTruncated: false } });
    const [merged] = dedupeFindings([partial, full]);
    expect(merged!.completeness).toEqual({ requiredEvidencePresent: true, contextTruncated: true });
  });
});
