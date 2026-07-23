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
    const args = ["-p"];
    if (this.#model) args.push("--model", this.#model);

    const text = await this.#run(args, prompt);
    return { modelId: this.id, text: text.trim() };
  }

  #run(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
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

      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
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

/** A model call can be slow; but a truly hung CLI must eventually fail the call. */
const CLAUDE_TIMEOUT_MS = 120_000;
