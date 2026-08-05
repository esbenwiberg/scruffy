import { createHash } from "node:crypto";
import { isAlias, isNode, parseDocument, visit } from "yaml";

/**
 * Strict, version-1 parser for the repository-owned release-prerequisite file at
 * `.github/scruffy-release.yml`.
 *
 * The file is UNTRUSTED candidate content: a candidate can try to weaken its own
 * release prerequisites, so this parser is deliberately narrow. The ONLY thing a
 * repository gets to choose is a non-empty, unique list of canonical workflow paths
 * below `.github/workflows/`. Everything else — branch, event, result mapping,
 * approval, freshness, waiver — is service-owned and cannot be expressed here.
 *
 * Safety decisions (all fail-closed):
 *  - Parse with the YAML 1.2 `core` schema in `strict` mode. Duplicate map keys are
 *    a parser ERROR (billion-laughs / last-write-wins ambiguity), never merged.
 *  - `merge: false` disables `<<` merge-key expansion.
 *  - Aliases AND anchors are rejected by walking the parsed tree — the alias system
 *    is an amplification/aliasing vector we never need for a flat path list.
 *  - Any parser warning (e.g. an unresolved custom/unsafe tag like `!!python/...`)
 *    is treated as a hard rejection: a value we could not resolve safely is not a
 *    value we accept.
 *  - The top level must be a plain mapping with EXACTLY the known keys; unknown keys
 *    and unknown versions are rejected.
 *  - Every path is re-validated against a conservative allowlist; `..`, absolute
 *    paths, backslashes, whitespace, control characters, and nested directories are
 *    rejected so a path can never traverse out of `.github/workflows/`.
 *
 * A missing/malformed/empty/self-referential configuration is NOT an
 * exception-approvable failed workflow — it is authorization-ineligible. This parser
 * only reports the shape; the release-authority kernel decides eligibility.
 */

/** The fixed, service-owned location of the repository release-prerequisite file. */
export const RELEASE_CONFIG_PATH = ".github/scruffy-release.yml";

/**
 * Canonical paths that name Scruffy's own release-authority workflow. A repository
 * cannot list one of these as a prerequisite: the release-authority run would then
 * depend on itself, which can never resolve. Compared case-insensitively as
 * defense-in-depth against a trivial casing evasion of the reserved name.
 */
export const SCRUFFY_RELEASE_WORKFLOW_PATHS = [
  ".github/workflows/scruffy-release.yml",
  ".github/workflows/scruffy-release.yaml",
  ".github/workflows/release-authority-shadow.yml",
] as const;

/** The only accepted configuration shape (schema v1). */
export interface RepositoryReleaseConfigV1 {
  version: 1;
  /** Non-empty, unique, sorted canonical `.github/workflows/*.yml|.yaml` paths. */
  requiredWorkflows: string[];
}

/**
 * Stable reason codes for a rejected configuration. Presentation strings may change;
 * these codes are the durable contract later briefs branch on.
 */
export type RepositoryReleaseConfigErrorCode =
  | "empty"
  | "yaml_error"
  | "yaml_unsafe"
  | "not_a_mapping"
  | "unknown_keys"
  | "unknown_version"
  | "missing_required_workflows"
  | "empty_required_workflows"
  | "invalid_workflow_path"
  | "duplicate_workflow_path"
  | "self_reference";

export type RepositoryReleaseConfigParse =
  | { ok: true; config: RepositoryReleaseConfigV1; digest: string }
  | { ok: false; code: RepositoryReleaseConfigErrorCode; detail: string };

const KNOWN_KEYS = new Set(["version", "requiredWorkflows"]);

const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * A single, direct file under `.github/workflows/` ending in `.yml`/`.yaml`.
 * GitHub only executes workflows placed DIRECTLY in that directory, so a nested
 * path is not a real workflow and is rejected rather than silently accepted.
 */
function normalizeWorkflowPath(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  // No surrounding or interior whitespace, backslashes, or control characters:
  // these are the classic ways to smuggle a different path past a naive check.
  if (entry !== entry.trim()) return null;
  if (/\s/.test(entry) || entry.includes("\\") || hasControlChar(entry)) return null;
  if (entry.includes("..")) return null; // no parent traversal, anywhere
  if (entry.startsWith("/")) return null; // repository-relative only, never absolute

  const segments = entry.split("/");
  if (segments.length !== 3) return null; // exactly `.github` / `workflows` / <file>
  if (segments[0] !== ".github" || segments[1] !== "workflows") return null;

  const file = segments[2]!;
  if (!/^[A-Za-z0-9._-]+\.(yml|yaml)$/.test(file)) return null;
  // A leading dot would make the filename an unintended dotfile; require a real name.
  if (file.startsWith(".")) return null;
  return entry;
}

function isReservedSelfPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SCRUFFY_RELEASE_WORKFLOW_PATHS.some((reserved) => reserved.toLowerCase() === lower);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Content digest over the CANONICAL parsed configuration (version + sorted paths).
 * Two files that differ only in key/entry order, comments, or whitespace produce the
 * same digest, so authority-change detection reacts to SEMANTIC changes, not cosmetic
 * ones. Reordering a workflow list is not a policy change.
 */
export function computeReleaseConfigDigest(config: RepositoryReleaseConfigV1): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(config)))
    .digest("hex");
}

export function parseRepositoryReleaseConfig(raw: string): RepositoryReleaseConfigParse {
  // An empty/whitespace-only file is not a configuration at all.
  if (raw.trim().length === 0) {
    return { ok: false, code: "empty", detail: "configuration file is empty" };
  }

  let doc;
  try {
    doc = parseDocument(raw, {
      schema: "core",
      version: "1.2",
      strict: true,
      uniqueKeys: true,
      merge: false,
    });
  } catch (error) {
    return {
      ok: false,
      code: "yaml_error",
      detail: error instanceof Error ? error.message : "YAML parse failed",
    };
  }

  if (doc.errors.length > 0) {
    // Duplicate keys, structural faults, etc. surface here as hard errors.
    return { ok: false, code: "yaml_error", detail: doc.errors.map((e) => e.message).join("; ") };
  }
  if (doc.warnings.length > 0) {
    // An unresolved/custom/unsafe tag is a warning, never a silent pass-through.
    return {
      ok: false,
      code: "yaml_unsafe",
      detail: doc.warnings.map((w) => w.message).join("; "),
    };
  }

  // Reject the entire alias machinery: any anchor definition or alias reference.
  let unsafeNode = false;
  visit(doc, {
    Node(_key, node) {
      if (isAlias(node)) unsafeNode = true;
      if (isNode(node) && node.anchor !== undefined) unsafeNode = true;
    },
  });
  if (unsafeNode) {
    return { ok: false, code: "yaml_unsafe", detail: "YAML anchors/aliases are not permitted" };
  }

  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      code: "not_a_mapping",
      detail: "top-level configuration must be a mapping",
    };
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !KNOWN_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return { ok: false, code: "unknown_keys", detail: `unknown key(s): ${unknownKeys.join(", ")}` };
  }

  if (record.version !== 1) {
    return {
      ok: false,
      code: "unknown_version",
      detail: `unsupported version: ${JSON.stringify(record.version)} (only version 1 is supported)`,
    };
  }

  if (!("requiredWorkflows" in record)) {
    return {
      ok: false,
      code: "missing_required_workflows",
      detail: "requiredWorkflows is required",
    };
  }
  const rawWorkflows = record.requiredWorkflows;
  if (!Array.isArray(rawWorkflows)) {
    return {
      ok: false,
      code: "missing_required_workflows",
      detail: "requiredWorkflows must be a list",
    };
  }
  if (rawWorkflows.length === 0) {
    return {
      ok: false,
      code: "empty_required_workflows",
      detail: "requiredWorkflows must not be empty",
    };
  }

  const normalized: string[] = [];
  for (const entry of rawWorkflows) {
    const path = normalizeWorkflowPath(entry);
    if (path === null) {
      return {
        ok: false,
        code: "invalid_workflow_path",
        detail: `not a canonical .github/workflows/*.yml path: ${JSON.stringify(entry)}`,
      };
    }
    if (isReservedSelfPath(path)) {
      return {
        ok: false,
        code: "self_reference",
        detail: `the Scruffy release workflow cannot be its own prerequisite: ${path}`,
      };
    }
    normalized.push(path);
  }

  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    return {
      ok: false,
      code: "duplicate_workflow_path",
      detail: "requiredWorkflows entries must be unique",
    };
  }

  // Canonical form: sorted so the parsed value and its digest are order-independent.
  const requiredWorkflows = [...normalized].sort();
  const config: RepositoryReleaseConfigV1 = { version: 1, requiredWorkflows };
  return { ok: true, config, digest: computeReleaseConfigDigest(config) };
}
