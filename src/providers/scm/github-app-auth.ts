import { readFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import type { GhApi } from "./github-app.js";

/**
 * GitHub App installation auth for the effects writer (ADR-0001's separate,
 * narrowly privileged write credential). Credentials come from the environment
 * at runtime — never from config files in the repo (no-secrets rule):
 *
 *   SCRUFFY_GH_APP_ID               — the App's numeric id
 *   SCRUFFY_GH_APP_INSTALLATION_ID  — the installation on the target org/repos
 *   SCRUFFY_GH_APP_PRIVATE_KEY      — the App's PEM private key, OR
 *   SCRUFFY_GH_APP_PRIVATE_KEY_FILE — path to the PEM file (wins if both set)
 *
 * `@octokit/auth-app` handles the App JWT → installation-token exchange and
 * token refresh; requests authenticate via its request hook, so the token never
 * passes through our code.
 */

export interface GithubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

export function githubAppConfigFromEnv(env: Record<string, string | undefined> = process.env): GithubAppConfig {
  const appId = required(env, "SCRUFFY_GH_APP_ID");
  const installationId = required(env, "SCRUFFY_GH_APP_INSTALLATION_ID");

  const keyFile = env.SCRUFFY_GH_APP_PRIVATE_KEY_FILE;
  // Env vars often carry PEMs with literal "\n" escapes; restore real newlines.
  const privateKey = keyFile ? readFileSync(keyFile, "utf8") : required(env, "SCRUFFY_GH_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  if (!privateKey.includes("-----BEGIN")) {
    throw new Error("SCRUFFY_GH_APP_PRIVATE_KEY(_FILE) does not look like a PEM private key");
  }

  return { appId, installationId, privateKey };
}

export function createGithubAppApi(config: GithubAppConfig): GhApi {
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    installationId: config.installationId,
  });
  const authedRequest = request.defaults({ request: { hook: auth.hook } });
  return async (route, params) => {
    const response = await authedRequest(route, params);
    return { status: response.status, data: response.data as unknown };
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set for the github-app SCM writer`);
  return value;
}
