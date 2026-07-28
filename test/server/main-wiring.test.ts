import { afterEach, describe, expect, it } from "vitest";
import { createScmBackends } from "../../src/server/main.js";
import { GhCliScm } from "../../src/providers/scm/gh-cli.js";
import { GithubAppScmReader } from "../../src/providers/scm/github-app-reader.js";
import { GithubAppScmWriter } from "../../src/providers/scm/github-app.js";

/**
 * Proves the hosted entrypoint resolves and constructs BOTH the reader and the
 * writer through the factory (the fix for main.ts hard-coding a gh-cli reader).
 * The App path is exercised with a throwaway PEM so no real credentials — and no
 * `gh` login / GH_TOKEN — are required.
 */

// A syntactically-valid but throwaway PEM. @octokit/auth-app defers key use to
// the first request, so construction succeeds without any network or real key.
const FAKE_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "not-a-real-key",
  "-----END RSA PRIVATE KEY-----",
].join("\\n");

const APP_ENV = {
  SCRUFFY_GH_APP_ID: "123",
  SCRUFFY_GH_APP_INSTALLATION_ID: "456",
  SCRUFFY_GH_APP_PRIVATE_KEY: FAKE_PEM,
};

const APP_KEYS = [
  "SCRUFFY_GH_APP_ID",
  "SCRUFFY_GH_APP_INSTALLATION_ID",
  "SCRUFFY_GH_APP_PRIVATE_KEY",
] as const;

afterEach(() => {
  for (const key of APP_KEYS) delete process.env[key];
});

describe("createScmBackends", () => {
  it("defaults to gh-cli for BOTH reader and writer — the shadow mode stays the default", () => {
    const { scmReader, scmWriter, readerBackend, writerBackend } = createScmBackends({});
    expect(readerBackend).toBe("gh-cli");
    expect(writerBackend).toBe("gh-cli");
    expect(scmReader).toBeInstanceOf(GhCliScm);
    expect(scmWriter).toBeInstanceOf(GhCliScm);
  });

  it("constructs the App reader AND writer when both backends are github-app, without gh or GH_TOKEN", () => {
    // App credentials come from process.env (githubAppConfigFromEnv); no GH_TOKEN
    // and no gh session are set, proving App-only hosted operation.
    for (const key of APP_KEYS) process.env[key] = APP_ENV[key];
    const { scmReader, scmWriter, readerBackend, writerBackend } = createScmBackends({
      SCRUFFY_SCM_READER: "github-app",
      SCRUFFY_SCM_WRITER: "github-app",
    });
    expect(readerBackend).toBe("github-app");
    expect(writerBackend).toBe("github-app");
    expect(scmReader).toBeInstanceOf(GithubAppScmReader);
    expect(scmWriter).toBeInstanceOf(GithubAppScmWriter);
    expect(scmReader).not.toBeInstanceOf(GhCliScm);
    expect(scmWriter).not.toBeInstanceOf(GhCliScm);
  });

  it("selects reader and writer independently (App reader, gh-cli writer)", () => {
    for (const key of APP_KEYS) process.env[key] = APP_ENV[key];
    const { scmReader, scmWriter } = createScmBackends({ SCRUFFY_SCM_READER: "github-app" });
    expect(scmReader).toBeInstanceOf(GithubAppScmReader);
    expect(scmWriter).toBeInstanceOf(GhCliScm);
  });

  it("fails loudly on an unknown reader value — an operator typo must not silently downgrade", () => {
    expect(() => createScmBackends({ SCRUFFY_SCM_READER: "octokit" })).toThrow(
      /unknown SCRUFFY_SCM_READER/,
    );
  });

  it("fails loudly on an unknown writer value", () => {
    expect(() => createScmBackends({ SCRUFFY_SCM_WRITER: "octokit" })).toThrow(
      /unknown SCRUFFY_SCM_WRITER/,
    );
  });

  it("fails loudly when the App reader is selected but its credentials are missing", () => {
    // No SCRUFFY_GH_APP_* set — the factory must throw rather than build a
    // half-configured reader.
    expect(() => createScmBackends({ SCRUFFY_SCM_READER: "github-app" })).toThrow(
      /SCRUFFY_GH_APP_ID/,
    );
  });
});
