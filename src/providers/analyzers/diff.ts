/**
 * Shared unified-diff helpers for line-pattern analyzers. Analyzers care about
 * what a change INTRODUCES, so they scan added lines with their new-file line
 * numbers. Kept in one place so every analyzer parses diffs identically.
 */

export interface AddedLine {
  text: string;
  line: number;
}

/**
 * Extract added lines with their new-file line numbers from a unified diff.
 * Hunk headers look like `@@ -a,b +c,d @@`; `c` is the starting new-file line.
 *
 * Only content inside a hunk is interpreted, so file headers (`--- a/f`,
 * `+++ b/f`, `diff --git`, `index …`) that precede the first `@@` are ignored
 * rather than mistaken for removed/added lines. The classification keys on the
 * FIRST character only — an added line whose content itself starts with `+`
 * (e.g. `+++i;`) is a normal added line, not a header — and the
 * `\ No newline at end of file` marker never advances the line counter. Getting
 * this wrong shifts every subsequent line number, which downstream feeds
 * whole-line fix edits and model-finding anchors.
 */
export function addedLines(patch: string): AddedLine[] {
  const out: AddedLine[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // pre-hunk file headers — not diff content
    if (raw === "" || raw.startsWith("\\")) continue; // blank tail / "\ No newline at end of file"

    const marker = raw[0];
    if (marker === "+") {
      out.push({ text: raw.slice(1), line: newLine });
      newLine += 1;
    } else if (marker !== "-") {
      // context line (leading space) advances the new-file counter; a removed
      // line ("-") does not exist in the new file.
      newLine += 1;
    }
  }
  return out;
}

/** True when a path looks like test/spec code, where some risky patterns are acceptable. */
export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|specs?|__tests__|__mocks__|e2e)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i.test(path);
}
