import { describe, expect, it } from "vitest";
import type { Finding } from "../../domain/evidence/types.js";
import { TlsFixer } from "./tls-fixer.js";

const SUBJECT = { repository: "acme/web", commitSha: "a".repeat(40) };

function finding(ruleId: string, snippet: string, path = "src/http.ts"): Finding {
  return {
    ruleId,
    defectClass: "disabled-tls-verification",
    subject: SUBJECT,
    primaryRegion: { path, startLine: 7, endLine: 7, snippet },
    provenance: { analyzerId: "disabled-tls", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "x" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
  };
}

const fixer = new TlsFixer();

describe("TlsFixer", () => {
  it.each([
    ["TLS.REJECT_UNAUTHORIZED_FALSE", "const a = new https.Agent({ rejectUnauthorized: false });", "rejectUnauthorized: true"],
    ["TLS.NODE_TLS_REJECT_UNAUTHORIZED", "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';", "NODE_TLS_REJECT_UNAUTHORIZED = '1'"],
    ["TLS.GO_INSECURE_SKIP_VERIFY", "tls.Config{InsecureSkipVerify: true}", "InsecureSkipVerify: false"],
    ["TLS.PY_VERIFY_FALSE", "requests.get(url, verify=False)", "verify=True"],
  ])("flips %s to the secure value", (ruleId, snippet, expectedSubstring) => {
    const edit = fixer.propose(finding(ruleId, snippet));
    expect(edit).not.toBeNull();
    expect(edit!.replacement).toContain(expectedSubstring);
    expect(edit!.path).toBe("src/http.ts");
    expect(edit!.rationale).toMatch(/verification/i);
  });

  it("preserves the rest of the line", () => {
    const edit = fixer.propose(finding("TLS.REJECT_UNAUTHORIZED_FALSE", "const a = new https.Agent({ rejectUnauthorized: false });"));
    expect(edit!.replacement).toBe("const a = new https.Agent({ rejectUnauthorized: true });");
  });

  it("returns null for an unknown rule id (refuses to guess)", () => {
    expect(fixer.propose(finding("TLS.SOMETHING_NEW", "rejectUnauthorized: false"))).toBeNull();
  });

  it("returns null when the known pattern does not actually match the snippet", () => {
    expect(fixer.propose(finding("TLS.REJECT_UNAUTHORIZED_FALSE", "const x = 1; // unrelated line"))).toBeNull();
  });
});
