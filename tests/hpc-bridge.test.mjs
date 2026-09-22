// The hpc-bridge layer never talks to the server; it gates and observes through Pi's events. So it
// is driven here through a fake pi and a fake ctx, with results shaped like hpc-bridge's own pydantic
// models (src/hpc_bridge/models.py in that repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import layer, { IDLE_S, applyResult, describe, hpcPrefix, isFresh, looksLikeCredential, parseResult } from "../extensions/hpc-bridge.ts";

function fakePi() {
	const handlers = new Map();
	const bus = new Map();
	const emitted = [];
	const commands = new Map();
	return {
		handlers, emitted, commands,
		bus,
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

test("describe: a compact column and a full account, and the notice only in the latter", () => {
	assert.equal(describe({}).state, "idle");
	const warm = describe(
		{ facility: "globus-labs", status: "up", block: "warm", spend: 0.3, partition: "main", account: "lab", warmSince: 0, notice: "worker live on globus1 (py3.12.3, dill0.3.9). billed block bounds — a task runs up to ~7180s" },
		5 * 60_000,
	);
	assert.equal(warm.state, "busy");
	assert.match(warm.text, /globus-labs · warm 5m/);
	assert.deepEqual(warm.column, ["globus-labs", "up · warm 5m", "main · lab", "0.30 node-h"], "four short rows, no prose");
	assert.ok(warm.column.every((row) => row.length <= 21), warm.column.join(" | "));
	assert.ok(warm.full.some((d) => /worker live on globus1/.test(d)), "the notice is in the full account");
	assert.ok(warm.full.some((d) => /release the block: hpc_stop_endpoint/.test(d)));
	assert.equal(describe({ facility: "x", status: "needs_login" }).state, "warn");
	assert.deepEqual(describe({ facility: "x", status: "needs_login" }).column, ["x", "needs login"]);
	assert.equal(describe({ facility: "x", status: "failed" }).state, "error");
	assert.equal(describe({ facility: "x", status: "down", block: "cold", spend: 0 }).state, "ok");
	assert.deepEqual(describe({ facility: "x", status: "down", block: "cold", spend: 0 }).column, ["x", "down · cold", "0.00 node-h"]);
	assert.match(describe({ facility: "x", status: "up", block: "warm", warmSince: 0 }, 130 * 60_000).column[1], /warm 2h10m/);
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

		// before any accepted allocation, confirm_spend=false provisions nothing (the server's own
		// floor answers needs_confirmation), so there is nothing to ask about
		const noSpend = await call({ type: "tool_call", toolCallId: "3", toolName: "hpc_ensure_endpoint_up", input: { confirm_spend: false } }, ctx(false));
		assert.equal(noSpend, undefined);
		assert.equal(asked.length, 1, "confirm_spend=false does not ask while spend is unconfirmed");

		const accepted = await call({ type: "tool_call", toolCallId: "2", toolName: "hpc_ensure_endpoint_up", input: { confirm_spend: true } }, ctx(true));
		assert.equal(accepted, undefined, "an accepted call proceeds untouched");
		assert.equal(asked.length, 2);
		// from here spend is confirmed and no warm result has arrived, so a provisioning call asks again
		// (as a restart) -- covered in detail by "the gate keys on provisioning, not on the flag"

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
		assert.ok(slot.details().some((d) => /gpu · lab/.test(d)), slot.details().join(" | "));
		const before = pi.emitted.length;
		pi.handlers.get("tool_result")({ type: "tool_result", toolCallId: "3", toolName: "hpc_run_shell", isError: true, content: [{ type: "text", text: "boom" }] });
		assert.equal(pi.emitted.length, before, "an errored result does not change the slot");
		const notes = [];
		await pi.commands.get("hpc").handler("", { ui: { notify: (m) => notes.push(m) } });
		assert.match(notes[0], /block warm/);
		assert.doesNotMatch(slot.details().join("\n"), /release the block/, "the column carries no prose");
	} finally { restore(); }
});

test("warmth is a fact with a TTL: fresh within the idle window, aged out after it", () => {
	const t0 = 1_000_000;
	const warm = applyResult({}, "ensure_endpoint_up", { status: "up", block_state: "warm", session_spend: 0 }, t0);
	assert.equal(warm.spendConfirmed, true, "a warm block means spend was acknowledged server-side");
	assert.equal(isFresh(warm, t0 + 60_000), true);
	assert.equal(isFresh(warm, t0 + IDLE_S * 1000 + 1), false);
	const aged = describe({ ...warm, facility: "globus-labs", warmSince: t0 }, t0 + (IDLE_S + 120) * 1000);
	assert.equal(aged.state, "warn");
	assert.match(aged.column[1], /warm\? no news 12m/);
	assert.ok(aged.full.some((d) => /may restart the block/.test(d)));
	assert.equal(describe({ facility: "x", block: "warm", serverDown: t0, at: t0 }, t0 + 3 * 60_000).state, "error");
	assert.deepEqual(describe({ facility: "x", block: "warm", serverDown: t0, at: t0 }, t0 + 3 * 60_000).column, ["x", "server down 3m"]);
});

test("the gate keys on provisioning, not on the flag", async () => {
	const restore = withConfig("hpc");
	try {
		const pi = fakePi();
		layer(pi);
		const call = pi.handlers.get("tool_call");
		const result = pi.handlers.get("tool_result");
		const asked = [];
		const ctx = (answer) => ({ hasUI: true, ui: { confirm: async (title, msg) => { asked.push([title, msg]); return answer; } } });
		const ensure = (input, c) => call({ type: "tool_call", toolCallId: "e", toolName: "hpc_ensure_endpoint_up", input }, c);
		const run = (input, c) => call({ type: "tool_call", toolCallId: "r", toolName: "hpc_run_shell", input }, c);

		// before any confirmation: the server's own floor answers needs_confirmation without provisioning, so no dialog
		assert.equal(await ensure({ confirm_spend: false }, ctx(true)), undefined);
		assert.equal(await run({ command: "hostname" }, ctx(true)), undefined);
		assert.equal(asked.length, 0);

		// the explicit first allocation asks, and an accepted one marks spend as confirmed
		assert.equal(await ensure({ confirm_spend: true, partition: "main" }, ctx(true)), undefined);
		assert.equal(asked.length, 1);
		assert.match(asked[0][0], /^Start/);

		// a fresh warm result: commands flow without asking
		result({ type: "tool_result", toolCallId: "1", toolName: "hpc_ensure_endpoint_up", isError: false, content: [{ type: "text", text: '{"status":"up","block_state":"warm","session_spend":0.01}' }] });
		assert.equal(await run({ command: "hostname" }, ctx(true)), undefined);
		assert.equal(await ensure({ confirm_spend: false }, ctx(true)), undefined);
		assert.equal(asked.length, 1, "nothing asked while the block is provably warm");

		// the login shape is free and never asks
		assert.equal(await run({ command: "sinfo", shape: "login" }, ctx(true)), undefined);

		// after the idle window with no news, a plain run_shell could restart a block: ask, as a restart
		const realNow = Date.now;
		try {
			Date.now = () => realNow() + (IDLE_S + 60) * 1000;
			const blocked = await run({ command: "hostname" }, ctx(false));
			assert.equal(blocked.block, true);
			assert.match(asked[1][0], /^Restart/);
			assert.match(asked[1][1], /may have idled out/);
			assert.match(blocked.reason, /declined to restart/);
			const allowed = await ensure({ confirm_spend: false }, ctx(true));
			assert.equal(allowed, undefined, "accepted: the call proceeds");
			assert.equal(asked.length, 3);
		} finally {
			Date.now = realNow;
		}
	} finally { restore(); }
});

test("a server that stops answering shows in the row", () => {
	const restore = withConfig("hpc");
	try {
		const pi = fakePi();
		layer(pi);
		pi.handlers.get("tool_result")({ type: "tool_result", toolCallId: "1", toolName: "hpc_connect_facility", isError: false, content: [{ type: "text", text: '{"phase":"provisioning","facility":"globus-labs"}' }] });
		pi.bus.get("mcp:server")({ name: "hpc", up: false, since: Date.now() - 120_000 });
		let [, slot] = pi.emitted.at(-1);
		assert.equal(slot.state, "error");
		assert.match(slot.text, /server down/);
		pi.bus.get("mcp:server")({ name: "other", up: false, since: Date.now() }); // not ours: ignored
		pi.bus.get("mcp:server")({ name: "hpc", up: true });
		[, slot] = pi.emitted.at(-1);
		assert.notEqual(slot.state, "error");
	} finally { restore(); }
});
