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
    } catch {
      throw new Error(`Azure Foundry backend requires the '${FOUNDRY_PACKAGE}' package to be installed`);
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
      max_tokens: 1024,
      system: request.system,
      messages: [{ role: "user", content: request.input }],
    })) as { model: string; content: Array<{ type: string; text?: string }> };

    let text = "";
    for (const block of message.content) {
      if (block.type === "text" && block.text) text += block.text;
    }
    return { modelId: message.model, text };
  }
}
