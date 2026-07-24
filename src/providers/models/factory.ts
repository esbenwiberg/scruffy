import type { ModelProvider } from "./port.js";
import { FakeModelProvider } from "./fake.js";
import { ClaudeCliModelProvider } from "./claude-cli.js";
import { AnthropicCliModelProvider } from "./anthropic-cli.js";
import { AzureFoundryModelProvider } from "./azure-foundry.js";

/**
 * Selects the model backend. Defaults to the deterministic fake so nothing fires
 * a live model unless explicitly asked. `SCRUFFY_MODEL_BACKEND` chooses:
 *   fake       — deterministic, no network (tests, harness, corpus)
 *   claude-cli — local dev, reuse the authenticated `claude` CLI session
 *   anthropic  — local dev via the Anthropic SDK (ant profile / ANTHROPIC_API_KEY)
 *   azure      — deployed service via Azure Foundry
 */
export type ModelBackend = "fake" | "claude-cli" | "anthropic" | "azure";

export function resolveBackend(): ModelBackend {
  const value = process.env.SCRUFFY_MODEL_BACKEND;
  // Unset/empty: default to the deterministic fake so nothing fires a live model unasked.
  if (!value) return "fake";
  if (value === "claude-cli" || value === "anthropic" || value === "azure" || value === "fake") return value;
  // A non-empty but unrecognized value is an operator typo — fail loudly rather than
  // silently selecting the fake, whose empty output parses to a false "no findings" review.
  throw new Error(`unknown SCRUFFY_MODEL_BACKEND '${value}'`);
}

export async function createModelProvider(backend: ModelBackend = resolveBackend()): Promise<ModelProvider> {
  switch (backend) {
    case "claude-cli":
      return new ClaudeCliModelProvider();
    case "anthropic":
      return new AnthropicCliModelProvider();
    case "azure": {
      const apiKey = requireEnv("AZURE_FOUNDRY_API_KEY");
      const resource = requireEnv("AZURE_FOUNDRY_RESOURCE");
      return AzureFoundryModelProvider.create({ apiKey, resource });
    }
    case "fake":
      return new FakeModelProvider();
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the Azure Foundry backend`);
  return value;
}
