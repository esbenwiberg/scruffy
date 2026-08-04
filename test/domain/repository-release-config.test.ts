import { describe, expect, it } from "vitest";
import {
  computeReleaseConfigDigest,
  parseRepositoryReleaseConfig,
  RELEASE_CONFIG_PATH,
  SCRUFFY_RELEASE_WORKFLOW_PATHS,
  type RepositoryReleaseConfigErrorCode,
} from "../../src/domain/release/repository-config.js";

/**
 * The repository release configuration is UNTRUSTED candidate content. The parser's
 * whole job is to accept ONLY a non-empty, unique list of canonical
 * `.github/workflows/*.yml` paths at version 1 and reject every weakening or
 * malformed shape. The obvious broken implementation — a permissive YAML object, or
 * one that allows an empty workflow list — must fail the mutation cases below.
 */

function reject(raw: string): RepositoryReleaseConfigErrorCode {
  const result = parseRepositoryReleaseConfig(raw);
  if (result.ok) throw new Error(`expected rejection but parsed: ${JSON.stringify(result.config)}`);
  return result.code;
}

describe("repository release config parsing", () => {
  it("uses the fixed service-owned configuration path", () => {
    expect(RELEASE_CONFIG_PATH).toBe(".github/scruffy-release.yml");
  });

  it("accepts the minimal valid schema (one workflow)", () => {
    const result = parseRepositoryReleaseConfig(
      ["version: 1", "requiredWorkflows:", "  - .github/workflows/ci.yml"].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({ version: 1, requiredWorkflows: [".github/workflows/ci.yml"] });
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts several workflows and canonicalizes them into a sorted unique list", () => {
    const result = parseRepositoryReleaseConfig(
      [
        "version: 1",
        "requiredWorkflows:",
        "  - .github/workflows/zebra.yml",
        "  - .github/workflows/alpha.yaml",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.requiredWorkflows).toEqual([
      ".github/workflows/alpha.yaml",
      ".github/workflows/zebra.yml",
    ]);
  });

  it("produces an order-independent digest but distinguishes different sets", () => {
    const a = parseRepositoryReleaseConfig(
      [
        "version: 1",
        "requiredWorkflows:",
        "  - .github/workflows/a.yml",
        "  - .github/workflows/b.yml",
      ].join("\n"),
    );
    const reordered = parseRepositoryReleaseConfig(
      [
        "version: 1",
        "requiredWorkflows:",
        "  - .github/workflows/b.yml",
        "  - .github/workflows/a.yml",
      ].join("\n"),
    );
    const different = parseRepositoryReleaseConfig(
      [
        "version: 1",
        "requiredWorkflows:",
        "  - .github/workflows/a.yml",
        "  - .github/workflows/c.yml",
      ].join("\n"),
    );
    expect(a.ok && reordered.ok && different.ok).toBe(true);
    if (!a.ok || !reordered.ok || !different.ok) return;
    // Reordering the same set is not a semantic change.
    expect(a.digest).toBe(reordered.digest);
    // A different set is a different identity.
    expect(a.digest).not.toBe(different.digest);
    // The digest is derived purely from the canonical parsed value.
    expect(a.digest).toBe(computeReleaseConfigDigest(a.config));
  });

  it("rejects an empty or whitespace-only file", () => {
    expect(reject("")).toBe("empty");
    expect(reject("   \n  \n")).toBe("empty");
  });

  it("rejects an empty required-workflows list", () => {
    expect(reject(["version: 1", "requiredWorkflows: []"].join("\n"))).toBe(
      "empty_required_workflows",
    );
    expect(reject(["version: 1", "requiredWorkflows:"].join("\n"))).toBe(
      "missing_required_workflows",
    );
  });

  it("rejects a missing required-workflows key", () => {
    expect(reject("version: 1")).toBe("missing_required_workflows");
  });

  it("rejects unknown keys (no repository-owned policy fields)", () => {
    const raw = [
      "version: 1",
      "requiredWorkflows:",
      "  - .github/workflows/ci.yml",
      "branch: main",
      "environment: production",
    ].join("\n");
    expect(reject(raw)).toBe("unknown_keys");
  });

  it("rejects unknown or non-numeric versions", () => {
    expect(
      reject(["version: 2", "requiredWorkflows:", "  - .github/workflows/ci.yml"].join("\n")),
    ).toBe("unknown_version");
    expect(
      reject(['version: "1"', "requiredWorkflows:", "  - .github/workflows/ci.yml"].join("\n")),
    ).toBe("unknown_version");
    expect(reject(["requiredWorkflows:", "  - .github/workflows/ci.yml"].join("\n"))).toBe(
      "unknown_version",
    );
  });

  it("rejects duplicate keys rather than silently taking the last", () => {
    const raw = [
      "version: 1",
      "version: 1",
      "requiredWorkflows:",
      "  - .github/workflows/ci.yml",
    ].join("\n");
    expect(reject(raw)).toBe("yaml_error");
  });

  it("rejects YAML aliases and anchors", () => {
    const raw = [
      "version: 1",
      "requiredWorkflows:",
      "  - &anchor .github/workflows/ci.yml",
      "  - *anchor",
    ].join("\n");
    expect(reject(raw)).toBe("yaml_unsafe");
  });

  it("rejects merge keys", () => {
    const raw = ["base: &b {version: 1}", "cfg:", "  <<: *b"].join("\n");
    expect(reject(raw)).toBe("yaml_unsafe");
  });

  it("rejects unsafe / custom tags", () => {
    expect(reject(["version: 1", "requiredWorkflows: !!python/object x"].join("\n"))).toBe(
      "yaml_unsafe",
    );
  });

  it("rejects a non-mapping top-level document", () => {
    expect(reject("- .github/workflows/ci.yml")).toBe("not_a_mapping");
    expect(reject("just a string")).toBe("not_a_mapping");
  });

  it("rejects non-string workflow entries", () => {
    expect(reject(["version: 1", "requiredWorkflows:", "  - 42"].join("\n"))).toBe(
      "invalid_workflow_path",
    );
    expect(reject(["version: 1", "requiredWorkflows:", "  - true"].join("\n"))).toBe(
      "invalid_workflow_path",
    );
    expect(
      reject(["version: 1", "requiredWorkflows:", "  - [.github/workflows/ci.yml]"].join("\n")),
    ).toBe("invalid_workflow_path");
  });

  it("rejects malformed or traversing workflow paths", () => {
    const malformed = [
      ".github/workflows/../../etc/passwd.yml", // parent traversal
      "/.github/workflows/ci.yml", // absolute
      ".github/workflows/sub/ci.yml", // nested directory (not directly under workflows)
      ".github/workflows/ci.txt", // wrong extension
      ".github/workflows/ci", // no extension
      "workflows/ci.yml", // wrong prefix
      ".github/actions/ci.yml", // an action, not a workflow
      ".github/scruffy-release.yml", // the config file itself is not a workflow
      ".github/workflows/ci .yml", // interior whitespace
      ".github/workflows/.yml", // empty filename
      ".github\\workflows\\ci.yml", // backslash separators
    ];
    for (const path of malformed) {
      const raw = ["version: 1", "requiredWorkflows:", `  - ${JSON.stringify(path)}`].join("\n");
      expect(reject(raw), `expected ${path} to be rejected`).toBe("invalid_workflow_path");
    }
  });

  it("rejects duplicate workflow paths", () => {
    const raw = [
      "version: 1",
      "requiredWorkflows:",
      "  - .github/workflows/ci.yml",
      "  - .github/workflows/ci.yml",
    ].join("\n");
    expect(reject(raw)).toBe("duplicate_workflow_path");
  });

  it("rejects the Scruffy release workflow as its own prerequisite", () => {
    for (const reserved of SCRUFFY_RELEASE_WORKFLOW_PATHS) {
      const raw = ["version: 1", "requiredWorkflows:", `  - ${reserved}`].join("\n");
      expect(reject(raw), `expected ${reserved} to be self-referential`).toBe("self_reference");
    }
    // Case-insensitive defense against a trivial casing evasion of the reserved name.
    const raw = [
      "version: 1",
      "requiredWorkflows:",
      "  - .github/workflows/Scruffy-Release.yml",
    ].join("\n");
    expect(reject(raw)).toBe("self_reference");
  });
});
