import { describe, expect, it } from "vitest";
import { validateProposal, isProtectedPath, type ValidationSourceFile } from "./proposal-validation.js";
import type { RemediationPolicy } from "../policy/types.js";
import type { ModelFixProposal } from "./types.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const POLICY: RemediationPolicy = {
  maxFiles: 3,
  maxTotalLines: 20,
  maxTotalBytes: 2000,
  protectedPaths: [".github/", "src/domain/policy/"],
};

function source(path: string, content: string, overrides: Partial<ValidationSourceFile> = {}): ValidationSourceFile {
  return { path, content, subjectSha: SHA, ...overrides };
}

describe("validateProposal: happy paths", () => {
  it("accepts a single-file edit anchored by unique substring match", () => {
    const proposal: ModelFixProposal = {
      edits: [
        {
          path: "src/http.ts",
          expectedOriginal: "rejectUnauthorized: false",
          replacement: "rejectUnauthorized: true",
          rationale: "restore TLS verification",
        },
      ],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("src/http.ts", "const opts = { rejectUnauthorized: false };\n")],
      policy: POLICY,
    });
    expect(result).toEqual({
      ok: true,
      edits: [
        {
          path: "src/http.ts",
          startLine: 1,
          endLine: 1,
          replacement: "rejectUnauthorized: true",
          rationale: "restore TLS verification",
        },
      ],
    });
  });

  it("accepts a multi-file structured proposal", () => {
    const proposal: ModelFixProposal = {
      edits: [
        { path: "src/a.ts", expectedOriginal: "const a = 1;", replacement: "const a = 2;", rationale: "fix a" },
        { path: "src/b.ts", expectedOriginal: "const b = 1;", replacement: "const b = 2;", rationale: "fix b" },
      ],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("src/a.ts", "const a = 1;\n"), source("src/b.ts", "const b = 1;\n")],
      policy: POLICY,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edits).toHaveLength(2);
      expect(result.edits.map((e) => e.path)).toEqual(["src/a.ts", "src/b.ts"]);
    }
  });

  it("honors an explicit line hint and requires an exact match at that range", () => {
    const proposal: ModelFixProposal = {
      edits: [
        {
          path: "src/http.ts",
          expectedOriginal: "line two",
          startLine: 2,
          endLine: 2,
          replacement: "line TWO",
          rationale: "uppercase",
        },
      ],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("src/http.ts", "line one\nline two\nline three")],
      policy: POLICY,
    });
    expect(result).toMatchObject({ ok: true, edits: [{ startLine: 2, endLine: 2 }] });
  });
});

