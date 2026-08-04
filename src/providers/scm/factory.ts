import type {
  ScmInstallationReader,
  ScmLifecycleReader,
  ScmReader,
  ScmWriter,
  WorkflowApprovalReader,
  WorkflowRunReader,
} from "./port.js";
import { GhCliScm } from "./gh-cli.js";
import { GithubAppScmWriter } from "./github-app.js";
import { GithubAppScmReader } from "./github-app-reader.js";
import { GithubAppLifecycleReader } from "./github-app-lifecycle.js";
import { createGithubAppApi, githubAppConfigFromEnv } from "./github-app-auth.js";
import { GithubAppWorkflowApprovalReader } from "./github-app-approvals.js";
import { GithubAppWorkflowRunReader } from "./github-app-workflow-runs.js";

/**
 * Selects the SCM writer backend. Defaults to the gh-cli shadow-status adapter
 * (a developer's own session, statuses only). `SCRUFFY_SCM_WRITER` chooses:
 *   gh-cli     — shadow commit statuses via the authenticated `gh` session.
 *                Fix PRs and nightly ISSUE publication are refused loudly (never
 *                faked) — see GhCliScm; issue effects dead-letter with that reason.
 *   github-app — real check-runs, fix PRs, and nightly parent/child issues via a
 *                GitHub App installation (the separately privileged write
 *                credential, ADR-0001; needs `Issues: write`)
 */
export type ScmWriterBackend = "gh-cli" | "github-app";

export function resolveScmWriterBackend(
  env: Record<string, string | undefined> = process.env,
): ScmWriterBackend {
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

export function resolveScmReaderBackend(
  env: Record<string, string | undefined> = process.env,
): ScmReaderBackend {
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

/**
 * The read side of the fix lifecycle: PR state, CI evidence for an exact sha,
 * branch heads, and issue state. Separate from `createScmReader` because it is a
 * strictly larger capability than reviewing a commit, and only the App backend
 * has it — `gh-cli` returns null, which the caller must treat as "this deployment
 * cannot reconcile fix PRs" rather than as "there is nothing to reconcile".
 *
 * Returning null instead of a throwing stub is deliberate: a deployment that only
 * posts shadow statuses is a legitimate configuration, and it should be visible
 * at wiring time, not as a per-tick error from a loop nobody reads.
 */
export function createScmLifecycleReader(
  backend: ScmReaderBackend = resolveScmReaderBackend(),
): ScmLifecycleReader | null {
  switch (backend) {
    case "gh-cli":
      return null;
    case "github-app":
      return new GithubAppLifecycleReader({ api: createGithubAppApi(githubAppConfigFromEnv()) });
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}

/**
 * ENROLLMENT: the installed-repository listing and default-branch head resolution a
 * central nightly scheduler runs on. Same null-for-gh-cli shape as
 * `createScmLifecycleReader`, and for a stronger reason.
 *
 * App INSTALLATION IS ENROLLMENT, so this listing is the only legitimate source of
 * "which repositories does Scruffy review tonight". A developer's `gh` session
 * cannot answer that question — `/installation/repositories` needs an installation
 * token — and the alternatives are all worse than saying so: a hardcoded repository
 * list, or a hardcoded `main`, both of which would review the wrong thing (or
 * nothing) and report the result as a night's work.
 *
 * Returning null makes that visible at wiring time. The scheduler is then simply
 * not started, and the manual `scruffy:nightly` command remains the supported way
 * to drive a controlled run on a gh-cli deployment.
 */
export function createWorkflowApprovalReader(
  backend: ScmReaderBackend = resolveScmReaderBackend(),
): WorkflowApprovalReader | null {
  switch (backend) {
    case "gh-cli":
      return null;
    case "github-app":
      return new GithubAppWorkflowApprovalReader(createGithubAppApi(githubAppConfigFromEnv()));
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}

export function createScmInstallationReader(
  backend: ScmReaderBackend = resolveScmReaderBackend(),
): ScmInstallationReader | null {
  switch (backend) {
    case "gh-cli":
      return null;
    case "github-app":
      return new GithubAppScmReader({ api: createGithubAppApi(githubAppConfigFromEnv()) });
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}

/**
 * The narrow, read-only Actions capability that resolves required-workflow run
 * evidence for an exact candidate. Same null-for-gh-cli shape as the other
 * App-only readers: resolving a workflow's runs needs the App installation's
 * `Actions: read`, which a developer's `gh` session is not the right credential
 * for, so a shadow-status deployment is told at wiring time that it cannot supply
 * workflow-prerequisite evidence rather than degrading into a false signal.
 */
export function createWorkflowRunReader(
  backend: ScmReaderBackend = resolveScmReaderBackend(),
): WorkflowRunReader | null {
  switch (backend) {
    case "gh-cli":
      return null;
    case "github-app":
      return new GithubAppWorkflowRunReader(createGithubAppApi(githubAppConfigFromEnv()));
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}
