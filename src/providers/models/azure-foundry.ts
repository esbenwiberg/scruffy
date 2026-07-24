import type { ModelProvider, ModelRequest, ModelResponse } from "./port.js";

/**
 * Deployed-service model backend: Azure AI Foundry. Uses the same Claude model
 * as local dev, through the `AnthropicFoundry` client.
 *
 * The `@anthropic-ai/foundry-sdk` package is imported dynamically via an
 * indirect specifier so the project builds and tests without it installed —
 * local dev and CI use the Anthropic-CLI or fake backends, and only the
 * deployed image needs the Foundry SDK. `create()` throws a clear message if the
 * package is missing.
 *
 * NOTE: untested end-to-end pending Azure Foundry credentials; the call shape
 * follows the documented `AnthropicFoundry` client.
 */

const MODEL = "claude-opus-4-8";
// Indirect specifier keeps the type checker from requiring the module at build time.
const FOUNDRY_PACKAGE = "@anthropic-ai/foundry-sdk";

export interface AzureFoundryOptions {
  apiKey: string;
  resource: string;
}

/** The subset of the Foundry client we depend on (structurally the base client). */
interface FoundryClient {
  messages: { create(args: unknown): Promise<unknown> };
}

export class AzureFoundryModelProvider implements ModelProvider {
  readonly id = MODEL;
  readonly #client: FoundryClient;

  private constructor(client: FoundryClient) {
    this.#client = client;
  }

  static async create(options: AzureFoundryOptions): Promise<AzureFoundryModelProvider> {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(FOUNDRY_PACKAGE)) as Record<string, unknown>;
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
        throw new Error(
          `Azure Foundry backend requires the '${FOUNDRY_PACKAGE}' package to be installed`,
          { cause: err },
        );
      }
      // Import failed for a reason other than a missing module (broken transitive
      // dependency, ESM/CJS resolution error, throwing top-level side effect).
      // Surface the real diagnostic instead of the misleading 'not installed' message.
      throw new Error(
        `Azure Foundry backend failed to load the '${FOUNDRY_PACKAGE}' package: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
    const Ctor = (mod["default"] ?? mod["AnthropicFoundry"]) as
      | (new (opts: AzureFoundryOptions) => FoundryClient)
      | undefined;
    if (!Ctor) throw new Error(`'${FOUNDRY_PACKAGE}' did not export an AnthropicFoundry client`);
    return new AzureFoundryModelProvider(new Ctor(options));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const message = (await this.#client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: request.system,
      messages: [{ role: "user", content: request.input }],
    })) as { model: string; stop_reason?: string; content: Array<{ type: string; text?: string }> };

    // See anthropic-cli: a truncated response parses to "no findings", so fail
    // rather than silently under-report.
    if (message.stop_reason === "max_tokens") {
      throw new Error(`model response truncated at max_tokens (${MAX_TOKENS}); cannot trust a partial result`);
    }

    let text = "";
    for (const block of message.content) {
      if (block.type === "text" && block.text) text += block.text;
    }
    return { modelId: message.model, text };
  }
}

/** Generous enough for the analyzer's JSON array of up to 25 findings. */
const MAX_TOKENS = 4096;
