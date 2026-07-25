import type { ScmReader, ScmWriter } from "./port.js";
import { GhCliScm } from "./gh-cli.js";
import { GithubAppScmWriter } from "./github-app.js";
import { GithubAppScmReader } from "./github-app-reader.js";
import { createGithubAppApi, githubAppConfigFromEnv } from "./github-app-auth.js";

/**
 * Selects the SCM writer backend. Defaults to the gh-cli shadow-status adapter
 * (a developer's own session, statuses only). `SCRUFFY_SCM_WRITER` chooses:
 *   gh-cli     — shadow commit statuses via the authenticated `gh` session
 *   github-app — real check-runs + fix PRs via a GitHub App installation
 *                (the separately privileged write credential, ADR-0001)
 */
export type ScmWriterBackend = "gh-cli" | "github-app";

export function resolveScmWriterBackend(env: Record<string, string | undefined> = process.env): ScmWriterBackend {
  const value = env.SCRUFFY_SCM_WRITER;
  if (!value) return "gh-cli";
  if (value === "gh-cli" || value === "github-app") return value;
  // A non-empty but unrecognized value is an operator typo — fail loudly rather
  // than silently falling back to a differently-privileged writer.
  throw new Error(`unknown SCRUFFY_SCM_WRITER '${value}'`);
}

export function createScmWriter(
  backend: ScmWriterBackend = resolveScmWriterBackend(),
  options: { targetUrl?: string } = {},
): ScmWriter {
  switch (backend) {
    case "gh-cli":
      return new GhCliScm(options.targetUrl !== undefined ? { targetUrl: options.targetUrl } : {});
    case "github-app":
      return new GithubAppScmWriter({ api: createGithubAppApi(githubAppConfigFromEnv()) });
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}

/**
 * Selects the SCM reader backend, independent of the writer (ADR-0001: reads and
 * writes sit on different credentials). Defaults to the gh-cli reader (a
 * developer's own session). `SCRUFFY_SCM_READER` chooses:
 *   gh-cli     — reads via the authenticated `gh` session
 *   github-app — reads via a GitHub App installation (a hosted deployment reads
 *                without depending on any human's `gh` login)
 */
export type ScmReaderBackend = "gh-cli" | "github-app";

export function resolveScmReaderBackend(env: Record<string, string | undefined> = process.env): ScmReaderBackend {
  const value = env.SCRUFFY_SCM_READER;
  if (!value) return "gh-cli";
  if (value === "gh-cli" || value === "github-app") return value;
  // A non-empty but unrecognized value is an operator typo — fail loudly rather
  // than silently falling back to a differently-credentialed reader.
  throw new Error(`unknown SCRUFFY_SCM_READER '${value}'`);
}

export function createScmReader(
  backend: ScmReaderBackend = resolveScmReaderBackend(),
  options: { targetUrl?: string } = {},
): ScmReader {
  switch (backend) {
    case "gh-cli":
      return new GhCliScm(options.targetUrl !== undefined ? { targetUrl: options.targetUrl } : {});
    case "github-app":
      return new GithubAppScmReader({ api: createGithubAppApi(githubAppConfigFromEnv()) });
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}
