import { describe, expect, it } from "vitest";
import { addedLines } from "../../src/providers/analyzers/diff.js";

describe("addedLines", () => {
  it("attributes new-file line numbers across context and removed lines", () => {
    const patch = ["@@ -1,3 +1,4 @@", " ctx-a", "-gone", "+added-2", " ctx-b", "+added-4"].join("\n");
    expect(addedLines(patch)).toEqual([
      { text: "added-2", line: 2 },
      { text: "added-4", line: 4 },
    ]);
  });

  it("treats an added line whose content starts with ++ as content, not a header", () => {
    const patch = ["@@ -0,0 +1,2 @@", "+++i;", "+rejectUnauthorized: false"].join("\n");
    expect(addedLines(patch)).toEqual([
      { text: "++i;", line: 1 },
      { text: "rejectUnauthorized: false", line: 2 },
    ]);
  });

  it("does not let the no-newline marker advance the line counter", () => {
    const patch = ["@@ -0,0 +1,2 @@", "+first", "\\ No newline at end of file", "+second"].join("\n");
    expect(addedLines(patch)).toEqual([
      { text: "first", line: 1 },
      { text: "second", line: 2 },
    ]);
  });

  it("ignores file headers that precede the first hunk", () => {
    const patch = ["diff --git a/f b/f", "index 111..222 100644", "--- a/f", "+++ b/f", "@@ -0,0 +1,1 @@", "+real"].join("\n");
    expect(addedLines(patch)).toEqual([{ text: "real", line: 1 }]);
  });

  it("tracks line numbers across multiple hunks", () => {
    const patch = ["@@ -1,1 +1,1 @@", "+a", "@@ -10,1 +10,2 @@", " ctx", "+b"].join("\n");
    expect(addedLines(patch)).toEqual([
      { text: "a", line: 1 },
      { text: "b", line: 11 },
    ]);
  });
});
