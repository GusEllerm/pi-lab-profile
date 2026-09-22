// The critic's verdicts are machine-read: they build the verdict line, decide whether another dev
// round runs, and select what the next dev round is handed. These are the exact behaviours the
// review found wrong (M3: prose counted as verdicts; M4: rejected findings handed back to dev).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tally, surviving } from "../extensions/rounds.ts";

const critique = `I checked all three findings against the code.

CONFIRMED — the retry runs on a dead activation. Lines 274-280 make it so.
PLAUSIBLE — the race in round(); I could not force it, a stress test would settle it.
REJECTED — the "leak" in publishSlot: emit() is dead-checked, see line 84.

Nothing else was confirmed; one finding was rejected as style dressed up as a defect.

## Bottom line
Fix the retry first. The change is otherwise sound.`;

test("a TALLY line is the authority when present", () => {
	assert.deepEqual(tally(`${critique}\nTALLY: confirmed=4 plausible=0 rejected=9`), { CONFIRMED: 4, PLAUSIBLE: 0, REJECTED: 9 });
	assert.deepEqual(tally("TALLY: confirmed = 1, plausible = 2, rejected = 3"), { CONFIRMED: 1, PLAUSIBLE: 2, REJECTED: 3 }, "spacing and separators are forgiven");
});

test("without a TALLY line, only lines that start with a verdict count", () => {
	assert.deepEqual(tally(critique), { CONFIRMED: 1, PLAUSIBLE: 1, REJECTED: 1 });
});

test("prose mentions never count, in any case", () => {
	assert.deepEqual(tally("Nothing was confirmed. Two were rejected. I remain unconvinced it is PLAUSIBLE that this holds."), { CONFIRMED: 0, PLAUSIBLE: 0, REJECTED: 0 });
	assert.deepEqual(tally("confirmed — lower case at line start is prose, not a verdict"), { CONFIRMED: 0, PLAUSIBLE: 0, REJECTED: 0 });
});

test("list markers and bold before the word are fine", () => {
	assert.deepEqual(tally("- CONFIRMED: a\n* **REJECTED** b\n1. PLAUSIBLE c\n2) CONFIRMED d"), { CONFIRMED: 2, PLAUSIBLE: 1, REJECTED: 1 });
});

test("the next dev round receives the confirmed and plausible findings, not the rejected ones", () => {
	const out = surviving(critique);
	assert.match(out, /CONFIRMED — the retry runs on a dead activation/);
	assert.match(out, /PLAUSIBLE — the race in round\(\)/);
	assert.doesNotMatch(out, /REJECTED — the "leak"/, "a rejected finding must not be handed back as work");
	assert.doesNotMatch(out, /emit\(\) is dead-checked/, "nor its justification");
	assert.match(out, /I checked all three findings/, "the preamble is kept");
	assert.match(out, /Fix the retry first/, "the bottom line after a heading is kept");
});

test("a rejected block ends at the TALLY line, so the tally is not swallowed", () => {
	const out = surviving("REJECTED — not a defect.\nTALLY: confirmed=0 plausible=0 rejected=1");
	assert.match(out, /TALLY:/);
	assert.doesNotMatch(out, /not a defect/);
});

test("an unstructured critique is passed whole", () => {
	const prose = "The review found nothing real; the change is sound and the two concerns are style.";
	assert.equal(surviving(prose), prose);
});
