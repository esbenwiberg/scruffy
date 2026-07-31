import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";
import type { ModelProvider, ModelRequest, ModelResponse } from "./port.js";

export const AZURE_FOUNDRY_SCOPE = "https://ai.azure.com/.default";
const MAX_TOKENS = 4096;

export interface AzureFoundryOptions {
  /** e.g. https://resource.services.ai.azure.com/anthropic */
  baseUrl: string;
  /** The deployed model name, not an assumed catalogue model id. */
  deployment: string;
  credential?: TokenCredential;
  client?: FoundryClient;
}

interface FoundryMessage {
  model: string;
  stop_reason?: string | null;
  content: Array<{ type: string; text?: string }>;
}

interface FoundryClient {
  messages: { create(args: unknown): Promise<FoundryMessage> };
}

/**
 * Hosted Microsoft Foundry backend. Authentication is keyless: the Container
 * App's managed identity obtains an Entra token for the Foundry inference scope.
 * No API-key environment variable is read or accepted here.
 */
export class AzureFoundryModelProvider implements ModelProvider {
  readonly id: string;
  readonly #client: FoundryClient;
  readonly #deployment: string;

  private constructor(options: AzureFoundryOptions) {
    this.#deployment = options.deployment;
    this.id = `azure-foundry:${options.deployment}`;
    if (options.client !== undefined) {
      this.#client = options.client;
      return;
    }
    const credential = options.credential ?? new DefaultAzureCredential();
    this.#client = new AnthropicFoundry({
      baseURL: normalizeBaseUrl(options.baseUrl),
      azureADTokenProvider: createAzureTokenProvider(credential),
    }) as unknown as FoundryClient;
  }

  static async create(options: AzureFoundryOptions): Promise<AzureFoundryModelProvider> {
    if (!options.deployment.trim()) throw new Error("Azure Foundry deployment must be configured");
    normalizeBaseUrl(options.baseUrl);
    return new AzureFoundryModelProvider({ ...options, deployment: options.deployment.trim() });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const message = await this.#client.messages.create({
      model: this.#deployment,
      max_tokens: MAX_TOKENS,
      system: request.system,
      messages: [{ role: "user", content: request.input }],
    });
    if (message.stop_reason === "max_tokens") {
      throw new Error(
        `model response truncated at max_tokens (${MAX_TOKENS}); cannot trust a partial result`,
      );
    }
    let text = "";
    for (const block of message.content) {
      if (block.type === "text" && block.text) text += block.text;
    }
    if (!text.trim())
      throw new Error("Azure Foundry returned no text; cannot treat empty output as clean");
    return { modelId: message.model || this.id, text };
  }
}

export function createAzureTokenProvider(credential: TokenCredential): () => Promise<string> {
  return async () => {
    const token = await credential.getToken(AZURE_FOUNDRY_SCOPE);
    if (token === null || token.token.length === 0) {
      throw new Error("managed identity returned no Azure Foundry access token");
    }
    return token.token;
  };
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Azure Foundry base URL must use HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Azure Foundry base URL must not contain credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/, "");
}
