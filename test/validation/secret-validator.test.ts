import { describe, expect, it } from "vitest";
import { SecretValidator } from "../../src/providers/validation/secret-validator.js";
import { deterministicFinding } from "../../src/providers/analyzers/finding.js";

const SUBJECT = { repository: "acme/x", commitSha: "a".repeat(40) };

function secretFinding(ruleId: string, snippet: string) {
  return deterministicFinding({
    ruleId,
    defectClass: "leaked-credential",
    subject: SUBJECT,
    path: "src/config.ts",
    line: 1,
    snippet,
    analyzerId: "secret-scan",
    analyzerVersion: "1.0.0",
    statement: "s",
  });
}

describe("SecretValidator", () => {
  const v = new SecretValidator();

  it("validates a live-looking AWS key", async () => {
    expect(await v.validate(secretFinding("SECRET.AWS_ACCESS_KEY", "export const KEY = 'AKIA7F3QX9RLZ2WK8MTV';"))).toBe(
      "validated",
    );
  });

  it("refutes the canonical AWS docs example key (marker is in the token)", async () => {
    expect(await v.validate(secretFinding("SECRET.AWS_ACCESS_KEY", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"))).toBe(
      "refuted",
    );
  });

  it("refutes an all-zero placeholder key", async () => {
    expect(await v.validate(secretFinding("SECRET.AWS_ACCESS_KEY", "example: AKIA0000000000000000"))).toBe("refuted");
  });

  it("does NOT let an attacker comment refute a live key (the bypass)", async () => {
    // "example" appears in a comment, but the token itself is live — must stand.
    const finding = secretFinding(
      "SECRET.AWS_ACCESS_KEY",
      "export const KEY = 'AKIA7F3QX9RLZ2WK8MTV'; // example usage: client.auth(KEY)",
    );
    expect(await v.validate(finding)).toBe("validated");
  });

  it("validates when the matched token is not visible in the snippet (cannot refute)", async () => {
    // Snippet lost the token (e.g. truncated) — we cannot judge it, so it stands.
    expect(await v.validate(secretFinding("SECRET.AWS_ACCESS_KEY", "export const KEY = <redacted>;"))).toBe("validated");
  });
});
