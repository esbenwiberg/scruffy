import { spawn } from "node:child_process";
import type { ModelProvider, ModelRequest, ModelResponse } from "./port.js";

/**
 * Local-dev model backend that reuses the authenticated `claude` CLI session —
 * no API key in config, no separate login. It shells out to `claude -p`
 * (headless print mode), which returns a single completion using whatever auth
 * the developer's Claude CLI already holds.
 *
 * This is the most faithful "reuse CLI auth" backend when the `claude` CLI is
 * present. The Anthropic-SDK backend (anthropic-cli.ts) is the alternative when
 * an `ant` profile or ANTHROPIC_API_KEY is configured instead. Neither is on the
 * deterministic critical path — tests and the harness use the fake.
 *
 * Trade-off: each call spawns a CLI process (seconds of latency), so this suits
 * nightly/deeper validation, not the sub-two-minute poison path.
 *
 * The provider uses Claude Code's JSON transport envelope and accepts only a
 * successful `end_turn`. This keeps truncation and attempted tool use from being
 * mistaken for a complete review. The invocation also removes built-in tools and
 * ignores ambient MCP configuration: this adapter supplies all review context and
 * expects completion text, not an agentic workflow.
 */
export class ClaudeCliModelProvider implements ModelProvider {
  readonly id: string;
  readonly #binary: string;
  readonly #model: string | undefined;

  constructor(options: { binary?: string; model?: string } = {}) {
    this.#binary = options.binary ?? "claude";
    this.#model = options.model ?? process.env.SCRUFFY_CLAUDE_CLI_MODEL;
    this.id = this.#model ? `claude-cli:${this.#model}` : "claude-cli";
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // The CLI takes a single prompt; fold the system instructions in ahead of
    // the input, clearly delimited.
    const prompt = `${request.system}\n\n---\n\n${request.input}`;
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      EMPTY_MCP_CONFIG,
    ];
    if (this.#model) args.push("--model", this.#model);

    const stdout = await this.#run(args, prompt);
    const envelope = parseCompletionEnvelope(stdout);
    return { modelId: this.id, text: envelope.result.trim() };
  }

  #run(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let overflowed = false;
      // Decode per chunk so a multibyte char split across a chunk boundary is not
      // corrupted into U+FFFD.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      // A hung CLI must not leak a zombie process per call; kill and reject.
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() => reject(new Error(`claude CLI timed out after ${CLAUDE_TIMEOUT_MS}ms`)));
      }, CLAUDE_TIMEOUT_MS);

      // Bounded accumulation. A wedged or looping CLI can stream indefinitely,
      // and `stdout += chunk` would grow until the gate process dies of memory
      // exhaustion — one hostile change taking out the whole reviewer. Past the
      // cap the reply is not a finding array under any reading, so kill and
      // reject: the analyzer records provider_unavailable and the gate abstains.
      child.stdout.on("data", (chunk: string) => {
        if (overflowed) return;
        stdout += chunk;
        if (stdout.length <= MAX_STDOUT_CHARS) return;
        overflowed = true;
        child.kill("SIGKILL");
        settle(() => reject(new Error(`claude CLI produced more than ${MAX_STDOUT_CHARS} chars of output; refusing to buffer it`)));
      });
      // stderr only ever feeds an error message, so cap it by discarding the
      // tail rather than failing the call — but cap it, for the same reason.
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_STDERR_CHARS) {
          stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
        }
      });
      child.on("error", (err) => settle(() => reject(err)));
      // EPIPE if the child dies before consuming the (full-prompt) stdin: handle it
      // so it rejects rather than throwing an uncaught exception that kills us.
      child.stdin.on("error", (err) => settle(() => reject(err)));
      child.on("close", (code) =>
        settle(() => {
          if (code === 0) resolve(stdout);
          else reject(new Error(`claude CLI exited ${code}: ${stderr.trim() || "no stderr"}`));
        }),
      );
      child.stdin.end(stdin);
    });
  }
}

type CompletionEnvelope = {
  result: string;
  stop_reason: string;
  is_error: boolean;
  subtype: string;
};

function parseCompletionEnvelope(stdout: string): CompletionEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("claude CLI returned malformed JSON completion envelope");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("claude CLI returned an invalid completion envelope: expected an object");
  }

  const envelope = value as Record<string, unknown>;
  const missing = [
    typeof envelope.result !== "string" && "result",
    typeof envelope.stop_reason !== "string" && "stop_reason",
    typeof envelope.is_error !== "boolean" && "is_error",
    typeof envelope.subtype !== "string" && "subtype",
  ].filter((field): field is string => field !== false);
  if (missing.length > 0) {
    throw new Error(`claude CLI completion envelope has missing or invalid metadata: ${missing.join(", ")}`);
  }

  const completion = envelope as CompletionEnvelope;
  if (completion.is_error) {
    throw new Error(
      `claude CLI reported an error completion (subtype=${completion.subtype}, stop_reason=${completion.stop_reason})`,
    );
  }
  if (completion.subtype !== "success") {
    throw new Error(`claude CLI completion was not successful (subtype=${completion.subtype})`);
  }
  if (completion.stop_reason !== "end_turn") {
    throw new Error(`claude CLI completion was not terminal (stop_reason=${completion.stop_reason})`);
  }

  return completion;
}

/** Strict MCP mode with an explicit empty server set excludes ambient MCP tools. */
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
/** A model call can be slow; but a truly hung CLI must eventually fail the call. */
const CLAUDE_TIMEOUT_MS = 120_000;
/** Generous next to a 4096-token reply; small enough that a runaway cannot OOM us. */
const MAX_STDOUT_CHARS = 1_000_000;
/** stderr is quoted into an Error message — a megabyte of it helps nobody. */
const MAX_STDERR_CHARS = 8_192;
