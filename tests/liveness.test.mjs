// The liveness model is pure: events in with a clock, verdicts out. So every phase, threshold and
// edge is driven here with a fake clock, and scripts/liveness-replay.mjs runs the same code over
// recorded sessions to report false-alarm rates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOORS, LivenessModel, MIN_SAMPLES, PRIORS, Timings, observe, thresholds } from "../extensions/liveness.ts";

const S = 1000;

test("thresholds: twice the p95 and p99, never under the floors, stalled always after slow", () => {
	assert.deepEqual(thresholds({ p95: 4.7, p99: 45 }, "tool"), { slow: 10, stalled: 90 }, "bash: the floor wins for slow, 2×p99 for stalled");
	assert.deepEqual(thresholds({ p95: 0.5, p99: 2 }, "tool"), { slow: 10, stalled: 60 }, "read: both floors");
	assert.deepEqual(thresholds({ p95: 120, p99: 125 }, "tool"), { slow: 240, stalled: 250 }, "run_shell: its own history");
	assert.deepEqual(thresholds({ p95: 12, p99: 31 }, "ttft"), { slow: 24, stalled: 62 }, "globus first token");
	assert.deepEqual(thresholds({ p95: 5, p99: 15 }, "gap"), { slow: 15, stalled: 30 });
	const t = thresholds({ p95: 50, p99: 50 }, "tool");
	assert.ok(t.stalled > t.slow, "a flat distribution still leaves room between slow and stalled");
});

test("timings: priors until twenty samples, then the learned quantiles; the reservoir is bounded", () => {
	const t = new Timings();
	assert.deepEqual(t.quantiles("bash"), { ...PRIORS.bash, source: "prior" });
	assert.equal(t.quantiles("some_new_tool").source, "default");
	assert.equal(t.quantiles("ttft:unknown-provider").p99, 45, "an unknown provider gets the ttft default");
	for (let i = 1; i < MIN_SAMPLES; i++) t.record("bash", 100);
	assert.equal(t.quantiles("bash").source, "prior", "nineteen samples are not enough to overrule the prior");
	t.record("bash", 100);
	assert.equal(t.quantiles("bash").source, "learned");
	assert.equal(t.quantiles("bash").p99, 100);
	for (let i = 0; i < 500; i++) t.record("bash", 1);
	assert.equal(t.samples.get("bash").length, 200, "bounded");
	assert.equal(t.quantiles("bash").p99, 1, "and recent");
	const again = new Timings(JSON.parse(JSON.stringify(t.toJSON())));
	assert.equal(again.quantiles("bash").source, "learned", "round-trips through the cache file");
});

test("a reply: thinking until the first token, streaming after, idle when it ends", () => {
	const m = new LivenessModel(new Timings());
	m.start("globus", 0);
	assert.equal(m.verdict(10 * S).level, "ok");
	assert.equal(m.verdict(25 * S).level, "slow", "past 2× globus's p95 (24 s)");
	assert.equal(m.verdict(70 * S).level, "stalled", "past 2× its p99 (62 s)");
	assert.match(m.verdict(70 * S).summary, /no first token for 1m10s/);
	assert.match(m.verdict(70 * S).evidence[0], /globus usually answers in 12s/);
	m.token(71 * S);
	assert.equal(m.phase, "streaming");
	assert.equal(m.verdict(72 * S).level, "ok", "a token is progress whatever came before");
	assert.equal(m.verdict(72 * S + 16 * S).level, "slow", "no token for 16 s mid-reply");
	assert.equal(m.verdict(72 * S + 31 * S).level, "stalled");
	m.token(100 * S);
	m.messageEnd(101 * S);
	assert.equal(m.verdict(999 * S).level, "ok", "idle is never stuck");
});

test("tools: judged against their own history, the longest-running one when several run", () => {
	const t = new Timings();
	const m = new LivenessModel(t);
	m.toolStart("a", "bash", { command: "ls" }, 0);
	assert.equal(m.verdict(5 * S).level, "ok");
	assert.equal(m.verdict(11 * S).level, "slow", "bash past the 10 s floor");
	assert.equal(m.verdict(91 * S).level, "stalled", "past 2× bash's p99 of 45 s");
	assert.match(m.verdict(91 * S).summary, /bash running 1m31s/);
	m.toolStart("b", "read", { path: "x" }, 92 * S);
	assert.match(m.verdict(93 * S).summary, /bash/, "the oldest running tool is the one that matters");
	m.toolEnd("a", 94 * S);
	assert.equal(m.phase, "tool");
	assert.match(m.verdict(95 * S).summary, /read running/);
	m.toolEnd("b", 96 * S);
	assert.equal(m.phase, "idle");
	assert.deepEqual(t.samples.get("bash"), [94], "the run was recorded, in seconds");
	assert.deepEqual(t.samples.get("read"), [4]);
	// a tool update is progress even when the tool is slow
	m.toolStart("c", "bash", { command: "long" }, 100 * S);
	m.toolUpdate("c", 150 * S);
	assert.equal(m.verdict(151 * S).level, "slow", "the run is judged by its start, not its last update");
	assert.equal(m.verdict(151 * S).waitMs, 1 * S, "but the wait since progress is what the row reports");
});

