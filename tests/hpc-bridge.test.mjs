// The hpc-bridge layer never talks to the server; it gates and observes through Pi's events. So it
// is driven here through a fake pi and a fake ctx, with results shaped like hpc-bridge's own pydantic
// models (src/hpc_bridge/models.py in that repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import layer, { applyResult, describe, hpcPrefix, looksLikeCredential, parseResult } from "../extensions/hpc-bridge.ts";

function fakePi() {
	const handlers = new Map();
	const bus = new Map();
	const emitted = [];
	const commands = new Map();
	return {
		handlers, emitted, commands,
		on: (event, h) => { handlers.set(event, h); return () => {}; },
		events: { on: (e, h) => { bus.set(e, h); return () => {}; }, emit: (e, p) => emitted.push([e, p]) },
		registerCommand: (name, opts) => commands.set(name, opts),
	};
}

/** A cwd whose .pi/mcp.json names hpc-bridge under the given server name, and a HOME with no global file. */
function withConfig(serverName = "hpc", extra = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "hpcb-"));
	const home = mkdtempSync(join(tmpdir(), "hpcb-home-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ servers: { [serverName]: { command: "uvx", args: ["--from", "git+https://x/hpc-bridge", "hpc-bridge"], ...extra } } }));
	const saved = { cwd: process.cwd(), home: process.env.HOME };
	process.chdir(cwd); process.env.HOME = home;
	return () => { process.chdir(saved.cwd); process.env.HOME = saved.home; rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); };
}

test("the credential pattern is hpc-bridge's own", () => {
	for (const bad of ["export PASSWORD=hunter2", "curl -H 'api_key: abc'", "TOKEN = xyz", "secret:1", "api-key=1"]) assert.equal(looksLikeCredential(bad), true, bad);
	for (const ok of ["export TOKEN_FILE=/run/secrets/t", "echo the password policy", "ls -la", "hpc-bridge --token-from-file x"]) assert.equal(looksLikeCredential(ok), false, ok);
});

test("parseResult takes the first JSON object out of a tool's text", () => {
	assert.deepEqual(parseResult('prefix {"status": "up", "block_state": "warm"} trailing'), { status: "up", block_state: "warm" });
	assert.deepEqual(parseResult('{"a": {"b": 1}}{"second": true}'), { a: { b: 1 } });
	assert.equal(parseResult("no json here"), undefined);
	assert.equal(parseResult("{ broken"), undefined);
});

test("results fold into state the way the models are shaped", () => {
	let s = applyResult({}, "connect_facility", { phase: "needs_account", facility: "globus-labs", allocations: [] }, 1000);
	assert.equal(s.facility, "globus-labs"); assert.equal(s.status, "needs_account");
	s = applyResult(s, "ensure_endpoint_up", { status: "up", block_state: "warm", session_spend: 0.25, partition: "gpu", account: "lab" }, 2000);
	assert.equal(s.block, "warm"); assert.equal(s.spend, 0.25); assert.equal(s.warmSince, 2000, "warm since the first warm result");
	s = applyResult(s, "run_shell", { phase: "complete", block_state: "warm", session_spend: 0.5 }, 3000);
	assert.equal(s.spend, 0.5); assert.equal(s.warmSince, 2000, "still the first warm time");
	s = applyResult(s, "stop_endpoint", { status: "down", block_state: "cold", session_spend: 0.5 }, 4000);
	assert.equal(s.block, "cold"); assert.equal(s.warmSince, undefined);
	assert.equal(applyResult(s, "list_facilities", { anything: 1 }).facility, "globus-labs", "unrelated tools leave the state alone");
});

test("describe: idle until connected, busy while a block is warm, warn on needs_*", () => {
	assert.equal(describe({}).state, "idle");
	const warm = describe({ facility: "globus-labs", status: "up", block: "warm", spend: 0.3, partition: "gpu", account: "lab", warmSince: 0 }, 5 * 60_000);
	assert.equal(warm.state, "busy");
	assert.match(warm.text, /globus-labs · block warm/);
	assert.ok(warm.details.some((d) => /block warm · 5 min/.test(d)), warm.details.join(" | "));
	assert.ok(warm.details.some((d) => /spent 0.30 node-h/.test(d)));
	assert.ok(warm.details.some((d) => /release: hpc_stop_endpoint/.test(d)));
	assert.equal(describe({ facility: "x", status: "needs_login" }).state, "warn");
	assert.equal(describe({ facility: "x", status: "failed" }).state, "error");
	assert.equal(describe({ facility: "x", status: "down", block: "cold" }).state, "ok");
});

