import { describe, expect, it } from "vitest";
import { listInstallationRepositories, runDoctor } from "../../scripts/app-doctor.js";
import type { GithubAppConfig } from "../../src/providers/scm/github-app-auth.js";
import type { GhApi } from "../../src/providers/scm/github-app.js";

/**
 * Offline contract test for the read-only App doctor. A stubbed `GhApi` returns
 * recorded `/installation/repositories` shapes and records every route, so the
 * pagination, the parse discipline, and — critically — the NO-WRITES property
 * are pinned without any network or real App credentials.
 */

type Call = { route: string; params: Record<string, unknown> | undefined };

function stub(pages: unknown[]): { api: GhApi; calls: Call[] } {
  const calls: Call[] = [];
  let page = 0;
  const api: GhApi = async (route, params) => {
    calls.push({ route, params });
    const data = pages[page] ?? { repositories: [] };
    page += 1;
    return { status: 200, data };
  };
  return { api, calls };
}

const CONFIG: GithubAppConfig = {
  appId: "123",
  installationId: "456",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
};

const repoPage = (
  names: string[],
): { repositories: { full_name: string; private: boolean }[] } => ({
  repositories: names.map((full_name) => ({ full_name, private: false })),
});

describe("listInstallationRepositories", () => {
  it("lists a single short page of repositories", async () => {
    const { api } = stub([repoPage(["esbenwiberg/scruffy", "scruffy/poison"])]);
    const repos = await listInstallationRepositories(api);
    expect(repos.map((r) => r.fullName)).toEqual(["esbenwiberg/scruffy", "scruffy/poison"]);
  });

  it("issues ONLY GET requests — the doctor never writes", async () => {
    const { api, calls } = stub([repoPage(["esbenwiberg/scruffy"])]);
    await listInstallationRepositories(api);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.route.startsWith("GET ")).toBe(true);
    }
  });

  it("paginates until a short page, then stops", async () => {
    const full = Array.from({ length: 100 }, (_, i) => `org/repo-${i}`);
    const { api, calls } = stub([repoPage(full), repoPage(["org/last"])]);
    const repos = await listInstallationRepositories(api);
    expect(repos).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toMatchObject({ page: 2 });
  });

  it("throws on an unexpected response shape rather than reporting an empty scope", async () => {
    const { api } = stub([{ not: "an installation repos payload" }]);
    await expect(listInstallationRepositories(api)).rejects.toThrow(/unexpected .* response shape/);
  });

  it("propagates an API failure (auth error) instead of swallowing it", async () => {
    const api: GhApi = async () => {
      throw Object.assign(new Error("Bad credentials"), { status: 401 });
    };
    await expect(listInstallationRepositories(api)).rejects.toThrow(/Bad credentials/);
  });
});

describe("runDoctor", () => {
  it("reports the repositories in scope and never leaks the private key", async () => {
    const { api } = stub([repoPage(["esbenwiberg/scruffy"])]);
    const lines: string[] = [];
    const repos = await runDoctor(CONFIG, api, (m) => lines.push(m));
    const out = lines.join("\n");
    expect(repos.map((r) => r.fullName)).toEqual(["esbenwiberg/scruffy"]);
    expect(out).toContain("esbenwiberg/scruffy");
    expect(out).toContain("app id");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("reports an empty scope clearly instead of a misleading success", async () => {
    const { api } = stub([repoPage([])]);
    const lines: string[] = [];
    const repos = await runDoctor(CONFIG, api, (m) => lines.push(m));
    expect(repos).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/0 repositories/);
  });
});
