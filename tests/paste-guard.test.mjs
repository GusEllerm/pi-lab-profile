// Pi hands extensions input one key at a time, so a paste can only be told from typing by timing.
// The detector takes its clock as an argument; the insertion is driven live by a harness that sends
// an unbracketed multi-line paste into a real Pi session.
import { test } from "node:test";
import assert from "node:assert/strict";
import pasteGuard, { PasteBurst } from "../extensions/paste-guard.ts";

const feedAll = (burst, text, at) => [...text].map((ch) => burst.feed(ch, at));

test("three keys inside the window start a burst; the rest is held and comes back whole", () => {
	const b = new PasteBurst(80);
	const held = feedAll(b, "first raw line\rsecond raw line", 1000);
	assert.deepEqual(held.slice(0, 3), [false, false, true], "the first two keys were typed before the burst was known");
	assert.ok(held.slice(2).every(Boolean));
	assert.equal(b.holding, true);
	assert.equal(b.flush(), "rst raw line\nsecond raw line", "carriage returns become newlines");
	assert.equal(b.holding, false);
	assert.equal(b.flush(), undefined);
});

test("typing at human speed is never held", () => {
	const b = new PasteBurst(80);
	let t = 0;
	for (const ch of "hello world") {
		assert.equal(b.feed(ch, t), false);
		t += 120;
	}
	assert.equal(b.feed("\r", t), false, "Enter after typing submits as usual");
});

test("an escape sequence is never held and ends the burst", () => {
	const b = new PasteBurst(80);
	feedAll(b, "abcd", 5);
	assert.equal(b.holding, true);
	assert.equal(b.feed("\x1b[A", 6), false);
	assert.equal(b.flush(), "cd", "what was held is still returned once");
	assert.equal(b.feed("\x1b[200~x\ny\x1b[201~", 7), false, "a real bracketed paste passes straight through");
});

test("the extension consumes a burst and appends it to the editor after the quiet gap", async () => {
	const handlers = new Map();
	let terminal;
	let editor = "";
	const statuses = [];
	const notices = [];
	const ctx = { hasUI: true, ui: { onTerminalInput: (h) => { terminal = h; return () => { terminal = undefined; }; }, getEditorText: () => editor, setEditorText: (t) => { editor = t; }, setStatus: (k, v) => statuses.push([k, v]), notify: (m) => notices.push(m) } };
	pasteGuard({ on: (e, h) => handlers.set(e, h) });
	handlers.get("session_start")({}, ctx);
	const results = [...`ab\rcd`].map((ch) => terminal(ch));
	assert.deepEqual(results, [undefined, undefined, { consume: true }, { consume: true }, { consume: true }]);
	assert.equal(editor, "", "nothing inserted until the burst ends");
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(editor, "\ncd", "the held part, appended once");
	assert.deepEqual(statuses, [["paste-guard", ""], ["paste-guard", undefined]], "a status write and clear asks Pi for a frame, since a timer alone draws nothing");
	assert.equal(notices.length, 1, "a multi-line burst is explained once");
	assert.match(notices[0], /bracketed-paste markers/);
	[..."xy\rz"].forEach((ch) => terminal(ch));
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(notices.length, 1, "and only once a session");
	handlers.get("session_shutdown")();
	assert.equal(terminal, undefined, "unsubscribed on shutdown");
	handlers.get("session_start")({}, { hasUI: false, ui: ctx.ui });
	assert.equal(terminal, undefined, "no handler without a UI");
});
