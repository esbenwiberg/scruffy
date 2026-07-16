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
});
