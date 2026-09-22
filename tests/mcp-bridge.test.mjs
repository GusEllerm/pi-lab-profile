// The bridge drives a real stdio server (tests/fixtures/mcp-echo-server.mjs) through a fake `pi`,
// so what is asserted is the same path a real server takes: spawn, handshake, tools/list,
// registerTool with the server's schema, a forwarded call, an error flagged, a resource written as
// a skill and advertised through resources_discover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bridge, { flattenContent, readConfig, skillText } from "../extensions/mcp.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "mcp-echo-server.mjs");

/** A pi that records what the extension registers and lets the test fire events. */
function fakePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const emitted = [];
	return {
		tools,
		commands,
		handlers,
		emitted,
		registerTool: (t) => tools.set(t.name, t),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		// the bridge emits mcp:server on the bus; a fake without one would make emit() latch dead
		events: { on: () => () => {}, emit: (event, payload) => emitted.push([event, payload]) },
	};
}

test("pure helpers", () => {
	// Pi parses frontmatter as strict YAML; hpc-bridge's real description has colons mid-sentence and
	// Pi refused it ("Nested mappings are not allowed in compact mappings"). Values come out quoted.
	const colons = skillText('---\nname: driving-hpc\ndescription: How to drive HPC: stand up a node, then "run" it\n---\n\n# Body\n', "x");
	assert.match(colons, /^---\nname: "driving-hpc"\ndescription: "How to drive HPC: stand up a node, then \\"run\\" it"\n---\n\n# Body\n$/, colons);
	assert.match(skillText("# Title\n\nbody", "guide", "a guide"), /^---\nname: "guide"\ndescription: "a guide"\n---\n\n# Title/);
	assert.match(skillText("---\nname: x\n---\nbody", "ignored"), /^---\nname: "x"\ndescription: "Guidance served/, "a missing description is supplied");
	assert.equal(flattenContent([{ type: "text", text: "a" }, { type: "image", mimeType: "image/png" }, { type: "text", text: "b" }]), "a\n[image image/png]\nb");
	assert.equal(flattenContent([]), "");
});

test("readConfig reads the project file and names a broken one", () => {
	// only the project file is under the test's control; the global one may or may not exist here
	const cwd = mkdtempSync(join(tmpdir(), "mcp-cfg-"));
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ servers: { fx: { command: "node", args: [fixture] } } }));
		assert.equal(readConfig(cwd).fx?.command, "node");
		writeFileSync(join(cwd, ".pi", "mcp.json"), "{ not json");
		assert.throws(() => readConfig(cwd), /mcp\.json/, "a broken file names itself");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a real stdio server: tools registered, calls forwarded, resource becomes a skill", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "mcp-live-"));
	const home = mkdtempSync(join(tmpdir(), "mcp-home-"));
	const savedHome = process.env.HOME;
	const savedCwd = process.cwd();
	process.env.HOME = home; // the skill cache and the global config both live under HOME
	process.chdir(cwd);
	const pi = fakePi();
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify({ servers: { fx: { command: process.execPath, args: [fixture], skills: [{ uri: "fixture://guidance", name: "fixture-guide", description: "how to use it" }] } } }),
		);
		await bridge(pi);

		assert.deepEqual([...pi.tools.keys()].sort(), ["fx_die", "fx_echo", "fx_fail"], "every server tool is registered under the server prefix");
		const echo = pi.tools.get("fx_echo");
		assert.equal(echo.parameters.type ?? echo.parameters[Object.getOwnPropertySymbols(echo.parameters)[0]], "object", "the server's schema is passed through");
		assert.ok(echo.parameters.properties?.text, "with its properties intact");

		const ok = await echo.execute("t1", { text: "hello", shout: true }, undefined, undefined, {});
		assert.equal(ok.isError, false);
		assert.equal(ok.content[0].text, "HELLO");

		const bad = await pi.tools.get("fx_fail").execute("t2", {}, undefined, undefined, {});
		assert.equal(bad.isError, true, "a server-side isError is flagged, not swallowed");
		assert.equal(bad.content[0].text, "as requested");

		const discover = pi.handlers.get("resources_discover");
		const found = discover({ type: "resources_discover", cwd, reason: "startup" });
		assert.equal(found.skillPaths.length, 1);
		const skill = readFileSync(join(found.skillPaths[0], "SKILL.md"), "utf8");
		assert.match(skill, /^---\nname: "fixture-guide"\ndescription: "how to use it"\n---/, "frontmatter added because the resource had none");
		assert.match(skill, /Call echo\./);

		// the command reports what is connected
		const notes = [];
		await pi.commands.get("mcp").handler("", { ui: { notify: (m) => notes.push(m) } });
		assert.match(notes[0], /fx: 3 tools, skills fixture-guide/); // echo, fail, die
	} finally {
		pi.handlers.get("session_shutdown")?.({ type: "session_shutdown" });
		process.chdir(savedCwd);
		process.env.HOME = savedHome;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("a server that cannot start is reported, not fatal", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "mcp-dead-"));
	const home = mkdtempSync(join(tmpdir(), "mcp-dead-home-"));
	const savedCwd = process.cwd();
	const savedHome = process.env.HOME;
	process.env.HOME = home; // or the machine's own ~/.pi/agent/mcp.json joins in -- it did, with twelve real tools
	process.chdir(cwd);
	const pi = fakePi();
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ servers: { nope: { command: "/definitely/not/a/binary" } } }));
		await bridge(pi); // must not throw
		assert.equal(pi.tools.size, 0);
		const notes = [];
		await pi.commands.get("mcp").handler("", { ui: { notify: (m) => notes.push(m) } });
		assert.match(notes[0], /! nope:/, "the failure is listed by /mcp");
	} finally {
		pi.handlers.get("session_shutdown")?.({ type: "session_shutdown" });
		process.chdir(savedCwd);
		process.env.HOME = savedHome;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("the heartbeat notices a server that stopped answering, and its tools say so", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "mcp-hb-"));
	const home = mkdtempSync(join(tmpdir(), "mcp-hb-home-"));
	const saved = { cwd: process.cwd(), home: process.env.HOME, ping: process.env.PI_MCP_PING_MS };
	process.env.HOME = home;
	process.env.PI_MCP_PING_MS = "150"; // read at module load below, so set before importing a fresh copy
	process.chdir(cwd);
	const pi = fakePi();
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ servers: { fx: { command: process.execPath, args: [fixture] } } }));
		// a fresh module instance so PING_MS picks up the env
		const { default: freshBridge } = await import(`../extensions/mcp.ts?hb=${Date.now()}`);
		await freshBridge(pi);
		const die = pi.tools.get("fx_die");
		const bye = await die.execute("t", {}, undefined, undefined, {});
		assert.equal(bye.content[0].text, "bye");
		const deadline = Date.now() + 4000;
		while (Date.now() < deadline && !pi.emitted.some(([e, p]) => e === "mcp:server" && p.up === false)) await new Promise((r) => setTimeout(r, 50));
		const down = pi.emitted.find(([e, p]) => e === "mcp:server" && p.up === false);
		assert.ok(down, "an mcp:server {up:false} event must follow the server's exit");
		assert.equal(down[1].name, "fx");
		const after = await pi.tools.get("fx_echo").execute("t2", { text: "x" }, undefined, undefined, {});
		assert.equal(after.isError, true);
		assert.match(after.content[0].text, /has not answered since/);
		const notes = [];
		await pi.commands.get("mcp").handler("", { ui: { notify: (m) => notes.push(m) } });
		assert.match(notes[0], /fx: 3 tools.*DOWN since/);
	} finally {
		pi.handlers.get("session_shutdown")?.({ type: "session_shutdown" });
		process.chdir(saved.cwd);
		process.env.HOME = saved.home;
		if (saved.ping === undefined) delete process.env.PI_MCP_PING_MS; else process.env.PI_MCP_PING_MS = saved.ping;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});