test("the tool prefix follows mcp.json, including a custom prefix and no prefix", () => {
	let restore = withConfig("hpc"); try { assert.equal(hpcPrefix(process.cwd()), "hpc_"); } finally { restore(); }
	restore = withConfig("cluster", { prefix: "sc" }); try { assert.equal(hpcPrefix(process.cwd()), "sc_"); } finally { restore(); }
	restore = withConfig("hpc", { prefix: false }); try { assert.equal(hpcPrefix(process.cwd()), ""); } finally { restore(); }
	restore = withConfig("other"); try {
		writeFileSync(join(process.cwd(), ".pi", "mcp.json"), JSON.stringify({ servers: { other: { command: "node", args: ["x.mjs"] } } }));
		assert.equal(hpcPrefix(process.cwd()), undefined, "no hpc-bridge server, no prefix");
	} finally { restore(); }
});

test("the spend gate: declined blocks, accepted allows, confirm_spend=false never asks, headless blocks", async () => {
	const restore = withConfig("hpc");
	try {
		const pi = fakePi();
		layer(pi);
		const call = pi.handlers.get("tool_call");
		const asked = [];
		const ctx = (answer) => ({ hasUI: true, ui: { confirm: async (title, msg) => { asked.push([title, msg]); return answer; } } });

		const declined = await call({ type: "tool_call", toolCallId: "1", toolName: "hpc_ensure_endpoint_up", input: { confirm_spend: true, partition: "gpu" } }, ctx(false));
		assert.equal(declined.block, true);
		assert.match(declined.reason, /declined/);
		assert.match(asked[0][1], /Partition: gpu/);

		const accepted = await call({ type: "tool_call", toolCallId: "2", toolName: "hpc_ensure_endpoint_up", input: { confirm_spend: true } }, ctx(true));
		assert.equal(accepted, undefined, "an accepted call proceeds untouched");

		const noSpend = await call({ type: "tool_call", toolCallId: "3", toolName: "hpc_ensure_endpoint_up", input: { confirm_spend: false } }, ctx(false));
		assert.equal(noSpend, undefined);
		assert.equal(asked.length, 2, "confirm_spend=false does not ask");

		const headless = await call({ type: "tool_call", toolCallId: "4", toolName: "hpc_ensure_endpoint_up", input: { confirm_spend: true } }, { hasUI: false, ui: {} });
		assert.equal(headless.block, true);
		assert.match(headless.reason, /no UI/);

		const guarded = await call({ type: "tool_call", toolCallId: "5", toolName: "hpc_run_shell", input: { command: "export API_KEY=abc && ./run" } }, ctx(true));
		assert.equal(guarded.block, true, "the credential guard covers run_shell");
		const bash = await call({ type: "tool_call", toolCallId: "6", toolName: "bash", input: { command: "PASSWORD=x ./thing" } }, ctx(true));
		assert.equal(bash.block, true, "and bash");
		const clean = await call({ type: "tool_call", toolCallId: "7", toolName: "hpc_login_shell", input: { command: "sinfo -s" } }, ctx(true));
		assert.equal(clean, undefined);
	} finally { restore(); }
});

test("results publish the hpc slot for the column", async () => {
	const restore = withConfig("hpc");
	try {
		const pi = fakePi();
		layer(pi);
		pi.handlers.get("session_start")();
		assert.equal(pi.emitted.at(-1)[1].state, "idle");
		pi.handlers.get("tool_result")({ type: "tool_result", toolCallId: "1", toolName: "hpc_connect_facility", isError: false, content: [{ type: "text", text: '{"phase":"needs_account","facility":"globus-labs","allocations":[]}' }] });
		let [, slot] = pi.emitted.at(-1);
		assert.equal(slot.id, "hpc"); assert.equal(slot.state, "warn"); assert.match(slot.text, /globus-labs/);
		pi.handlers.get("tool_result")({ type: "tool_result", toolCallId: "2", toolName: "hpc_ensure_endpoint_up", isError: false, content: [{ type: "text", text: '{"status":"up","block_state":"warm","session_spend":0.1,"partition":"gpu","account":"lab"}' }] });
		[, slot] = pi.emitted.at(-1);
		assert.equal(slot.state, "busy");
		assert.ok(slot.details().some((d) => /gpu · lab/.test(d)));
		const before = pi.emitted.length;
		pi.handlers.get("tool_result")({ type: "tool_result", toolCallId: "3", toolName: "hpc_run_shell", isError: true, content: [{ type: "text", text: "boom" }] });
		assert.equal(pi.emitted.length, before, "an errored result does not change the slot");
		const notes = [];
		await pi.commands.get("hpc").handler("", { ui: { notify: (m) => notes.push(m) } });
		assert.match(notes[0], /block warm/);
	} finally { restore(); }
});
