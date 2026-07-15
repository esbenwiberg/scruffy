import { sign } from "@octokit/webhooks-methods";
import type { ChangedFile } from "../../src/providers/scm/port.js";

/**
 * Seeded scenarios. Each carries a PR webhook payload (the SAME shape GitHub
 * sends) plus the changed files the fake SCM will serve for that head sha.
 * Deterministic: fixed shas, fixed content.
 */

export const WEBHOOK_SECRET = "test-secret";
export const REPO = "acme/web";

export interface Scenario {
  name: string;
  commitSha: string;
  files: ChangedFile[];
  expectedOutcome: "allow" | "block" | "indeterminate";
}

function newFilePatch(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

export const SCENARIOS: Record<string, Scenario> = {
  clean: {
    name: "clean PR",
    commitSha: "1".repeat(40),
    files: [
      { path: "src/util.ts", patch: newFilePatch(["export const add = (a: number, b: number) => a + b;"]) },
    ],
    expectedOutcome: "allow",
  },
  realSecret: {
    name: "PR introducing a live-looking AWS key",
    commitSha: "2".repeat(40),
    files: [
      {
        path: "src/config.ts",
        patch: newFilePatch(["export const AWS_KEY = 'AKIAIJKLMNOP12345678';"]),
      },
    ],
    expectedOutcome: "block",
  },
  placeholderSecret: {
    name: "PR introducing the AWS docs EXAMPLE key (should be refuted)",
    commitSha: "3".repeat(40),
    files: [
      {
        path: "docs/example.md",
        patch: newFilePatch(["Set AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"]),
      },
    ],
    expectedOutcome: "allow",
  },
};

export function webhookBody(scenario: Scenario, action = "opened"): string {
  return JSON.stringify({
    action,
    repository: { full_name: REPO },
    pull_request: { head: { sha: scenario.commitSha } },
  });
}

export async function signBody(body: string): Promise<string> {
  return sign(WEBHOOK_SECRET, body);
}
