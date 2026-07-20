import { createModelProvider, resolveBackend, type ModelBackend } from "../src/providers/models/factory.js";
import { ModelAnalyzer } from "../src/providers/analyzers/model-analyzer.js";
import { GROUNDED_DETECTION_TARGETS } from "../src/corpus/grounded.js";
import type { SubjectRevision } from "../src/domain/evidence/types.js";

/**
 * Fires the REAL model analyzer against the grounded corpus's changes and reports
 * whether the model independently catches each defect.
 *
 *   SCRUFFY_MODEL_BACKEND=claude-cli npx tsx scripts/grounded-live.ts   # default here
 *   SCRUFFY_MODEL_BACKEND=anthropic  npx tsx scripts/grounded-live.ts
 *   SCRUFFY_MODEL_BACKEND=azure      npx tsx scripts/grounded-live.ts
 *
 * WHY this is a script, not a test: a real model is non-deterministic, so this is
 * EVIDENCE, not a regression pin. The fake-model corpus (`npm run corpus:grounded`)
 * proves the kernels route a model finding correctly; this proves the harder claim
 * — that a real model actually FINDS the defect in the first place ("LLM widens
 * detection"). The changes and identifiers are invented (no real bytes); only the
 * defect shapes are grounded in real merged defects.
 *
 * Detection scoring per case:
 *   HIT     — a finding of the expected class anchored to the expected file
 *   OTHER   — the model flagged the file but with a different class (partial)
 *   MISS    — nothing anchored to the defect file
 * Findings on the benign half (or elsewhere) are reported as NOISE.
 */

async function main(): Promise<void> {
  // This script's whole purpose is a live run, so default to the working local
  // backend (claude-cli) unless the env explicitly overrides it.
  const backend: ModelBackend = process.env.SCRUFFY_MODEL_BACKEND ? resolveBackend() : "claude-cli";
  console.log(`Model backend: ${backend}`);
  if (backend === "fake") {
    console.log("\nThe fake backend returns no findings — every case will MISS. Set");
    console.log("SCRUFFY_MODEL_BACKEND=claude-cli (or anthropic/azure) for a real run.\n");
  }

  let model;
  try {
    model = await createModelProvider(backend);
  } catch (err) {
    console.error(`\nCould not create the '${backend}' model backend: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const analyzer = new ModelAnalyzer(model);
  let hits = 0;

  for (const target of GROUNDED_DETECTION_TARGETS) {
    const subject: SubjectRevision = { repository: target.subject.repository, commitSha: target.subject.commitSha };
    console.log(`\n── ${target.id}`);
    console.log(`   expecting: ${target.expect.defectClass} at ${target.expect.path}:${target.expect.line}`);

    let findings;
    try {
      findings = await analyzer.analyze(subject, target.files);
    } catch (err) {
      console.log(`   ERROR calling model: ${(err as Error).message}`);
      continue;
    }

    const onDefectFile = findings.filter((f) => f.primaryRegion.path === target.expect.path);
    const hit = onDefectFile.find((f) => f.defectClass === target.expect.defectClass);
    const noise = findings.filter((f) => f.primaryRegion.path !== target.expect.path);

    if (hit) {
      hits += 1;
      console.log(`   HIT  — ${hit.defectClass} at ${hit.primaryRegion.path}:${hit.primaryRegion.startLine}`);
      console.log(`          "${hit.supporting[0]?.statement ?? ""}"`);
    } else if (onDefectFile.length > 0) {
      console.log(`   OTHER — model flagged the file but as: ${onDefectFile.map((f) => f.defectClass).join(", ")}`);
    } else {
      console.log(`   MISS  — nothing anchored to the defect file`);
    }
    for (const n of noise) {
      console.log(`   NOISE — ${n.defectClass} at ${n.primaryRegion.path}:${n.primaryRegion.startLine}`);
    }
  }

  console.log(`\nDetection: ${hits}/${GROUNDED_DETECTION_TARGETS.length} grounded defects caught by the real model.`);
  console.log("(Evidence, not a regression pin — a real model is non-deterministic.)");
}

await main();
