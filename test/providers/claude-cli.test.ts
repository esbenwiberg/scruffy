import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeCliModelProvider } from "../../src/providers/models/claude-cli.js";
import { PROMPT_VERSION } from "../../src/providers/analyzers/model-analyzer.js";

const dir = mkdtempSync(join(tmpdir(), "claude-cli-stub-"));
const stubs: string[] = [];

/** Write an executable /bin/sh stub that prints `body` to stdout and exits `code`. */
function makeStub(body: string, code = 0): string {
  const path = join(dir, `stub-${stubs.length}.sh`);
  // Single-quote the payload for the shell; escape embedded single quotes.
  const safe = body.replace(/'/g, `'\\''`);
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${safe}'\nexit ${code}\n`);
  chmodSync(path, 0o755);
  stubs.push(path);
  return path;
}

const request = { promptVersion: PROMPT_VERSION, system: "sys", input: "in" };
const successfulEnvelope = {
  result: '  [{"class":"sql-injection","path":"a.ts","line":1,"reason":"x"}]  ',
  stop_reason: "end_turn",
  is_error: false,
  subtype: "success",
};

afterAll(() => {
  // mkdtemp dir is under the OS tmp dir; leaving the scripts is harmless, but drop
  // the references so nothing lingers in module scope.
  stubs.length = 0;
});

describe("ClaudeCliModelProvider completion envelope", () => {
  it("extracts result text only from a successful terminal end_turn", async () => {
    const provider = new ClaudeCliModelProvider({ binary: makeStub(JSON.stringify(successfulEnvelope)) });
    const response = await provider.complete(request);

    expect(response.text).toBe(successfulEnvelope.result.trim());
    expect(response.modelId).toBe("claude-cli");
  });

  it.each(["max_tokens", "tool_use", "pause_turn"])("rejects non-terminal stop_reason %s", async (stopReason) => {
    const provider = new ClaudeCliModelProvider({
      binary: makeStub(JSON.stringify({ ...successfulEnvelope, stop_reason: stopReason })),
    });
    await expect(provider.complete(request)).rejects.toThrow(new RegExp(`stop_reason=${stopReason}`));
  });

  it("rejects malformed JSON", async () => {
    const provider = new ClaudeCliModelProvider({ binary: makeStub('{"result":') });
    await expect(provider.complete(request)).rejects.toThrow(/malformed JSON completion envelope/);
  });

  it.each(["result", "stop_reason", "is_error", "subtype"] as const)(
    "rejects an envelope missing required %s metadata",
    async (field) => {
      const envelope: Partial<typeof successfulEnvelope> = { ...successfulEnvelope };
      delete envelope[field];
      const provider = new ClaudeCliModelProvider({ binary: makeStub(JSON.stringify(envelope)) });
      await expect(provider.complete(request)).rejects.toThrow(new RegExp(field));
    },
  );

  it("rejects error envelopes even when subtype and stop_reason otherwise look successful", async () => {
    const provider = new ClaudeCliModelProvider({
      binary: makeStub(JSON.stringify({ ...successfulEnvelope, is_error: true })),
    });
    await expect(provider.complete(request)).rejects.toThrow(/reported an error completion/);
  });

  it("rejects non-success subtypes even with end_turn and no error", async () => {
    const provider = new ClaudeCliModelProvider({
      binary: makeStub(JSON.stringify({ ...successfulEnvelope, subtype: "error_during_execution" })),
    });
    await expect(provider.complete(request)).rejects.toThrow(/subtype=error_during_execution/);
  });
});

describe("ClaudeCliModelProvider invocation isolation", () => {
  it("requests JSON and disables built-in and ambient MCP tools while preserving the model", async () => {
    const argvPath = join(dir, "captured-argv");
    const path = join(dir, `argv-${stubs.length}.sh`);
    writeFileSync(
      path,
      `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$@" > '${argvPath}'\nprintf '%s' '${JSON.stringify(successfulEnvelope)}'\n`,
    );
    chmodSync(path, 0o755);
    stubs.push(path);

    const provider = new ClaudeCliModelProvider({ binary: path, model: "claude-test-model" });
    const response = await provider.complete(request);

    expect(readFileSync(argvPath, "utf8").trimEnd().split("\n")).toEqual([
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--model",
      "claude-test-model",
    ]);
    expect(response.modelId).toBe("claude-cli:claude-test-model");
  });
});

describe("ClaudeCliModelProvider subprocess safety", () => {
  /** A stub that streams `mib` MiB of output, to exercise the accumulation cap. */
  function floodStub(mib: number, stream: "stdout" | "stderr", code = 0): string {
    const path = join(dir, `flood-${stubs.length}.sh`);
    const redirect = stream === "stderr" ? " >&2" : "";
    writeFileSync(
      path,
      `#!/bin/sh\ncat >/dev/null\ndd if=/dev/zero bs=1048576 count=${mib} 2>/dev/null | tr '\\0' 'a'${redirect}\nexit ${code}\n`,
    );
    chmodSync(path, 0o755);
    stubs.push(path);
    return path;
  }

  it("kills a runaway CLI instead of buffering its output until the gate dies", async () => {
    // `stdout += chunk` with no bound means one wedged or looping CLI can OOM the
    // reviewer process. Rejecting is the right failure: the analyzer records a
    // provider_unavailable gap and the gate abstains.
    const provider = new ClaudeCliModelProvider({ binary: floodStub(4, "stdout") });
    await expect(provider.complete(request)).rejects.toThrow(/more than \d+ chars of output/);
  });

  it("bounds stderr too, and still reports the failure", async () => {
    // stderr is only quoted into an Error message, so it truncates rather than
    // failing the call — but an unbounded error string is the same memory bug.
    const provider = new ClaudeCliModelProvider({ binary: floodStub(4, "stderr", 1) });
    await expect(provider.complete(request)).rejects.toThrow(/exited 1/);
    await provider.complete(request).catch((err: Error) => {
      expect(err.message.length).toBeLessThan(100_000);
    });
  });

  it("reports non-zero exits with bounded stderr", async () => {
    const provider = new ClaudeCliModelProvider({ binary: makeStub("boom", 7) });
    await expect(provider.complete(request)).rejects.toThrow(/exited 7/);
  });

  it("handles a child closing stdin early without double settlement", async () => {
    const path = join(dir, `early-exit-${stubs.length}.sh`);
    writeFileSync(path, "#!/bin/sh\nexit 1\n");
    chmodSync(path, 0o755);
    stubs.push(path);
    const provider = new ClaudeCliModelProvider({ binary: path });

    await expect(provider.complete({ ...request, input: "x".repeat(1_000_000) })).rejects.toThrow();
  });

  it("leaves ordinary-sized terminal output intact", async () => {
    const provider = new ClaudeCliModelProvider({ binary: makeStub(JSON.stringify(successfulEnvelope)) });
    expect((await provider.complete(request)).text).toBe(successfulEnvelope.result.trim());
  });
});
