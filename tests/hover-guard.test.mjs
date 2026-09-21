// The hover guard has to reinstall itself, because pi-cc overwrites the handler slot. Reinstalling
// is also how it killed a session: an earlier version re-read tui.handleViewportInput each time and
// wrapped whatever it found, which -- since the TUI is a lazy proxy that never hands back the
// function object you assigned -- meant every frame wrapped the previous wrapper, until
// "Maximum call stack size exceeded".
//
// The invariant that prevents it is structural, not behavioural: pi-cc's handler is captured once,
// the wrapper is built once, and reinstalling re-assigns that same object. These tests read the
// source, because the failure mode is a crash after thousands of frames rather than anything a unit
// test would see, and because this invariant has been broken twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "statusbar.ts"), "utf8");
const guard = src.slice(src.indexOf("function guardHover"), src.indexOf("function mountSidebar"));

test("pi-cc's handler is captured once, behind the wrapper check", () => {
	const captures = [...guard.matchAll(/const piccHandler = t\.handleViewportInput/g)];
	assert.equal(captures.length, 1, "capturing the live handler more than once risks wrapping our own wrapper");
	const gate = guard.indexOf("if (!hoverWrapper) {");
	assert.ok(gate !== -1, "the capture must sit behind a `if (!hoverWrapper)` gate");
	assert.ok(captures[0].index > gate, "the capture must happen only when no wrapper exists yet");
});

test("exactly one wrapper function is ever constructed", () => {
	const built = [...guard.matchAll(/hoverWrapper = function/g)];
	assert.equal(built.length, 1, "a second construction site is a second chance to build a chain");
});

test("reinstalling assigns the existing wrapper, never a new one", () => {
	assert.match(
		guard,
		/t\.handleViewportInput = hoverWrapper;/,
		"the reinstall must re-assign the captured wrapper object",
	);
	const assignments = [...guard.matchAll(/t\.handleViewportInput = /g)];
	assert.equal(assignments.length, 1, "only one assignment site, and it assigns hoverWrapper");
});

test("the guard counts its wrappers so a regression is visible in /prof", () => {
	assert.match(guard, /prof\.hoverWrappers\+\+/, "/prof reports this; more than 1 means the invariant broke");
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
