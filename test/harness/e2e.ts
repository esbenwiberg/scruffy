import { bootHarness } from "./boot.js";
import { REPO, SCENARIOS, signBody, webhookBody } from "../fixtures/scenarios.js";

/**
 * Narrated end-to-end run: `npm run harness`. Boots Scruffy against real
 * Postgres with fake edges, feeds each seeded PR through the full inbound path,
 * flushes effects, and prints what fell out — the decision, the durable run
 * state, and the check run posted to the (fake) SCM.
 */
async function main(): Promise<void> {
  const h = await bootHarness();
  console.log("Scruffy walking skeleton — seeded end-to-end run\n");

  try {
    for (const scenario of Object.values(SCENARIOS)) {
      const subject = { repository: REPO, commitSha: scenario.commitSha };
      h.scm.seedChangedFiles(subject, scenario.files);

      const body = webhookBody(scenario);
      const res = await h.scruffy.handleWebhook(await signBody(body), body);
      await h.scruffy.flushEffects();

      const run = res.runId ? await h.scruffy.runs.getRun(res.runId) : null;
      const check = h.scm.recordedCheckRuns().find((c) => c.input.subject.commitSha === scenario.commitSha);

      console.log(`• ${scenario.name}`);
      console.log(`    repo/sha     ${subject.repository}@${subject.commitSha.slice(0, 7)}`);
      console.log(`    run state    ${run?.state ?? "(none)"}`);
      console.log(`    check        ${check?.input.conclusion ?? "(none)"} — ${check?.input.title ?? ""}`);
      console.log(`    expected     ${scenario.expectedOutcome}\n`);
    }
    console.log("Done. All effects dispatched; outbox pending =", await h.scruffy.outbox.countPending());
  } finally {
    await h.pool.end();
  }
}

await main();
