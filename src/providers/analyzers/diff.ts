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
 */
export function addedLines(patch: string): AddedLine[] {
  const out: AddedLine[] = [];
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+++")) continue;
    if (raw.startsWith("+")) {
      out.push({ text: raw.slice(1), line: newLine });
      newLine += 1;
    } else if (!raw.startsWith("-")) {
      // context line advances the new-file counter
      newLine += 1;
    }
  }
  return out;
}

/** True when a path looks like test/spec code, where some risky patterns are acceptable. */
export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|specs?|__tests__|__mocks__|e2e)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i.test(path);
}
