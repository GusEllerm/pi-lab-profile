// The column's numbers, tested as arithmetic: a session's spend summed from its branch, the
// speed meter's reading of a stream, and the text each becomes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeedMeter, speedText, sumUsage } from "../extensions/lib/metrics.ts";

const assistant = (usage) => ({ type: "message", message: { role: "assistant", usage } });

test("sumUsage: prompt is input plus every cache figure; estimated is sticky; non-assistant entries are skipped", () => {
	const ctx = { sessionManager: { getBranch: () => [
		{ type: "message", message: { role: "user", content: "q" } },
		assistant({ input: 100, cacheRead: 50, cacheWrite: 10, output: 20, cost: { total: 0.01 } }),
		{ type: "compaction" },
		assistant({ input: 200, output: 5, cost: { total: 0.02 }, estimated: true }),
		{ type: "message", message: { role: "assistant" } }, // no usage: not a call
	] } };
	assert.deepEqual(sumUsage(ctx), { prompt: 360, cacheRead: 50, output: 25, calls: 2, cost: 0.03, estimated: true });
	assert.deepEqual(sumUsage({ sessionManager: { getBranch: () => [] } }), { prompt: 0, cacheRead: 0, output: 0, calls: 0, cost: 0, estimated: false });
});

test("speedText: live while streaming, 'last' when idle, nothing before the first reply; ~ marks an estimate or a buffered delivery", () => {
	assert.equal(speedText({ streaming: false, estimated: false, buffered: false }), undefined);
	assert.deepEqual(speedText({ streaming: true, live: 41.6, estimated: false, buffered: false }), { text: "42 tok/s", live: true });
	assert.deepEqual(speedText({ streaming: true, estimated: false, buffered: false }), { text: "…", live: true }, "streaming, no window yet");
	assert.deepEqual(speedText({ streaming: true, live: 10, estimated: true, buffered: false }), { text: "~10 tok/s", live: true });
	assert.deepEqual(speedText({ streaming: false, last: 450, estimated: false, buffered: true }), { text: "last ~450 tok/s", live: false }, "a gateway that buffers reports delivery, not generation");
});

test("SpeedMeter: a trickled stream is a real rate; a reply that lands at once is marked buffered", () => {
	const realNow = Date.now;
	try {
		let t = 1_000_000;
		Date.now = () => t;
		const m = new SpeedMeter();
		m.start();
		for (let i = 1; i <= 20; i++) { t += 500; m.update({ usage: { output: i * 10 } }); } // 200 tokens over 10 s, 20 updates
		assert.equal(m.read().streaming, true);
		assert.ok(Math.abs(m.read().live - 20) < 1, `live ≈ 20 tok/s, got ${m.read().live}`);
		m.end({ usage: { output: 200 } });
		const r = m.read();
		assert.equal(r.streaming, false);
		assert.equal(r.buffered, false);
		assert.ok(Math.abs(r.last - 200 / 9.5) < 0.01, `last is measured from the first token (9.5 s), not the start: ${r.last}`);
		assert.equal(r.ttftMs, 500, "first token half a second after the start");

		const b = new SpeedMeter();
		b.start();
		t += 300; b.update({ usage: { output: 0 }, content: [{ text: "x".repeat(4000) }] }); // one burst, counted as chars/4
		t += 100; b.update({ usage: { output: 0 }, content: [{ text: "x".repeat(4000) }] });
		t += 300; // past the meter's 200 ms floor for a measurable reply; the samples still span only 100 ms
		b.end({ usage: { output: 1000 } });
		assert.equal(b.read().buffered, true, "1000 tokens inside 100 ms of samples is delivery, not generation");
		assert.equal(b.read().estimated, true, "counts came from chars/4");
	} finally {
		Date.now = realNow;
	}
});
