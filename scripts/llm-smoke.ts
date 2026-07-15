import { createModelProvider, resolveBackend, type ModelBackend } from "../src/providers/models/factory.js";
import { ModelValidator } from "../src/providers/validation/model-validator.js";
import { deterministicFinding } from "../src/providers/analyzers/finding.js";
import type { SubjectRevision } from "../src/domain/evidence/types.js";

/**
 * Fires the real adversarial validator against two SYNTHETIC findings (no real
 * secrets, no customer data) to prove the LLM integration works end to end.
 *
 *   SCRUFFY_MODEL_BACKEND=anthropic npx tsx scripts/llm-smoke.ts   # local CLI auth
 *   SCRUFFY_MODEL_BACKEND=azure     npx tsx scripts/llm-smoke.ts   # Azure Foundry
 *
 * Defaults to the fake backend, which returns empty text -> "failed" (the safe
 * abstain), so running it with no backend configured demonstrates the failure
 * semantics rather than erroring.
 */

const SUBJECT: SubjectRevision = { repository: "acme/web", commitSha: "a".repeat(40) };

const CASES = [
  {
    label: "live-looking AWS key in production config",
    snippet: "export const AWS_KEY = 'AKIAIJKLMNOP12345678';",
    ruleId: "SECRET.AWS_ACCESS_KEY",
    statement: "added line matches AWS access key id",
  },
  {
    label: "AWS documentation EXAMPLE key in a markdown doc",
    snippet: "Set AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    ruleId: "SECRET.AWS_ACCESS_KEY",
    statement: "added line matches AWS access key id",
  },
];

async function main(): Promise<void> {
  const backend: ModelBackend = resolveBackend();
  console.log(`Model backend: ${backend}\n`);
  const model = await createModelProvider(backend);
  const validator = new ModelValidator(model);

  for (const c of CASES) {
    const finding = deterministicFinding({
      ruleId: c.ruleId,
      defectClass: "leaked-credential",
      subject: SUBJECT,
      path: "src/config.ts",
      line: 1,
      snippet: c.snippet,
      analyzerId: "secret-scan",
      analyzerVersion: "1.0.0",
      statement: c.statement,
    });
    const verdict = await validator.validate(finding);
    console.log(`• ${c.label}`);
    console.log(`    ${c.snippet}`);
    console.log(`    verdict: ${verdict}\n`);
  }
}

await main();
