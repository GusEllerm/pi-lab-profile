// The context trajectory is arithmetic over a ring of samples, so it is tested directly rather than
// by growing a real session to 90% of its window. Same source-slicing trick as paint-diff.test.mjs:
// take the class out of the extension and strip the TS annotations so plain node can run it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "statusbar.ts"), "utf8");
// Markers and every TS strip are asserted: a moved marker or a changed signature used to surface
// as a bare SyntaxError from new Function, with no mention of what had moved.
const slice = (start, end) => {
	const a = src.indexOf(start);
	const b = src.indexOf(end, a + 1);
	assert.ok(a !== -1, `marker not found in statusbar.ts: ${start}`);
	assert.ok(b !== -1, `marker not found in statusbar.ts after ${start}: ${end}`);
	return src.slice(a, b);
};
const strip = (text, from, to) => {
	assert.ok(text.includes(from), `ContextTrail changed; update this test's strip (looked for: ${from})`);
	return text.replace(from, to);
};
let body = slice("const SPARK =", "/** Read-only overlay:");
body = strip(body, "private samples: { at: number; used: number }[] = [];", "samples = [];");
body = strip(body, "sample(used: number): void", "sample(used)");
body = strip(body, "rate(): number | undefined", "rate()");
body = strip(body, "spark(width: number): string", "spark(width)");
const ContextTrail = new Function(`${body}; return ContextTrail;`)();

/** Samples are rate-limited to ~1s, so drive the clock rather than the sampler. */
const seed = (points) => {
	const trail = new ContextTrail();
	for (const [at, used] of points) trail.samples.push({ at, used });
	return trail;
};

test("no rate until there is enough of a window to divide by", () => {
	assert.equal(new ContextTrail().rate(), undefined, "no samples");
	assert.equal(seed([[0, 1000]]).rate(), undefined, "one sample");
	assert.equal(seed([[0, 1000], [4000, 2000]]).rate(), undefined, "under 5s apart");
});

test("rate is tokens per minute across the window", () => {
	// 10k tokens over 60s is 10k/min
	assert.equal(seed([[0, 5000], [60_000, 15_000]]).rate(), 10_000);
	// and over 30s, the same 10k is 20k/min
	assert.equal(seed([[0, 5000], [30_000, 15_000]]).rate(), 20_000);
});

test("a context that is not growing reports no rate", () => {
	// flat, and shrinking after a compaction: neither should produce a countdown
	assert.equal(seed([[0, 9000], [60_000, 9000]]).rate(), undefined);
	assert.equal(seed([[0, 90_000], [60_000, 20_000]]).rate(), undefined);
});

test("the spark needs a few points and some width", () => {
	assert.equal(seed([[0, 1], [1000, 2]]).spark(12), "", "too few samples");
	assert.equal(seed([[0, 1], [1000, 2], [2000, 3]]).spark(3), "", "too narrow");
});

test("the spark is normalised to its own window, not to the context size", () => {
	// A run that is nearly full but flat should look flat, not pegged: at 90% of a window every bar
	// would otherwise be full, which is exactly when the shape matters.
	const rising = seed([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i * 1000, 240_000 + i * 1000]));
	const spark = rising.spark(8);
	assert.equal(spark.length, 8);
	assert.equal(spark[0], "▁", "the low point of the window is the low bar");
	assert.equal(spark.at(-1), "█", "the high point is the full bar");
	const flat = seed([0, 1, 2, 3].map((i) => [i * 1000, 240_000]));
	assert.equal(flat.spark(4), "▁▁▁▁", "no change is a flat line, however full the context");
});

test("the spark shows only the most recent points that fit", () => {
	const trail = seed(Array.from({ length: 40 }, (_, i) => [i * 1000, i * 100]));
	assert.equal(trail.spark(10).length, 10);
});

test("the window is a minute of time, not sixty samples", () => {
	// Samples are taken only on frames the column draws, so after an idle stretch a count-limited
	// ring averaged a fresh burst against samples from hours ago. Drive the clock to prove the
	// old ones are gone before the new one is used.
	const trail = new ContextTrail();
	const realNow = Date.now;
	try {
		let t = 1_000_000;
		Date.now = () => t;
		trail.sample(50_000);            // t = 0s
		t += 30_000; trail.sample(60_000); // t = 30s: still inside the minute
		assert.equal(trail.samples.length, 2);
		t += 3_600_000; trail.sample(61_000); // an hour later: both earlier samples are out of the window
		assert.equal(trail.samples.length, 1, "samples older than a minute are evicted on the next sample");
		assert.equal(trail.rate(), undefined, "a single fresh sample yields no rate, rather than one averaged over an hour");
	} finally {
		Date.now = realNow;
	}
});
