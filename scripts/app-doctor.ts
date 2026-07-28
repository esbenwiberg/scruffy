import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  createGithubAppApi,
  githubAppConfigFromEnv,
  type GithubAppConfig,
} from "../src/providers/scm/github-app-auth.js";
import type { GhApi } from "../src/providers/scm/github-app.js";

/**
 * `npm run app:doctor` — a READ-ONLY GitHub App preflight for operators.
 *
 * It parses the same App configuration the writer/reader use
 * (SCRUFFY_GH_APP_ID, SCRUFFY_GH_APP_INSTALLATION_ID, and
 * SCRUFFY_GH_APP_PRIVATE_KEY / _FILE), authenticates as the installation, and
 * lists the repositories the installation can see. It performs NO writes — every
 * call is a GET — so it is safe to run against a live installation before the
 * first outward check-run. Missing or malformed credentials fail loudly with a
 * clear message and a non-zero exit, never a partial or misleading "ok".
 *
 * Use it to confirm, before the first webhook test, that the App is installed on
 * exactly the repositories you expect (e.g. only `esbenwiberg/scruffy` for the
 * initial shadow test). See docs/product/github-app-setup.md.
 */

/** GitHub caps `per_page` at 100; page defensively so a large install is complete. */
const PER_PAGE = 100;
/** Hard bound on pages — a runaway pagination loop must terminate. */
const MAX_PAGES = 50;

// ── Response schema (external boundary — parse, don't trust) ──────────────────

const InstallationReposPage = z.object({
  total_count: z.number().optional(),
  repositories: z.array(
    z.object({
      full_name: z.string(),
      private: z.boolean().optional(),
    }),
  ),
});

export interface InstallationRepo {
  fullName: string;
  private: boolean;
}

/**
 * List every repository the installation token can access via
 * `GET /installation/repositories`. Read-only and paginated; stops on a short
 * page. Throws on any API failure or unexpected shape rather than returning a
 * partial list that could read as "the App only sees these repos".
 */
export async function listInstallationRepositories(api: GhApi): Promise<InstallationRepo[]> {
  const repos: InstallationRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await api("GET /installation/repositories", { per_page: PER_PAGE, page });
    const parsed = InstallationReposPage.safeParse(res.data);
    if (!parsed.success) {
      throw new Error(
        `app:doctor: unexpected /installation/repositories response shape: ${parsed.error.message}`,
      );
    }
    for (const repo of parsed.data.repositories) {
      repos.push({ fullName: repo.full_name, private: repo.private ?? false });
    }
    if (parsed.data.repositories.length < PER_PAGE) break;
  }
  return repos;
}

/**
 * Run the read-only doctor: report the (non-secret) identifiers, authenticate,
 * and print the repositories in scope. `api` and `log` are injected so the flow
 * is testable offline. Returns the repositories so callers/tests can assert.
 */
export async function runDoctor(
  config: GithubAppConfig,
  api: GhApi,
  log: (message: string) => void,
): Promise<InstallationRepo[]> {
  log(`GitHub App doctor (read-only)`);
  log(`  app id          : ${config.appId}`);
  log(`  installation id : ${config.installationId}`);
  log(`  private key     : loaded (${config.privateKey.length} chars, PEM)`);
  log("");
  log("Authenticating as the installation and listing repositories in scope …");

  const repos = await listInstallationRepositories(api);

  if (repos.length === 0) {
    log("");
    log("No repositories in scope. The App is authenticated but installed on 0 repositories —");
    log("install it on the target repository (e.g. esbenwiberg/scruffy) and re-run.");
    return repos;
  }

  log("");
  log(`Repositories in scope (${repos.length}):`);
  for (const repo of repos) {
    log(`  - ${repo.fullName}${repo.private ? " (private)" : ""}`);
  }
  return repos;
}

async function main(): Promise<void> {
  let config: GithubAppConfig;
  try {
    config = githubAppConfigFromEnv();
  } catch (err) {
    console.error(`app:doctor: ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      "Set SCRUFFY_GH_APP_ID, SCRUFFY_GH_APP_INSTALLATION_ID, and SCRUFFY_GH_APP_PRIVATE_KEY_FILE (or SCRUFFY_GH_APP_PRIVATE_KEY).",
    );
    process.exit(1);
  }

  const api = createGithubAppApi(config);
  try {
    await runDoctor(config, api, (message) => console.log(message));
  } catch (err) {
    console.error("");
    console.error(
      `app:doctor: authentication or listing failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "Check the App id, installation id, and private key, and that the installation still exists.",
    );
    process.exit(1);
  }
}

// Only run when invoked as a script (`npm run app:doctor`); importing this module
// for its pure helpers (in tests) must not authenticate or hit the network.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
