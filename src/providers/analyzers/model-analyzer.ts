import { z } from "zod";
import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { ChangedFile } from "../scm/port.js";
import type { Analyzer } from "./port.js";
import type { ModelProvider } from "../models/port.js";
import { addedLines } from "./diff.js";

/**
 * Model-backed analyzer — the vision doc's "LLM widens detection". It finds
 * SEMANTIC defects the deterministic line-pattern analyzers cannot: injection,
 * missing authorization, silent data loss, and the like.
 *
 * Trust posture (load-bearing, from the heritage assessment):
 *  - every finding it emits is `model-asserted`, NEVER `deterministic`. The
 *    poison kernel requires deterministic corroboration to block, so a
 *    model-only finding can never cause a block — it abstains/escalates. Nightly
 *    surfaces it as a report (never an auto-fix: fixes need deterministic
 *    support). "Abstain unless deterministically corroborated" is thus enforced
 *    by trust level, not by hoping the model is calibrated.
 *  - model output is hostile/untrusted: it is parsed through a schema, its defect
 *    class must be in a fixed vocabulary, and every finding must ANCHOR to a real
 *    added line in the diff (hallucinated files/lines are dropped). The snippet
 *    is taken from the actual diff, not from what the model claimed.
 *  - any failure to reach or parse the model yields NO findings — never a crash,
 *    never a fabricated finding.
 *
 * Off the deterministic critical path: wired only when a model backend is
 * configured (see registry.modelAnalyzers).
 */

const VERSION = "1.0.0";
const PROMPT_VERSION = "model-analyze-v1";
const MAX_ADDED_LINES = 300; // prompt bound; beyond this the context is truncated
const MAX_FINDINGS = 25; // cap a runaway model

/** Fixed vocabulary the model must classify into. A class outside this set is dropped. */
export const MODEL_DEFECT_CLASSES = [
  "sql-injection",
  "command-injection",
  "missing-authorization",
  "silent-data-loss",
  "unsafe-deserialization",
  "server-side-request-forgery",
] as const;

const MODEL_CLASS_SET: ReadonlySet<string> = new Set(MODEL_DEFECT_CLASSES);

const SYSTEM = [
  "You are a senior security and correctness reviewer for an automated code-review gate.",
  "You are shown the ADDED lines of a change. Identify only genuine, harmful SEMANTIC defects that simple pattern-matching would miss.",
  "",
  "Respond with ONLY a JSON array, no prose. Each element:",
  '  {"class": "...", "path": "...", "line": <number>, "reason": "..."}',
  `class MUST be one of: ${MODEL_DEFECT_CLASSES.join(", ")}.`,
  "path and line MUST reference one of the exact added lines shown to you.",
  "Report a defect only if you are confident it is real and harmful. If there are none, respond with [].",
  "Do NOT report style, naming, or hypothetical issues.",
].join("\n");

const ModelFinding = z.object({
  class: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  reason: z.string().min(1),
});

function extractJsonArray(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** path -> (new-file line -> exact added text). The authoritative anchor for a finding. */
function indexAddedLines(files: ChangedFile[]): { index: Map<string, Map<number, string>>; total: number; truncated: boolean } {
  const index = new Map<string, Map<number, string>>();
  let total = 0;
  let truncated = false;
  for (const file of files) {
    const byLine = new Map<number, string>();
    for (const { text, line } of addedLines(file.patch)) {
      if (total >= MAX_ADDED_LINES) {
        truncated = true;
        break;
      }
      byLine.set(line, text);
      total += 1;
    }
    if (byLine.size > 0) index.set(file.path, byLine);
    if (truncated) break;
  }
  return { index, total, truncated };
}

function buildInput(index: Map<string, Map<number, string>>): string {
  const blocks: string[] = [];
  for (const [path, byLine] of index) {
    const lines = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([n, t]) => `  ${n}: ${t}`);
    blocks.push(`file: ${path}\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

export class ModelAnalyzer implements Analyzer {
  readonly id = "model-analyzer";

  constructor(private readonly model: ModelProvider) {}

  async analyze(subject: SubjectRevision, files: ChangedFile[]): Promise<Finding[]> {
    const { index, truncated } = indexAddedLines(files);
    if (index.size === 0) return []; // nothing added to review

    let text: string;
    let modelId: string;
    try {
      const response = await this.model.complete({ promptVersion: PROMPT_VERSION, system: SYSTEM, input: buildInput(index) });
      text = response.text;
      modelId = response.modelId;
    } catch {
      return []; // provider/network failure — emit nothing, never crash
    }

    const parsed = z.array(ModelFinding).safeParse(extractJsonArray(text));
    if (!parsed.success) return []; // unparseable output — emit nothing

    const findings: Finding[] = [];
    for (const candidate of parsed.data) {
      if (findings.length >= MAX_FINDINGS) break;
      if (!MODEL_CLASS_SET.has(candidate.class)) continue; // outside the vocabulary — drop

      // Anchor to a REAL added line; drop hallucinated locations.
      const snippet = index.get(candidate.path)?.get(candidate.line);
      if (snippet === undefined) continue;

      findings.push({
        ruleId: `MODEL.${candidate.class}`,
        defectClass: candidate.class,
        subject,
        primaryRegion: { path: candidate.path, startLine: candidate.line, endLine: candidate.line, snippet: snippet.trim() },
        provenance: { analyzerId: this.id, analyzerVersion: VERSION, modelId, promptVersion: PROMPT_VERSION },
        // Trust is fixed here — the model does not get to assert its own trust level.
        supporting: [{ trust: "model-asserted", statement: candidate.reason }],
        contradicting: [],
        completeness: { requiredEvidencePresent: true, contextTruncated: truncated },
        validation: "pending",
      });
    }
    return findings;
  }
}
