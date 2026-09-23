// Argo as Pi providers. The catalogue rules mirror argo-claude's; the registration path is driven
// against a local stand-in for argo-proxy; the pty relay -- which exists because ssh reads a Duo
// prompt from the controlling terminal, not stdin -- is driven with a fake interactive child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import argo, { BUNDLED_PRICING, PTY_RELAY, canonical, dedupe, estimateTokens, family, findOnPath, isEmptyStream, loadPricing, looksLikePrompt, modelDef, order, parsePricing, probeReason, providers, ratesFor, readArgoConfig, repairUsage, sessionSpend } from "../extensions/argo.ts";

test("rates: argo-dash's canon rules, promos by date, cache as multiples of input", () => {
	const p = BUNDLED_PRICING;
	assert.deepEqual(ratesFor("claude-sonnet-4-6", p), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	assert.deepEqual(ratesFor("claude-4.6-sonnet", p), ratesFor("claude-sonnet-4-6", p), "the alias order folds");
	assert.deepEqual(ratesFor("claude-haiku-4-5-20251001", p), ratesFor("claude-haiku-4-5", p), "a dated suffix is dropped");
	assert.equal(ratesFor("gpt-4o", p), undefined, "no rate, no dollars — as on the dash");
	assert.equal(ratesFor("claude-sonnet-5", p, new Date("2026-08-01")).input, 2, "promo while it lasts");
	assert.equal(ratesFor("claude-sonnet-5", p, new Date("2026-09-01")).input, 3, "list rate after the last day");
	assert.deepEqual(modelDef("claude-sonnet-4-6", p).cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	assert.deepEqual(modelDef("claude-sonnet-4-6").cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "without a table nothing is priced");
	assert.equal(providers(["claude-opus-5", "gpt-5.5"], { user: "u", port: 1 }, p).argo.models[0].cost.output, 25);
});

test("parsePricing rejects a half-formed dump rather than applying part of it", () => {
	assert.equal(parsePricing("not json"), undefined);
	assert.equal(parsePricing(JSON.stringify({ rates: { a: [1] }, cache: { read: 0.1, w5m: 1.25 }, verified: "x" })), undefined, "a rate needs both halves");
	assert.equal(parsePricing(JSON.stringify({ rates: { a: [1, 2] }, cache: { read: 0.1 }, verified: "x" })), undefined, "cache multipliers are required");
	const ok = parsePricing(JSON.stringify({ rates: { "claude-x": [1, 2] }, promos: { "claude-x": [0.5, 1, "2030-01-01"] }, cache: { read: 0.1, w5m: 1.25, w1h: 2 }, verified: "2026-01-01" }));
	assert.equal(ok.source, "argo-dash");
	assert.deepEqual(ratesFor("claude-x", ok), { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: 0.625 });
});

test("loadPricing imports the installed argo-dash, and falls back to the bundled table", async () => {
	const dir = mkdtempSync(join(tmpdir(), "argo-dash-"));
	try {
		const fake = join(dir, "argo-dash");
		writeFileSync(fake, [
			"#!/usr/bin/env python3",
			"import sys",
			"PRICING_VERIFIED = '2030-01-01'",
			"PRICING = {'claude-opus-9': (7.0, 35.0)}",
			"PROMOS = {}",
			"CACHE_MULTIPLIER = {'w5m': 1.25, 'w1h': 2.0, 'read': 0.1}",
			"if __name__ == '__main__': sys.exit(99)",
		].join("\n"));
		assert.equal(findOnPath("argo-dash", `${dir}:/nonexistent`), fake);
		assert.equal(findOnPath("argo-dash", "/nonexistent"), undefined);
		const live = await loadPricing(fake);
		assert.equal(live.source, "argo-dash");
		assert.equal(live.verified, "2030-01-01");
		assert.deepEqual(ratesFor("claude-opus-9", live), { input: 7, output: 35, cacheRead: 0.7, cacheWrite: 8.75 });
		writeFileSync(fake, "PRICING = 'broken'\n");
		assert.equal((await loadPricing(fake)).source, "bundled", "a dash whose table does not parse is ignored whole");
		writeFileSync(fake, "raise SystemExit(3)\n");
		assert.equal((await loadPricing(fake)).source, "bundled", "a dash that fails to import is ignored");
		assert.equal((await loadPricing(join(dir, "missing"))).source, "bundled", "a dash that is not there");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the prompt estimate is Pi's heuristic: chars/4, images flat, tool calls by their arguments", () => {
	assert.equal(estimateTokens([]), 0);
	assert.equal(estimateTokens([{ role: "user", content: "x".repeat(400) }]), 100);
	assert.equal(estimateTokens([{ role: "user", content: [{ type: "text", text: "x".repeat(40) }, { type: "image", data: "…" }] }]), 10 + 1200);
	assert.equal(estimateTokens([{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] }]), Math.ceil((JSON.stringify({ command: "ls" }).length + 20) / 4));
	assert.equal(estimateTokens([{ role: "toolResult", content: [{ type: "text", text: "y".repeat(80) }] }]), 20);
	assert.equal(estimateTokens([], "s".repeat(4000)), 1000, "the system prompt is part of the input");
});

test("repairUsage fills a zeroed prompt count, prices it, marks it, and leaves real counts alone", () => {
	const rates = ratesFor("claude-sonnet-4-6", BUNDLED_PRICING);
	const zeroed = { input: 0, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 200, cost: { input: 0, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
	const fixed = repairUsage(zeroed, 50_000, rates);
	assert.equal(fixed.input, 50_000);
	assert.equal(fixed.totalTokens, 50_200, "the context gauge reads input + output");
	assert.equal(fixed.estimated, true);
	assert.equal(fixed.cost.input, 0.15, "50k tokens at $3/M");
	assert.equal(fixed.cost.total, 0.153);
	assert.equal(fixed.cost.output, 0.003, "the output half was exact and stays");
	assert.equal(repairUsage({ input: 12, output: 4, cacheRead: 0, cacheWrite: 0 }, 999, rates), undefined, "a reported prompt count is not overwritten");
	assert.equal(repairUsage({ input: 0, output: 4, cacheRead: 3000, cacheWrite: 0 }, 999, rates), undefined, "cache reads count as reported");
	assert.equal(repairUsage(undefined, 1, rates), undefined);
	const unpriced = repairUsage({ input: 0, output: 4 }, 100, undefined);
	assert.equal(unpriced.input, 100, "no rate still fixes the token count");
	assert.equal(unpriced.cost.total, 0);
});

test("an unanswering model: the empty-stream wording is recognised and the proxy's nested error unwrapped", () => {
	assert.equal(isEmptyStream("Anthropic stream ended without a stop reason"), true);
	assert.equal(isEmptyStream("HTTP 429 rate limited"), false);
	assert.equal(isEmptyStream(undefined), false);
	// what argo-proxy returned for claude-fable-5-1 and claude-opus-4-1 on 23 Sept 2026
	assert.equal(probeReason('{"error": "Upstream API error: 400 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"Model \'claude-fable-5-1\' (resolved to \'claude-fable-5-1\') is not available.\\"}}"}'), "Model 'claude-fable-5-1' (resolved to 'claude-fable-5-1') is not available.");
	assert.equal(probeReason('{"type": "error", "error": {"type": "invalid_request_error", "message": "Failed to parse upstream response: 1 validation error"}}'), "Failed to parse upstream response: 1 validation error");
	assert.equal(probeReason("<html>Bad Gateway</html>"), "<html>Bad Gateway</html>", "not JSON: returned as is");
	assert.equal(probeReason("x".repeat(500)).length, 160, "bounded");
});

test("sessionSpend sums Argo turns only and reports what it could not price", () => {
	const msg = (provider, usage) => ({ type: "message", message: { role: "assistant", provider, usage } });
	const s = sessionSpend([
		msg("argo", { cost: { total: 0.1 }, estimated: true }),
		msg("argo", { cost: { total: 0.2 } }),
		msg("argo-openai", { cost: { total: 0 } }),
		msg("globus", { cost: { total: 5 } }),
		{ type: "message", message: { role: "user" } },
	]);
	assert.equal(s.turns, 3);
	assert.ok(Math.abs(s.cost - 0.3) < 1e-9);
	assert.equal(s.estimated, true);
	assert.equal(s.unpriced, 1);
	assert.equal(sessionSpend([]).turns, 0);
});

test("message_end: an Argo Claude turn with zeroed input comes back estimated; other providers pass through", async () => {
	const handlers = new Map();
	const pi = {
		registerProvider: () => {},
		unregisterProvider: () => {},
		registerCommand: () => {},
		on: (e, h) => { handlers.set(e, h); return () => {}; },
		events: { on: () => () => {}, emit: () => {} },
	};
	const savedHome = process.env.HOME;
	process.env.HOME = mkdtempSync(join(tmpdir(), "argo-nohome-"));
	try {
		await argo(pi);
		const hook = handlers.get("message_end");
		assert.ok(hook, "argo.ts hooks message_end");
		const ctx = {
			sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "q".repeat(4000), timestamp: 1 } }] },
			getSystemPrompt: () => "s".repeat(4000),
		};
		const turn = { role: "assistant", provider: "argo", model: "claude-sonnet-4-6", timestamp: 2, stopReason: "stop", usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0.00015, cacheRead: 0, cacheWrite: 0, total: 0.00015 } } };
		const out = hook({ message: turn }, ctx);
		assert.equal(out.message.usage.input, 2000, "prompt (1000) plus system (1000) tokens");
		assert.equal(out.message.usage.estimated, true);
		assert.ok(out.message.usage.cost.total > 0.005, "priced at sonnet's input rate: 2000 tokens is $0.006");
		assert.equal(hook({ message: { ...turn, provider: "globus" } }, ctx), undefined, "not Argo, not touched");
		assert.equal(hook({ message: { ...turn, provider: "argo-openai" } }, ctx), undefined, "the OpenAI path reports usage itself");
		assert.equal(hook({ message: { ...turn, stopReason: "error" } }, ctx), undefined);
		assert.equal(hook({ message: { ...turn, usage: { ...turn.usage, input: 900 } } }, ctx), undefined, "a real count is kept");
		handlers.get("session_shutdown")?.();
	} finally {
		rmSync(process.env.HOME, { recursive: true, force: true });
		process.env.HOME = savedHome;
	}
});

