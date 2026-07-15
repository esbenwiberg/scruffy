import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider, ModelRequest, ModelResponse } from "./port.js";

/**
 * Local-dev model backend. A zero-arg `new Anthropic()` resolves credentials
 * from the environment in precedence order: ANTHROPIC_API_KEY, then
 * ANTHROPIC_AUTH_TOKEN, then the active `ant auth login` / Claude CLI profile on
 * disk. So a developer who has logged in with the CLI needs no API key in
 * config — which is exactly the "reuse CLI auth" requirement, and keeps secrets
 * out of the repo.
 *
 * The deployed service uses the Azure Foundry backend instead (see
 * azure-foundry.ts); tests use the deterministic fake. This adapter is never on
 * the deterministic critical path.
 */

const MODEL = "claude-opus-4-8";

export class AnthropicCliModelProvider implements ModelProvider {
  readonly id = MODEL;
  readonly #client: Anthropic;

  constructor(client: Anthropic = new Anthropic()) {
    this.#client = client;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const message = await this.#client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: request.system,
      messages: [{ role: "user", content: request.input }],
    });

    let text = "";
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
    }
    return { modelId: message.model, text };
  }
}
