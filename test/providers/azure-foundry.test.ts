import { describe, expect, it, vi } from "vitest";
import {
  AZURE_FOUNDRY_SCOPE,
  AzureFoundryModelProvider,
  createAzureTokenProvider,
} from "../../src/providers/models/azure-foundry.js";

describe("Azure Foundry managed identity backend", () => {
  it("requests the exact Entra inference scope without an API key", async () => {
    const getToken = vi.fn().mockResolvedValue({ token: "entra-token", expiresOnTimestamp: 1 });
    const provider = createAzureTokenProvider({ getToken });
    await expect(provider()).resolves.toBe("entra-token");
    expect(getToken).toHaveBeenCalledWith(AZURE_FOUNDRY_SCOPE);
  });

  it("uses the configured deployment and returns provider provenance", async () => {
    const create = vi.fn().mockResolvedValue({
      model: "claude-sonnet-live",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "[]" }],
    });
    const provider = await AzureFoundryModelProvider.create({
      baseUrl: "https://scruffy.services.ai.azure.com/anthropic",
      deployment: "claude-sonnet-live",
      client: { messages: { create } },
    });
    await expect(
      provider.complete({ promptVersion: "v1", system: "system", input: "input" }),
    ).resolves.toEqual({ modelId: "claude-sonnet-live", text: "[]" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-live", max_tokens: 4096 }),
    );
  });

  it("fails closed on truncation, empty output, missing deployment, or non-HTTPS endpoint", async () => {
    const truncated = await AzureFoundryModelProvider.create({
      baseUrl: "https://scruffy.services.ai.azure.com/anthropic",
      deployment: "claude",
      client: {
        messages: {
          create: vi
            .fn()
            .mockResolvedValue({ model: "claude", stop_reason: "max_tokens", content: [] }),
        },
      },
    });
    await expect(
      truncated.complete({ promptVersion: "v1", system: "s", input: "i" }),
    ).rejects.toThrow(/truncated/);

    const empty = await AzureFoundryModelProvider.create({
      baseUrl: "https://scruffy.services.ai.azure.com/anthropic",
      deployment: "claude",
      client: {
        messages: {
          create: vi
            .fn()
            .mockResolvedValue({ model: "claude", stop_reason: "end_turn", content: [] }),
        },
      },
    });
    await expect(empty.complete({ promptVersion: "v1", system: "s", input: "i" })).rejects.toThrow(
      /no text/,
    );
    await expect(
      AzureFoundryModelProvider.create({ baseUrl: "https://example.test", deployment: "" }),
    ).rejects.toThrow(/deployment/);
    await expect(
      AzureFoundryModelProvider.create({ baseUrl: "http://example.test", deployment: "claude" }),
    ).rejects.toThrow(/HTTPS/);
  });
});