test("canonical ids: argo-claude's rules", () => {
	assert.equal(canonical("argo:claude-opus-4.8"), "claude-opus-4-8");
	assert.equal(canonical("argo:claude-4.8-opus"), "claude-opus-4-8", "the reversed alias folds to the same id");
	assert.equal(canonical("argo:claude-5-sonnet"), "claude-sonnet-5");
	assert.equal(canonical("argo:gpt-5.6-sol"), "gpt-5.6-sol", "non-Claude ids keep their dots");
	assert.equal(canonical("argo:gemma-4-31b-[test]"), undefined);
	assert.equal(canonical("argo:text-embedding-3-small"), undefined);
	assert.equal(canonical("argo:bge-reranker-v2-m3-[test]"), undefined);
});

test("dedupe folds the aliases Argo lists twice, and order puts the frontier first", () => {
	const raw = ["argo:gpt-4o", "argo:claude-5-opus", "argo:claude-opus-5", "argo:claude-4.6-sonnet", "argo:claude-sonnet-4.6", "argo:gemini-2.5-pro", "argo:text-embedding-ada-002", "argo:laguna-s-2.1-[test]"];
	const ids = dedupe(raw);
	assert.deepEqual(ids, ["gpt-4o", "claude-opus-5", "claude-sonnet-4-6", "gemini-2.5-pro"]);
	assert.deepEqual(order(ids), ["claude-opus-5", "claude-sonnet-4-6", "gemini-2.5-pro", "gpt-4o"]);
});

