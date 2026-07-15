/**
 * Model-provider port. The domain never talks to a model SDK directly.
 *
 * Three implementations sit behind this (see project decision):
 *  - local dev:  Claude CLI / Codex CLI auth (reuse existing CLI session creds,
 *                no raw API keys in config);
 *  - deployed:   Azure AI Foundry;
 *  - tests:      the deterministic fake — never a live call.
 *
 * Only the fake is wired on the walking-skeleton critical path. Real adapters
 * land when a gate runs against a live model.
 */

export interface ModelRequest {
  /** Stable prompt identity, versioned in policy — not a free-form string. */
  promptVersion: string;
  system: string;
  input: string;
}

export interface ModelResponse {
  modelId: string;
  text: string;
}

export interface ModelProvider {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
