// The attached pane's memo key runs on every frame, so it must be cheaper than what it caches:
// sizing a message by stringifying it cost 3.5 ms and 4 MB per frame with a screenshot in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentSize, uniqueLabels } from "../extensions/fleet.ts";

// ctx.ui.select returns the chosen string and the item is found by indexOf: two agents with the
// same description made "attach to the second" attach the first (13 Oct 2026 review).
test("uniqueLabels keeps distinct rows as they are and numbers the repeats", () => {
	assert.deepEqual(uniqueLabels(["dev running", "reviewer running"]), ["dev running", "reviewer running"]);
	const labels = uniqueLabels(["reviewer running", "reviewer running", "critic running", "reviewer running"]);
	assert.deepEqual(labels, ["reviewer running", "reviewer running (2)", "critic running", "reviewer running (3)"]);
	assert.equal(labels.indexOf("reviewer running (2)"), 1, "a choice maps back to its own row");
	assert.equal(new Set(labels).size, labels.length);
});

test("contentSize changes when the content grows, without serialising it", () => {
	assert.equal(contentSize(undefined), "0");
	assert.equal(contentSize("hello"), "s5");
	const blocks = [{ type: "text", text: "abc" }, { type: "thinking", thinking: "xy" }];
	assert.equal(contentSize(blocks), "2:5");
	blocks[0].text += "d";
	assert.equal(contentSize(blocks), "2:6", "streaming text moves the key");
	blocks.push({ type: "toolCall", name: "bash", arguments: { command: "ls" } });
	assert.equal(contentSize(blocks), "3:7", "a new block moves it too");
});

test("contentSize is O(blocks): a 4 MB screenshot is sized by its length", () => {
	const shot = [{ type: "image", data: "A".repeat(4_000_000), mimeType: "image/png" }];
	const t = performance.now();
	for (let i = 0; i < 1000; i++) contentSize(shot);
	const perCall = (performance.now() - t) / 1000;
	assert.equal(contentSize(shot), "1:4000000");
	assert.ok(perCall < 0.05, `${perCall.toFixed(4)} ms per call`);
});
