import { describe, expect, it } from "vitest";
import {
  createScmInstallationReader,
  createScmReader,
  createScmWriter,
  resolveScmReaderBackend,
  resolveScmWriterBackend,
} from "../../src/providers/scm/factory.js";
import { githubAppConfigFromEnv } from "../../src/providers/scm/github-app-auth.js";
import { GhCliScm } from "../../src/providers/scm/gh-cli.js";

describe("resolveScmWriterBackend", () => {
  it("defaults to gh-cli when unset or empty — nothing writes through the App unasked", () => {
    expect(resolveScmWriterBackend({})).toBe("gh-cli");
    expect(resolveScmWriterBackend({ SCRUFFY_SCM_WRITER: "" })).toBe("gh-cli");
  });

  it("selects the configured backend", () => {
    expect(resolveScmWriterBackend({ SCRUFFY_SCM_WRITER: "gh-cli" })).toBe("gh-cli");
    expect(resolveScmWriterBackend({ SCRUFFY_SCM_WRITER: "github-app" })).toBe("github-app");
  });

  it("throws on an unknown value — an operator typo must not silently pick a differently-privileged writer", () => {
    expect(() => resolveScmWriterBackend({ SCRUFFY_SCM_WRITER: "octokit" })).toThrow(/unknown SCRUFFY_SCM_WRITER/);
  });
});

describe("createScmWriter", () => {
  it("builds the gh-cli writer without any App env", () => {
    expect(createScmWriter("gh-cli")).toBeInstanceOf(GhCliScm);
  });
});

describe("resolveScmReaderBackend", () => {
  it("defaults to gh-cli when unset or empty — reads stay on the developer session unasked", () => {
    expect(resolveScmReaderBackend({})).toBe("gh-cli");
    expect(resolveScmReaderBackend({ SCRUFFY_SCM_READER: "" })).toBe("gh-cli");
  });

  it("selects the configured backend", () => {
    expect(resolveScmReaderBackend({ SCRUFFY_SCM_READER: "gh-cli" })).toBe("gh-cli");
    expect(resolveScmReaderBackend({ SCRUFFY_SCM_READER: "github-app" })).toBe("github-app");
  });

  it("throws on an unknown value — an operator typo must not silently pick a differently-credentialed reader", () => {
    expect(() => resolveScmReaderBackend({ SCRUFFY_SCM_READER: "octokit" })).toThrow(/unknown SCRUFFY_SCM_READER/);
  });
});

describe("createScmReader", () => {
  it("builds the gh-cli reader without any App env", () => {
    expect(createScmReader("gh-cli")).toBeInstanceOf(GhCliScm);
  });
});

describe("githubAppConfigFromEnv", () => {
  const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";

  it("reads id, installation, and PEM key from env, restoring escaped newlines", () => {
    const config = githubAppConfigFromEnv({
      SCRUFFY_GH_APP_ID: "123",
      SCRUFFY_GH_APP_INSTALLATION_ID: "456",
      SCRUFFY_GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
    });
    expect(config).toEqual({ appId: "123", installationId: "456", privateKey: PEM });
  });

  it("fails loudly when a credential is missing", () => {
    expect(() => githubAppConfigFromEnv({})).toThrow(/SCRUFFY_GH_APP_ID/);
    expect(() => githubAppConfigFromEnv({ SCRUFFY_GH_APP_ID: "123", SCRUFFY_GH_APP_INSTALLATION_ID: "456" })).toThrow(
      /SCRUFFY_GH_APP_PRIVATE_KEY/,
    );
  });

  it("rejects a key that is not a PEM (catches pointing the var at the wrong secret)", () => {
    expect(() =>
      githubAppConfigFromEnv({
        SCRUFFY_GH_APP_ID: "123",
        SCRUFFY_GH_APP_INSTALLATION_ID: "456",
        SCRUFFY_GH_APP_PRIVATE_KEY: "ghp_notakey",
      }),
    ).toThrow(/PEM/);
  });
});

describe("createScmInstallationReader", () => {
  it("returns null for gh-cli — a developer session cannot enumerate an App installation", () => {
    // Null, not a throwing stub: a shadow-status-only deployment is legitimate, and
    // the CORRECT consequence is that the nightly scheduler is not started at all.
    // The alternative — inventing a repository list, or defaulting the branch to
    // `main` — would review the wrong thing and call the result a night's work.
    expect(createScmInstallationReader("gh-cli")).toBeNull();
  });
});