describe("validateProposal: rejection reasons", () => {
  it("rejects an empty proposal", () => {
    const result = validateProposal({
      proposal: { edits: [] as unknown as ModelFixProposal["edits"] },
      subjectSha: SHA,
      sources: [],
      policy: POLICY,
    });
    expect(result).toMatchObject({ ok: false, reason: "empty_proposal" });
  });

  it("rejects a hallucinated path never read from the subject revision", () => {
    const proposal: ModelFixProposal = {
      edits: [{ path: "src/does-not-exist.ts", expectedOriginal: "x", replacement: "y", rationale: "r" }],
    };
    const result = validateProposal({ proposal, subjectSha: SHA, sources: [source("src/real.ts", "x")], policy: POLICY });
    expect(result).toMatchObject({ ok: false, reason: "hallucinated_path" });
  });

  it("rejects a missing preimage", () => {
    const proposal: ModelFixProposal = {
      edits: [{ path: "src/a.ts", expectedOriginal: "not present anywhere", replacement: "y", rationale: "r" }],
    };
    const result = validateProposal({ proposal, subjectSha: SHA, sources: [source("src/a.ts", "const a = 1;")], policy: POLICY });
    expect(result).toMatchObject({ ok: false, reason: "preimage_mismatch" });
  });

  it("rejects an exact-range hint whose text does not match", () => {
    const proposal: ModelFixProposal = {
      edits: [
        { path: "src/a.ts", expectedOriginal: "wrong text", startLine: 1, endLine: 1, replacement: "y", rationale: "r" },
      ],
    };
    const result = validateProposal({ proposal, subjectSha: SHA, sources: [source("src/a.ts", "const a = 1;")], policy: POLICY });
    expect(result).toMatchObject({ ok: false, reason: "preimage_mismatch" });
  });

  it("rejects an ambiguous preimage that occurs more than once", () => {
    const proposal: ModelFixProposal = {
      edits: [{ path: "src/a.ts", expectedOriginal: "dup", replacement: "y", rationale: "r" }],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("src/a.ts", "dup\nsomething\ndup")],
      policy: POLICY,
    });
    expect(result).toMatchObject({ ok: false, reason: "ambiguous_preimage" });
  });

  it("rejects overlapping edits on the same file", () => {
    const proposal: ModelFixProposal = {
      edits: [
        { path: "src/a.ts", expectedOriginal: "line1\nline2", startLine: 1, endLine: 2, replacement: "x", rationale: "r1" },
        { path: "src/a.ts", expectedOriginal: "line2\nline3", startLine: 2, endLine: 3, replacement: "y", rationale: "r2" },
      ],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("src/a.ts", "line1\nline2\nline3")],
      policy: POLICY,
    });
    expect(result).toMatchObject({ ok: false, reason: "overlapping_edits" });
  });

  it("rejects a protected path regardless of anchoring", () => {
    const proposal: ModelFixProposal = {
      edits: [{ path: ".github/workflows/ci.yml", expectedOriginal: "x", replacement: "y", rationale: "r" }],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source(".github/workflows/ci.yml", "x")],
      policy: POLICY,
    });
    expect(result).toMatchObject({ ok: false, reason: "protected_path" });
  });

  it("rejects binary content", () => {
    const proposal: ModelFixProposal = {
      edits: [{ path: "assets/logo.png", expectedOriginal: "x", replacement: "y", rationale: "r" }],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("assets/logo.png", "x", { binary: true })],
      policy: POLICY,
    });
    expect(result).toMatchObject({ ok: false, reason: "binary_content" });
  });

  it("rejects oversized source content", () => {
    const proposal: ModelFixProposal = {
      edits: [{ path: "src/huge.ts", expectedOriginal: "x", replacement: "y", rationale: "r" }],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("src/huge.ts", "x", { oversized: true })],
      policy: POLICY,
    });
    expect(result).toMatchObject({ ok: false, reason: "oversized_edit" });
  });

  it("rejects a stale subject read at a different sha", () => {
    const proposal: ModelFixProposal = {
      edits: [{ path: "src/a.ts", expectedOriginal: "x", replacement: "y", rationale: "r" }],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("src/a.ts", "x", { subjectSha: OTHER_SHA })],
      policy: POLICY,
    });
    expect(result).toMatchObject({ ok: false, reason: "stale_subject" });
  });

  it("rejects a proposal that touches more files than policy allows", () => {
    const narrowPolicy: RemediationPolicy = { ...POLICY, maxFiles: 1 };
    const proposal: ModelFixProposal = {
      edits: [
        { path: "src/a.ts", expectedOriginal: "a", replacement: "A", rationale: "r" },
        { path: "src/b.ts", expectedOriginal: "b", replacement: "B", rationale: "r" },
      ],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("src/a.ts", "a"), source("src/b.ts", "b")],
      policy: narrowPolicy,
    });
    expect(result).toMatchObject({ ok: false, reason: "too_many_files" });
  });

  it("rejects a proposal whose total replacement lines exceed policy", () => {
    const narrowPolicy: RemediationPolicy = { ...POLICY, maxTotalLines: 1 };
    const proposal: ModelFixProposal = {
      edits: [{ path: "src/a.ts", expectedOriginal: "a", replacement: "line1\nline2\nline3", rationale: "r" }],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("src/a.ts", "a")],
      policy: narrowPolicy,
    });
    expect(result).toMatchObject({ ok: false, reason: "too_many_lines" });
  });

  it("rejects a proposal whose total replacement bytes exceed policy", () => {
    const narrowPolicy: RemediationPolicy = { ...POLICY, maxTotalBytes: 4 };
    const proposal: ModelFixProposal = {
      edits: [{ path: "src/a.ts", expectedOriginal: "a", replacement: "way too many bytes", rationale: "r" }],
    };
    const result = validateProposal({
      proposal,
      subjectSha: SHA,
      sources: [source("src/a.ts", "a")],
      policy: narrowPolicy,
    });
    expect(result).toMatchObject({ ok: false, reason: "too_many_bytes" });
  });
});

describe("isProtectedPath", () => {
  it("matches an exact protected path and a prefixed one", () => {
    expect(isProtectedPath(".github/workflows/ci.yml", [".github/"])).toBe(true);
    expect(isProtectedPath("package.json", ["package.json"])).toBe(true);
    expect(isProtectedPath("src/http.ts", [".github/"])).toBe(false);
  });
});
