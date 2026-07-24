import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeCliModelProvider } from "../../src/providers/models/claude-cli.js";
import { PROMPT_VERSION } from "../../src/providers/analyzers/model-analyzer.js";

/**
 * Pins the documented LIMITATION of the claude-cli backend: `claude -p` exposes
 * only text + exit code, so a length-truncated completion that exits 0 is
 * returned as a normal success — this backend CANNOT detect truncation the way
 * the SDK backends (which throw on stop_reason === "max_tokens") can. These tests
 * make that gap explicit and executable rather than merely commented.
 *
 * The stub is a real executable script invoked through the provider's `binary`
 * option, so we exercise the actual spawn/stdio path, not a mock.
 */

const dir = mkdtempSync(join(tmpdir(), "claude-cli-stub-"));
const stubs: string[] = [];

/** Write an executable /bin/sh stub that prints `body` to stdout and exits `code`. */
function makeStub(body: string, code = 0): string {
  const path = join(dir, `stub-${stubs.length}.sh`);
  // Single-quote the payload for the shell; escape embedded single quotes.
  const safe = body.replace(/'/g, `'\\''`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s' '${safe}'\nexit ${code}\n`);
  chmodSync(path, 0o755);
  stubs.push(path);
  return path;
}

const request = { promptVersion: PROMPT_VERSION, system: "sys", input: "in" };

afterAll(() => {
  // mkdtemp dir is under the OS tmp dir; leaving the scripts is harmless, but drop
  // the references so nothing lingers in module scope.
  stubs.length = 0;
});

describe("ClaudeCliModelProvider truncation blindness", () => {
  it("returns a partial/invalid completion as a NORMAL success when the CLI exits 0 (cannot detect truncation)", async () => {
    // A JSON array cut off mid-object — exactly what a max_tokens truncation looks
    // like. The SDK backends throw here; the CLI backend has no stop_reason, so it
    // hands the partial text back as success. This is the under-report gap.
    const partial = '[{"class":"sql-inj';
    const provider = new ClaudeCliModelProvider({ binary: makeStub(partial) });

    const response = await provider.complete(request);

    // No throw, no abstain — the truncation is invisible at this layer.
    expect(response.text).toBe(partial);
    expect(response.modelId).toBe("claude-cli");
  });

  it("a truncation that still parses to a SHORTER valid array is silently under-reported (no error surfaces)", async () => {
    // The subtle case the doc warns about: the completion was cut off after the
    // first finding, but what survived is itself valid JSON. Nothing downstream can
    // tell it apart from a genuinely single-finding review.
    const truncatedButValid = '[{"class":"sql-injection","path":"a.ts","line":1,"reason":"x"}';
    const provider = new ClaudeCliModelProvider({ binary: makeStub(truncatedButValid) });

    const response = await provider.complete(request);

    expect(response.text).toBe(truncatedButValid);
  });

  it("still rejects on a non-zero exit — exit code is the ONLY failure signal this backend has", async () => {
    const provider = new ClaudeCliModelProvider({ binary: makeStub("boom", 1) });
    await expect(provider.complete(request)).rejects.toThrow(/exited 1/);
  });

  it("passes a complete, valid completion through unchanged (trimmed)", async () => {
    const complete = '  [{"class":"sql-injection","path":"a.ts","line":1,"reason":"x"}]  ';
    const provider = new ClaudeCliModelProvider({ binary: makeStub(complete) });
    const response = await provider.complete(request);
    expect(response.text).toBe(complete.trim());
  });
});
