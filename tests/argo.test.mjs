// Argo as Pi providers. The catalogue rules mirror argo-claude's; the registration path is driven
// against a local stand-in for argo-proxy; the pty relay -- which exists because ssh reads a Duo
// prompt from the controlling terminal, not stdin -- is driven with a fake interactive child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import argo, { PTY_RELAY, canonical, dedupe, family, looksLikePrompt, modelDef, order, providers, readArgoConfig } from "../extensions/argo.ts";

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