test("families and metadata", () => {
	assert.equal(family("claude-opus-5"), "claude");
	assert.equal(family("o3-mini"), "openai");
	assert.equal(family("gpt-4.1"), "openai");
	assert.equal(family("gemini-3.5-flash"), "gemini");
	assert.equal(family("laguna-s-2.1"), "other");
	assert.equal(modelDef("claude-opus-5").reasoning, true);
	assert.equal(modelDef("gpt-4o").reasoning, false);
	assert.equal(modelDef("gpt-5.5").reasoning, true);
	assert.equal(modelDef("o4-mini").reasoning, true);
	assert.deepEqual(modelDef("gpt-4o").cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("two providers, because the two APIs disagree about baseUrl", () => {
	const p = providers(["claude-opus-5", "gpt-5.5", "gemini-2.5-pro"], { user: "someone", port: 44497 });
	assert.equal(p.argo.api, "anthropic-messages");
	assert.equal(p.argo.baseUrl, "http://127.0.0.1:44497", "Anthropic clients append /v1/messages themselves");
	assert.deepEqual(p.argo.models.map((m) => m.id), ["claude-opus-5"]);
	assert.equal(p["argo-openai"].api, "openai-completions");
	assert.equal(p["argo-openai"].baseUrl, "http://127.0.0.1:44497/v1", "OpenAI clients append /chat/completions to a /v1 base");
	assert.deepEqual(p["argo-openai"].models.map((m) => m.id), ["gpt-5.5", "gemini-2.5-pro"]);
	assert.equal(p.argo.apiKey, "someone", "Argo authenticates by username");
});

test("readArgoConfig parses argo-setup's file", () => {
	const dir = mkdtempSync(join(tmpdir(), "argo-cfg-"));
	try {
		const file = join(dir, "config");
		writeFileSync(file, "# argo-tools configuration\nANL_USER=someone\nARGO_PORT=45000\nSSH_KEY=/x\n");
		assert.deepEqual(readArgoConfig(file), { user: "someone", port: 45000, file });
		writeFileSync(file, "ARGO_PORT=1\n");
		assert.equal(readArgoConfig(file), undefined, "no user, no config");
		assert.equal(readArgoConfig(join(dir, "missing")), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a prompt is an unterminated line asking for something", () => {
	assert.equal(looksLikePrompt("Duo two-factor login for someone\n\nEnter a passcode or select one of the following options:\n\n 1. Duo Push\n\nPasscode or option (1-3): "), "Passcode or option (1-3):");
	assert.equal(looksLikePrompt("[argo-up] Control channel already up.\n"), undefined, "a finished line is not a prompt");
	assert.equal(looksLikePrompt("Enter passphrase for key '/x/gce': "), "Enter passphrase for key '/x/gce':");
	assert.equal(looksLikePrompt("[argo-up] Ensuring argo-proxy is running"), undefined, "progress text is not a prompt");
});

test("the pty relay round-trips a prompt: child asks, we answer on stdin, it reads from its tty", async () => {
	const dir = mkdtempSync(join(tmpdir(), "argo-pty-"));
	try {
		const fake = join(dir, "fake-up.py");
		writeFileSync(fake, [
			"import sys",
			"sys.stdout.write('[fake] connecting\\n'); sys.stdout.flush()",
			"sys.stdout.write('Passcode or option (1-3): '); sys.stdout.flush()",
			"ans = sys.stdin.readline().strip()",
			"sys.stdout.write('[fake] got ' + ans + '\\n'); sys.stdout.flush()",
			"sys.exit(0 if ans == '1' else 3)",
		].join("\n"));
		const proc = spawn("python3", ["-c", PTY_RELAY, "python3", fake], { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		proc.stdout.on("data", (d) => (out += d.toString()));
		const until = async (re, ms = 8000) => { const t = Date.now() + ms; while (!re.test(out) && Date.now() < t) await new Promise((r) => setTimeout(r, 30)); assert.match(out, re); };
		await until(/Passcode or option \(1-3\): $/);
		assert.equal(looksLikePrompt(out.replace(/\r/g, "")), "Passcode or option (1-3):");
		proc.stdin.write("1\n");
		const code = await new Promise((r) => proc.on("close", r));
		assert.match(out, /got 1/);
		assert.equal(code, 0, "the child's exit code comes back through the relay");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the relay's wrapper outlives the command while the hold test passes, and leaves when it fails", async () => {
	// argo-up's tunnel died when argo-up, as the pty's session leader, exited: the wrapper shell is
	// the leader now, and stays while PTY_RELAY_HOLD passes. Prove the session lives past the relay.
	const dir = mkdtempSync(join(tmpdir(), "argo-hold-"));
	try {
		const flag = join(dir, "flag");
		const log = join(dir, "ticks");
		writeFileSync(flag, "");
		const proc = spawn("python3", ["-c", PTY_RELAY, "sh", "-c", "echo started; exit 7"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PTY_RELAY_HOLD: `echo tick >> '${log}' && [ -e '${flag}' ]`, PTY_RELAY_HOLD_S: "0.1" },
		});
		let out = "";
		proc.stdout.on("data", (d) => (out += d.toString()));
		const code = await new Promise((r) => proc.on("close", r));
		assert.equal(code, 7, "the command's exit code, read from the marker line");
		assert.match(out, /started/);
		assert.doesNotMatch(out, /__PTY_RELAY_EXIT__/, "the marker never reaches the caller");
		const ticks = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
		const before = ticks();
		await new Promise((r) => setTimeout(r, 400));
		assert.ok(ticks() > before, "the wrapper is still polling after the relay returned");
		rmSync(flag);
		await new Promise((r) => setTimeout(r, 400));
		const settled = ticks();
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(ticks(), settled, "once the hold test fails the wrapper exits");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("startup registers both providers from a live catalogue, and none when the tunnel is down", async () => {
	const server = createServer((req, res) => {
		if (req.url === "/health") return res.end(JSON.stringify({ status: "healthy" }));
		if (req.url === "/v1/models") return res.end(JSON.stringify({ data: ["argo:claude-opus-5", "argo:claude-5-opus", "argo:gpt-4o", "argo:text-embedding-3-small"].map((id) => ({ id })) }));
		res.statusCode = 404; res.end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const home = mkdtempSync(join(tmpdir(), "argo-home-"));
	const savedHome = process.env.HOME;
	process.env.HOME = home;
	try {
		mkdirSync(join(home, ".config", "argo-tools"), { recursive: true });
		writeFileSync(join(home, ".config", "argo-tools", "config"), `ANL_USER=someone\nARGO_PORT=${port}\n`);
		const registered = new Map();
		const handlers = new Map();
		const pi = {
			registerProvider: (name, cfg) => registered.set(name, cfg),
			unregisterProvider: (name) => registered.delete(name),
			registerCommand: () => {},
			on: (e, h) => { handlers.set(e, h); return () => {}; },
			events: { on: () => () => {}, emit: () => {} },
		};
		await argo(pi);
		assert.deepEqual([...registered.keys()].sort(), ["argo", "argo-openai"]);
		assert.deepEqual(registered.get("argo").models.map((m) => m.id), ["claude-opus-5"], "aliases folded, embeddings dropped");
		assert.deepEqual(registered.get("argo-openai").models.map((m) => m.id), ["gpt-4o"]);
		assert.equal(registered.get("argo").apiKey, "someone");
		handlers.get("session_shutdown")?.();

		// tunnel down: nothing registered, nothing thrown
		server.close();
		const registered2 = new Map();
		const handlers2 = new Map();
		await argo({ ...pi, registerProvider: (n, c) => registered2.set(n, c), on: (e, h) => { handlers2.set(e, h); return () => {}; } });
		assert.equal(registered2.size, 0);
		handlers2.get("session_shutdown")?.();
	} finally {
		process.env.HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
		server.close();
	}
});
