// The hover guard has to reinstall itself, because pi-cc overwrites the handler slot. Reinstalling
// is also how it once killed a session: it re-read the handler each time through the TUI proxy --
// which mints a fresh function per read, so nothing ever compared equal -- and wrapped what it found,
// which was its own previous wrapper, until "Maximum call stack size exceeded". A second version
// captured once but still compared through the proxy, so its "pi-cc has not patched" branch could
// never run and it would have overwritten a later pi-cc patch every frame.
//
// The invariants that hold now are structural: everything is read from the *real* TUI captured from
// `this` in the frame wrapper, the "is it ours?" check comes before any capture, and exactly one
// wrapper is ever built. These tests read the source because the failures are a crash after
// thousands of frames or a silently dead click handler -- neither shows up in a unit test. They
// match the identifiers `sink.realTui`, `sink.piccHandler`, `sink.hoverWrapper` and `installed`;
// renaming those means updating this file, not a design violation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "statusbar.ts"), "utf8");
const slice = (start, end) => {
	const a = src.indexOf(start);
	const b = src.indexOf(end, a + 1);
	assert.ok(a !== -1, `marker not found: ${start}`);
	assert.ok(b !== -1, `marker not found: ${end}`);
	return src.slice(a, b);
};
const guard = slice("function guardHover(): void {", "function mountSidebar(tui: TUI): void {");

test("the real TUI is captured from `this` in the frame wrapper, not read through the proxy", () => {
	const frames = slice("t.doRender = function (this: unknown) {", "frame = { bytes: 0");
	assert.match(frames, /sink\.realTui \?\?= this;/, "the frame wrapper must capture the real object");
	assert.doesNotMatch(guard, /\bt\.handleViewportInput\b/, "the guard must never read the handler through the proxy");
	assert.match(guard, /Object\.getOwnPropertyDescriptor\(real, "handleViewportInput"\)/, "it reads the real object's own property");
});

test("the 'is it ours?' check precedes every capture, so a wrapper can never wrap itself", () => {
	const ours = guard.indexOf("installed === sink.hoverWrapper");
	const capture = guard.indexOf("sink.piccHandler = installed;");
	assert.ok(ours !== -1 && capture !== -1, "expected both the ownership check and the capture");
	assert.ok(ours < capture, "capturing before checking ownership is how a chain is built");
});

test("an unpatched instance is left alone: the refusal branch is reachable and does not wrap the prototype", () => {
	const refusal = guard.indexOf("pi-cc has not patched handleViewportInput");
	const install = guard.indexOf("real.handleViewportInput = sink.hoverWrapper;");
	assert.ok(refusal !== -1, "the refusal branch must exist");
	assert.ok(refusal < install, "the refusal must return before anything is installed");
	assert.match(guard, /typeof installed !== "function"[\s\S]*?return;/, "no own property means nothing to guard");
});

test("exactly one wrapper is ever built, and installs re-assign that same object", () => {
	assert.equal((guard.match(/sink\.hoverWrapper = function/g) ?? []).length, 1, "one construction site");
	assert.match(guard, /if \(!sink\.hoverWrapper\) \{/, "construction is gated on the sink not already holding one");
	assert.equal((guard.match(/real\.handleViewportInput = /g) ?? []).length, 1, "one assignment site");
	assert.match(guard, /real\.handleViewportInput = sink\.hoverWrapper;/, "and it assigns the existing wrapper");
	assert.match(guard, /prof\.hoverWrappers\+\+/, "/prof reports the count; more than 1 means this broke");
});

// The suppression predicate itself is pure, so it can just be run. It lives outside guardHover.
const motionSrc = src
	.slice(src.indexOf("const onlyMotion ="), src.indexOf("};", src.indexOf("const onlyMotion =")) + 2)
	.replace("(data: string): boolean =>", "(data) =>");
const onlyMotion = new Function(`${motionSrc} return onlyMotion;`)();

test("only button-less motion is suppressed; everything else passes through", () => {
	assert.equal(onlyMotion("\x1b[<35;40;10M"), true, "motion with no buttons held");
	assert.equal(onlyMotion("\x1b[<35;40;10M\x1b[<35;41;11M"), true, "a batch of motion");
	assert.equal(onlyMotion("\x1b[<0;40;10M"), false, "left press must reach pi-cc");
	assert.equal(onlyMotion("\x1b[<0;40;10m"), false, "left release must reach pi-cc");
	assert.equal(onlyMotion("\x1b[<64;40;10M"), false, "wheel up must reach pi-cc");
	assert.equal(onlyMotion("\x1b[<35;40;10M\x1b[<0;40;10M"), false, "a mixed batch is not motion-only");
	assert.equal(onlyMotion("hello"), false, "plain keys");
	assert.equal(onlyMotion(""), false, "nothing at all");
});
