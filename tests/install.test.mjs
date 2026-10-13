// install.sh's promise is "nothing is overwritten, re-running is safe". It is the first script a
// newcomer runs and the one the bundle installer calls, and until 13 Oct 2026 nothing checked it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../scripts/install.sh", import.meta.url).pathname;
const run = (agentDir, ...args) => {
	try {
		return { status: 0, out: execFileSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: join(agentDir, "..", "..") }, stdio: ["ignore", "pipe", "pipe"] }) };
	} catch (e) {
		return { status: e.status, out: `${e.stdout}${e.stderr}` };
	}
};
const lines = (out, mark) => out.split("\n").filter((l) => l.trim().startsWith(mark));

test("example profile: a first run adds, a second run changes nothing, an edited file is left alone", () => {
	const home = mkdtempSync(join(tmpdir(), "install-"));
	try {
		const agentDir = join(home, ".pi", "agent");
		const first = run(agentDir, "example");
		assert.equal(first.status, 0, first.out);
		assert.ok(lines(first.out, "+").length >= 7, `roles and the profile's files are added:\n${first.out}`);
		assert.equal(lines(first.out, "!").length, 0);
		for (const f of ["agents/dev.md", "agents/reviewer.md", "agents/critic.md", "rounds.json", "subagents.json", "pi-cc-extensions.json", "header.json"]) {
			assert.ok(existsSync(join(agentDir, f)), `${f} installed`);
		}
		assert.ok(!existsSync(join(agentDir, "models.json")), "the example profile brings no endpoints");

		const second = run(agentDir, "example");
		assert.equal(second.status, 0);
		assert.equal(lines(second.out, "+").length, 0, `nothing to add the second time:\n${second.out}`);
		assert.ok(lines(second.out, "=").length >= 7, "every file reported as already current");

		const rounds = join(agentDir, "rounds.json");
		writeFileSync(rounds, '{"dev": null, "panel": [], "critic": "mine/model"}\n');
		const third = run(agentDir, "example");
		assert.equal(third.status, 0);
		assert.match(third.out, /! .*rounds\.json exists and differs — left alone/);
		assert.equal(readFileSync(rounds, "utf8"), '{"dev": null, "panel": [], "critic": "mine/model"}\n', "the user's edit survives");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("lab profile: the endpoint config and both helpers arrive, and the helpers are executable", () => {
	const home = mkdtempSync(join(tmpdir(), "install-lab-"));
	try {
		const agentDir = join(home, ".pi", "agent");
		const r = run(agentDir, "lab");
		assert.equal(r.status, 0, r.out);
		for (const f of ["models.json", "mcp.json", "header.json"]) assert.ok(existsSync(join(agentDir, f)), f);
		for (const h of ["globus-tunnel", "alcf-token"]) {
			const file = join(home, ".local", "bin", h);
			assert.ok(existsSync(file), h);
			assert.doesNotThrow(() => execFileSync("test", ["-x", file]), `${h} is executable`);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("an unknown profile is refused before anything is written", () => {
	const home = mkdtempSync(join(tmpdir(), "install-bad-"));
	try {
		const agentDir = join(home, ".pi", "agent");
		const r = run(agentDir, "labb");
		assert.equal(r.status, 2);
		assert.match(r.out, /Unknown profile: labb/);
		assert.ok(!existsSync(join(agentDir, "agents")), "the roles were not copied first");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
