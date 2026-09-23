// The diff colouring is pure mapping, so it is tested here rather than by driving a model into
// making an edit — that took ~90s per run and the harness kept losing its output window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "outputs.ts"), "utf8");
// take the function body and strip the TS annotations so plain node can run it. Both markers and
// the signature are asserted: a moved marker or a changed signature used to surface as a bare
// SyntaxError from new Function, with no mention of what had moved.
const slice = (start, end) => {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a + 1);
  assert.ok(a !== -1, `marker not found in outputs.ts: ${start}`);
  assert.ok(b !== -1, `marker not found in outputs.ts after ${start}: ${end}`);
  return src.slice(a, b);
};
const signature = "function paintDiff(line: string, t: Theme): string";
const sliced = slice("function paintDiff", "/** A bordered read-only page");
assert.ok(sliced.includes(signature), `paintDiff's signature changed; update this test's strip (looked for: ${signature})`);
const body = sliced.replace(signature, "function paintDiff(line, t)");
const paintDiff = new Function(`${body}; return paintDiff;`)();
const theme = { fg: (colour, text) => `<${colour}>${text}` };
const cases = [
  ["--- a/cache.py", "dim"], ["+++ b/cache.py", "dim"], ["@@ -7,6 +7,7 @@", "accent"],
  ["+        added", "toolDiffAdded"], ["-        removed", "toolDiffRemoved"],
  ["         context", "toolDiffContext"], ["# /path/cache.py", "dim"],
];
test("unified diff lines map to the theme's diff colours", () => {
  for (const [line, want] of cases) {
    assert.equal(paintDiff(line, theme).match(/^<([a-zA-Z]+)>/)[1], want, line);
  }
});
