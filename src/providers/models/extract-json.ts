/**
 * Balanced, string-aware extraction of JSON values from model output.
 *
 * Models wrap JSON in prose, markdown fences, and preambles. The naive
 * extraction — first `[` to last `]` — is wrong in both directions:
 *  - a bracket in the surrounding PROSE ("here's the list [see below]: [...]")
 *    makes the slice start too early, so a perfectly good review fails to parse;
 *  - trailing prose containing a closing bracket makes it end too late.
 * Either way the analyzer reports "could not review". Since coverage landed that
 * is at least fail-closed rather than a fake clean bill of health, but it still
 * turns a working review into a blind one — and a model that merely explains
 * itself should not blind the gate.
 *
 * So: scan for every opening bracket, walk it to its balanced close (respecting
 * string literals and escapes, so a `]` inside a JSON string does not terminate
 * the value), and hand back every fragment that parses. Candidates come out in
 * source order, which puts OUTERMOST first — the caller then takes the first one
 * its schema accepts. That ordering also rescues the wrapped-envelope case:
 * `{"result": {"verdict": ...}}` fails the verdict schema at the outer object
 * and matches at the inner one.
 *
 * Bounded on purpose: model output is untrusted input, and an unbounded scan
 * over `[[[[[...` is a cheap way to burn the gate's CPU.
 */

const CLOSERS = { "[": "]", "{": "}" } as const;

/** Enough for prose + fences + an envelope or two; past this it is not a JSON reply. */
const MAX_CANDIDATES = 32;
/**
 * Cap on brackets EXAMINED, not just on ones that parse. Without it the scan is
 * quadratic in the worst case and the cost is trivially attacker-influenced:
 * `"[".repeat(50_000)` yields zero candidates while walking the tail 50k times.
 * A real reply has a handful of brackets before its JSON.
 */
const MAX_STARTS = 256;
/** Model replies are a few KB; 256KB of text is already far past plausible. */
const MAX_SCANNED_CHARS = 256 * 1024;

/**
 * Every balanced, parseable JSON fragment starting with `open`, in source order
 * (outermost first). Empty when the text holds no parseable JSON of that shape.
 */
export function jsonCandidates(text: string, open: "[" | "{"): unknown[] {
  const body = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  const found: unknown[] = [];
  let from = 0;
  for (let attempt = 0; attempt < MAX_STARTS && found.length < MAX_CANDIDATES; attempt += 1) {
    const start = body.indexOf(open, from);
    if (start === -1) break;
    // Advance by one, not past the match: nested values are candidates too, and
    // the caller may need an inner one when the outer fails its schema.
    from = start + 1;
    const end = balancedEnd(body, start);
    if (end === -1) continue;
    try {
      found.push(JSON.parse(body.slice(start, end + 1)));
    } catch {
      // Bracketed but not JSON (prose, a code snippet) — keep scanning.
    }
  }
  return found;
}

/**
 * Index of the bracket that closes the one at `start`, or -1 if it never closes
 * or closes with the wrong kind. Both bracket kinds share one depth counter so
 * mismatched nesting (`[{"a":1]}`) is rejected at the structural level rather
 * than relying on JSON.parse to catch it.
 */
function balancedEnd(text: string, start: number): number {
  const closer = CLOSERS[text[start] as "[" | "{"];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      // Order matters: a backslash consumed as an escape target cannot itself
      // escape the next char, so `"a\\"` closes the string at the final quote.
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return ch === closer ? i : -1;
    }
  }
  return -1;
}