test("waiting on a human or on a subagent is never stuck, and a dialog overrides everything", () => {
	const m = new LivenessModel(new Timings());
	m.toolStart("q", "ask_user_question", {}, 0);
	assert.equal(m.verdict(3600 * S).level, "waiting");
	assert.match(m.verdict(3600 * S).summary, /waiting for you/);
	m.toolEnd("q", 3600 * S);
	m.toolStart("a", "Agent", { prompt: "x" }, 0);
	assert.equal(m.verdict(7200 * S).level, "waiting");
	assert.match(m.verdict(7200 * S).summary, /waiting on a subagent/);
	m.toolEnd("a", 7200 * S);
	m.toolStart("b", "bash", {}, 0);
	m.promptStart(1 * S);
	assert.equal(m.verdict(600 * S).level, "waiting", "a confirm dialog during a tool: the user is the wait");
	m.promptEnd(601 * S);
	assert.equal(m.verdict(700 * S).level, "stalled");
});

test("three identical tool calls in a row is a loop; a different call ends it", () => {
	const m = new LivenessModel(new Timings());
	for (let i = 0; i < 2; i++) { m.toolStart(`${i}`, "bash", { command: "npm test" }, i * S); m.toolEnd(`${i}`, i * S + 500); }
	assert.equal(m.verdict(3 * S).level, "ok");
	m.toolStart("2", "bash", { command: "npm test" }, 3 * S);
	assert.equal(m.verdict(3 * S).level, "looping");
	assert.match(m.verdict(3 * S).summary, /same call 3× running/);
	m.toolEnd("2", 4 * S);
	m.toolStart("3", "bash", { command: "npm test" }, 5 * S);
	assert.match(m.verdict(5 * S).summary, /4×/);
	m.toolEnd("3", 6 * S);
	m.toolStart("4", "edit", { path: "a" }, 7 * S);
	assert.equal(m.verdict(7 * S).level, "ok", "a different call breaks the run");
});

test("queued subagents wait for a slot; finished ones are done", () => {
	const m = new LivenessModel(new Timings());
	m.queued(0);
	assert.equal(m.verdict(900 * S).level, "waiting");
	assert.match(m.verdict(900 * S).summary, /queued 15m00s/);
	m.start("subagent", 1000 * S);
	assert.equal(m.phase, "thinking");
	m.done(1100 * S);
	assert.equal(m.verdict(9999 * S).level, "ok");
});

test("observe() maps Pi's events onto the model, for the primary and for a subscribed subagent alike", () => {
	const m = new LivenessModel(new Timings());
	assert.equal(observe(m, { type: "message_start", message: { role: "user" } }, 0), true);
	assert.equal(m.phase, "idle", "a user message is not a request");
	observe(m, { type: "message_start", message: { role: "assistant", provider: "argo" } }, 0);
	assert.equal(m.phase, "thinking");
	observe(m, { type: "message_update", assistantMessageEvent: { type: "text_delta" } }, 2 * S);
	assert.equal(m.phase, "streaming");
	observe(m, { type: "message_end", message: {} }, 3 * S);
	observe(m, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "x" } }, 3 * S);
	assert.equal(m.phase, "tool");
	observe(m, { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", args: {}, partialResult: {} }, 4 * S);
	observe(m, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false }, 5 * S);
	assert.equal(m.phase, "idle");
	observe(m, { type: "ui_prompt_start" }, 6 * S);
	assert.equal(m.verdict(600 * S).level, "waiting");
	observe(m, { type: "ui_prompt_end" }, 7 * S);
	assert.equal(observe(m, { type: "something_else" }, 8 * S), false);
	observe(m, { type: "agent_settled" }, 9 * S);
	assert.equal(m.phase, "idle");
});

test("the extension: a stalled primary is told once per episode, the row stays quiet while fine", async () => {
	const handlers = new Map();
	const bus = new Map();
	const emitted = [];
	const notes = [];
	const pi = {
		on: (e, h) => { handlers.set(e, h); return () => {}; },
		events: { on: (e, h) => { bus.set(e, h); return () => {}; }, emit: (e, p) => emitted.push([e, p]) },
		registerCommand: () => {},
	};
	const { default: liveness } = await import("../extensions/liveness.ts");
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "/nonexistent/for-this-test";
	try {
		liveness(pi);
		handlers.get("session_start")({}, { hasUI: true, ui: { notify: (m) => notes.push(m) } });
		const slot = () => emitted.filter(([e, p]) => e === "statusbar:slot" && p.id === "liveness").at(-1)[1];
		assert.equal(slot().state, "idle");
		handlers.get("message_start")({ type: "message_start", message: { role: "assistant", provider: "globus" } });
		handlers.get("session_shutdown")();
	} finally {
		if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedDir;
	}
	assert.equal(notes.length, 0, "nothing said while the wait is within normal");
	assert.ok(FLOORS.ttft.stalled >= 60, "the first-token floor is a minute, so a shared GPU's queue is not an alarm");
});
