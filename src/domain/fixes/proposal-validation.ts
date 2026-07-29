import type { RemediationPolicy } from "../policy/types.js";
import type { ModelFixProposal, ModelProposedEdit, ProposedEdit } from "./types.js";

/**
 * Structural validation for an LLM-sourced fix proposal. This is the boundary
 * where model output stops being trusted prose and becomes (or fails to
 * become) a patch eligible for a PR.
 *
 * Every edit's path/preimage is anchored against REAL content read at the
 * reviewed subject SHA (never against the model's claim alone), and every
 * proposal is bounded by service-owned `RemediationPolicy` limits that the
 * model or repository content can never widen. Anything that does not
 * anchor cleanly, or that would exceed policy, is rejected with a stable
 * reason code — never silently trimmed or best-effort patched.
 */

export const PROPOSAL_REJECTION_REASONS = [
  "empty_proposal",
  "hallucinated_path",
  "preimage_mismatch",
  "ambiguous_preimage",
  "overlapping_edits",
  "binary_content",
  "oversized_edit",
  "too_many_files",
  "too_many_lines",
  "too_many_bytes",
  "protected_path",
  "stale_subject",
] as const;
export type ProposalRejectionReason = (typeof PROPOSAL_REJECTION_REASONS)[number];

/**
 * Immutable full-file content for one path, read at one subject SHA. This is
 * the anchor material — never a diff/patch — so a proposal can be checked
 * against the file's actual full text rather than a fragment.
 */
export interface ValidationSourceFile {
  path: string;
  content: string;
  /** SHA this content was read at. Must equal the proposal's subject SHA. */
  subjectSha: string;
  /** True when the SCM reported this path as binary — never anchorable. */
  binary?: boolean;
  /** True when the SCM reported this path's content as too large to anchor safely. */
  oversized?: boolean;
}

export interface ValidateProposalInput {
  proposal: ModelFixProposal;
  /** The SHA every source file must have been read at. */
  subjectSha: string;
  /** Source files the proposal may reference, keyed by path via `path`. */
  sources: readonly ValidationSourceFile[];
  policy: RemediationPolicy;
}

export type ProposalValidation =
  | { ok: true; edits: ProposedEdit[] }
  | { ok: false; reason: ProposalRejectionReason; detail: string };

/** Validate and anchor every edit; on success, project to plain `ProposedEdit`s. */
export function validateProposal(input: ValidateProposalInput): ProposalValidation {
  const { proposal, subjectSha, sources, policy } = input;
  if (proposal.edits.length === 0) {
    return { ok: false, reason: "empty_proposal", detail: "proposal has no edits" };
  }

  const byPath = new Map(sources.map((s) => [s.path, s]));
  const resolved: ProposedEdit[] = [];

  for (const edit of proposal.edits) {
    if (isProtectedPath(edit.path, policy.protectedPaths)) {
      return { ok: false, reason: "protected_path", detail: `path '${edit.path}' is protected by policy` };
    }
    const source = byPath.get(edit.path);
    if (!source) {
      return { ok: false, reason: "hallucinated_path", detail: `path '${edit.path}' was not read from the subject revision` };
    }
    if (source.subjectSha !== subjectSha) {
      return {
        ok: false,
        reason: "stale_subject",
        detail: `source for '${edit.path}' was read at ${source.subjectSha}, not the reviewed subject ${subjectSha}`,
      };
    }
    if (source.binary) {
      return { ok: false, reason: "binary_content", detail: `path '${edit.path}' is binary content` };
    }
    if (source.oversized) {
      return { ok: false, reason: "oversized_edit", detail: `path '${edit.path}' is too large to anchor safely` };
    }

    const anchor = locateOriginal(source.content, edit);
    if (!anchor.ok) {
      return { ok: false, reason: anchor.reason, detail: `${edit.path}: ${anchor.detail}` };
    }
    resolved.push({
      path: edit.path,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      replacement: edit.replacement,
      rationale: edit.rationale,
    });
  }

  const overlap = findOverlap(resolved);
  if (overlap) {
    return { ok: false, reason: "overlapping_edits", detail: overlap };
  }

  const distinctPaths = new Set(resolved.map((e) => e.path));
  if (distinctPaths.size > policy.maxFiles) {
    return {
      ok: false,
      reason: "too_many_files",
      detail: `proposal touches ${distinctPaths.size} files, policy allows ${policy.maxFiles}`,
    };
  }

  const totalLines = resolved.reduce((sum, e) => sum + countLines(e.replacement), 0);
  if (totalLines > policy.maxTotalLines) {
    return {
      ok: false,
      reason: "too_many_lines",
      detail: `proposal replaces ${totalLines} lines, policy allows ${policy.maxTotalLines}`,
    };
  }

  const totalBytes = resolved.reduce((sum, e) => sum + Buffer.byteLength(e.replacement, "utf8"), 0);
  if (totalBytes > policy.maxTotalBytes) {
    return {
      ok: false,
      reason: "too_many_bytes",
      detail: `proposal replaces ${totalBytes} bytes, policy allows ${policy.maxTotalBytes}`,
    };
  }

  return { ok: true, edits: resolved };
}

