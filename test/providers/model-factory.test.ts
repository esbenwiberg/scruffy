import { afterEach, describe, expect, it } from "vitest";
import { createModelProvider, resolveBackend } from "../../src/providers/models/factory.js";

/**
 * A misspelled or bogus SCRUFFY_MODEL_BACKEND must fail loudly. Silently falling
 * back to the fake yields an empty (no-findings) review that is indistinguishable
 * from a clean gate — a false sense of security. Unset/empty still defaults to fake.
 */
describe("resolveBackend", () => {
  const original = process.env.SCRUFFY_MODEL_BACKEND;

  afterEach(() => {
    if (original === undefined) delete process.env.SCRUFFY_MODEL_BACKEND;
    else process.env.SCRUFFY_MODEL_BACKEND = original;
  });

  it("defaults to fake when unset", () => {
    delete process.env.SCRUFFY_MODEL_BACKEND;
    expect(resolveBackend()).toBe("fake");
  });

  it("defaults to fake when empty", () => {
    process.env.SCRUFFY_MODEL_BACKEND = "";
    expect(resolveBackend()).toBe("fake");
  });

  it("accepts the recognized backends", () => {
    for (const backend of ["fake", "claude-cli", "anthropic", "azure"] as const) {
      process.env.SCRUFFY_MODEL_BACKEND = backend;
      expect(resolveBackend()).toBe(backend);
    }
  });

  it("throws on an unrecognized non-empty value", () => {
    process.env.SCRUFFY_MODEL_BACKEND = "claudecli";
    expect(() => resolveBackend()).toThrow(/unknown SCRUFFY_MODEL_BACKEND 'claudecli'/);
  });

  it("createModelProvider also throws on a bogus backend", async () => {
    process.env.SCRUFFY_MODEL_BACKEND = "AZURE";
    await expect(createModelProvider()).rejects.toThrow(/unknown SCRUFFY_MODEL_BACKEND 'AZURE'/);
  });
});
