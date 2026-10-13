// Every extension must find Pi's agent directory the same way Pi does. Two of them resolved
// ~/.pi/agent by hand until 13 Oct 2026, and the documented newcomer test
// (PI_CODING_AGENT_DIR=/tmp/pi-clean) silently read the author's real config through them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentDir, readJson } from "../extensions/lib/paths.ts";

test("agentDir follows PI_CODING_AGENT_DIR at call time, and falls back to ~/.pi/agent", () => {
	const saved = process.env.PI_CODING_AGENT_DIR;
	try {
		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(agentDir(), join(homedir(), ".pi", "agent"));
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-clean";
		assert.equal(agentDir(), "/tmp/pi-clean", "read when called, not when the module loaded");
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	}
});

test("readJson: an object, or undefined for missing, malformed and non-object files", () => {
	const dir = mkdtempSync(join(tmpdir(), "paths-"));
	try {
		writeFileSync(join(dir, "ok.json"), '{"a": 1}');
		writeFileSync(join(dir, "bad.json"), "{nope");
		writeFileSync(join(dir, "num.json"), "42");
		assert.deepEqual(readJson(join(dir, "ok.json")), { a: 1 });
		assert.equal(readJson(join(dir, "bad.json")), undefined);
		assert.equal(readJson(join(dir, "num.json")), undefined);
		assert.equal(readJson(join(dir, "missing.json")), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no extension resolves the agent directory by hand", () => {
	const dir = new URL("../extensions/", import.meta.url).pathname;
	const byHand = readdirSync(dir)
		.filter((f) => f.endsWith(".ts"))
		.filter((f) => /\.pi",\s*"agent"|PI_CODING_AGENT_DIR/.test(readFileSync(join(dir, f), "utf8")));
	// hpc-bridge.ts is being changed in another session (13 Oct 2026); it joins lib/paths.ts next.
	assert.deepEqual(byHand.filter((f) => f !== "hpc-bridge.ts"), [], "use agentDir() from extensions/lib/paths.ts");
});