/** True when `path` falls under any policy-protected prefix. */
export function isProtectedPath(path: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some((prefix) => path === prefix || path.startsWith(prefix));
}

type AnchorResult =
  | { ok: true; startLine: number; endLine: number }
  | { ok: false; reason: "preimage_mismatch" | "ambiguous_preimage"; detail: string };

/**
 * Locate `edit.expectedOriginal` in `content`. With a line hint, the match
 * must be exact at that range (no searching). Without one, the text must
 * occur exactly once in the file — zero occurrences is a hallucinated
 * preimage, more than one is an ambiguous edit location; neither is guessed.
 */
function locateOriginal(content: string, edit: ModelProposedEdit): AnchorResult {
  if (edit.startLine !== undefined && edit.endLine !== undefined) {
    const lines = content.split("\n");
    const slice = lines.slice(edit.startLine - 1, edit.endLine).join("\n");
    if (slice !== edit.expectedOriginal) {
      return { ok: false, reason: "preimage_mismatch", detail: `expected original text does not match lines ${edit.startLine}-${edit.endLine}` };
    }
    return { ok: true, startLine: edit.startLine, endLine: edit.endLine };
  }

  const occurrences = countOccurrences(content, edit.expectedOriginal);
  if (occurrences === 0) {
    return { ok: false, reason: "preimage_mismatch", detail: "expected original text was not found in the subject file" };
  }
  if (occurrences > 1) {
    return { ok: false, reason: "ambiguous_preimage", detail: `expected original text occurs ${occurrences} times in the subject file` };
  }
  const offset = content.indexOf(edit.expectedOriginal);
  const startLine = content.slice(0, offset).split("\n").length;
  const endLine = startLine + countLines(edit.expectedOriginal) - 1;
  return { ok: true, startLine, endLine };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + 1;
  }
  return count;
}

function countLines(text: string): number {
  return text.length === 0 ? 1 : text.split("\n").length;
}

/** First overlap description among same-path edits, sorted by start line, or null. */
function findOverlap(edits: readonly ProposedEdit[]): string | null {
  const byPath = new Map<string, ProposedEdit[]>();
  for (const edit of edits) {
    const list = byPath.get(edit.path) ?? [];
    list.push(edit);
    byPath.set(edit.path, list);
  }
  for (const [path, list] of byPath) {
    const sorted = [...list].sort((a, b) => a.startLine - b.startLine);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      if (curr.startLine <= prev.endLine) {
        return `${path}: edits at lines ${prev.startLine}-${prev.endLine} and ${curr.startLine}-${curr.endLine} overlap`;
      }
    }
  }
  return null;
}
