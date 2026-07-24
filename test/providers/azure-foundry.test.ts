import { describe, expect, it, vi } from "vitest";

/**
 * When the Foundry SDK's dynamic import fails for a reason *other* than a missing
 * module (a broken transitive dependency, an ESM/CJS resolution error, a throwing
 * top-level side effect), `create()` must surface the real diagnostic — and keep
 * the original error as `cause` — instead of the misleading 'not installed'
 * message. A `vi.mock` factory that throws makes `await import(...)` reject with a
 * non module-not-found error, exercising exactly that branch.
 */
vi.mock("@anthropic-ai/foundry-sdk", () => {
  throw new Error("boom: broken transitive dependency");
});

import { AzureFoundryModelProvider } from "../../src/providers/models/azure-foundry.js";

describe("AzureFoundryModelProvider.create", () => {
  it("surfaces the real import error and its cause, not the generic 'not installed' message", async () => {
    const err = await AzureFoundryModelProvider.create({ apiKey: "k", resource: "r" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    // The non-ENOENT branch was taken: the real diagnostic is surfaced ...
    expect((err as Error).message).toContain("failed to load");
    // ... the original error is preserved as `cause` (the bare-catch bug dropped it) ...
    expect((err as Error).cause).toBeInstanceOf(Error);
    // ... and it is NOT misreported as a missing package.
    expect((err as Error).message).not.toMatch(/requires the .* package to be installed/);
  });
});
