import type { ModelProvider, ModelRequest, ModelResponse } from "./port.js";

/**
 * Deterministic fake model. Returns a canned response keyed by promptVersion.
 * Never makes a network call. This is the only model implementation wired on the
 * skeleton critical path.
 */
export class FakeModelProvider implements ModelProvider {
  readonly id = "fake-model";
  readonly #responses: Map<string, string>;

  constructor(responses: Record<string, string> = {}) {
    this.#responses = new Map(Object.entries(responses));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return {
      modelId: this.id,
      text: this.#responses.get(request.promptVersion) ?? "",
    };
  }
}
