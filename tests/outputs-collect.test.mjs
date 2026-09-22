// /open reads the session, not the rendered transcript, and -- when attached to a subagent -- that
// agent's session rather than the parent's. Both are driven here: the collector over a hand-built
// branch shaped like real session entries, and the attach override through fleet's event.
import { test } from "node:test";
import assert from "node:assert/strict";
import outputs, { collectFrom } from "../extensions/outputs.ts";

const branch = (label) => [
	{ type: "message", timestamp: "2026-09-22T10:00:00Z", message: { role: "user", content: `${label}: do the thing` } },
	{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(250) }, { type: "toolCall", id: `c-${label}`, name: "edit", arguments: { path: `/repo/${label}.py` } }] } },
	{ type: "message", message: { role: "toolResult", toolName: "edit", toolCallId: `c-${label}`, content: [{ type: "text", text: "ok" }], details: { patch: `--- a/${label}.py\n+++ b/${label}.py\n@@ -1 +1 @@\n-old\n+new\n` } } },
	{ type: "message", message: { role: "bashExecution", command: `echo ${label}`, output: `${label}\n`, exitCode: 0 } },
];

test("collectFrom sees reasoning, edits as diffs, and bash runs, each tagged with its prompt", () => {
	const items = collectFrom(branch("parent"));
	const kinds = items.map((i) => i.kind);
	assert.ok(kinds.includes("thinking"), kinds.join(","));
	assert.ok(kinds.includes("diff"), kinds.join(","));
	const bash = items.find((i) => i.kind === "bash");
	assert.ok(bash, "the bash run is listed");
	assert.equal(bash.detail, "echo parent", "the command is the detail; the output is the text");
	assert.equal(bash.text, "parent");
	assert.ok(items.every((i) => /parent: do the thing/.test(i.prompt)), "every item carries the prompt it followed");
	const diff = items.find((i) => i.kind === "diff");
	assert.match(diff.text, /^--- a\/parent\.py/m);
	assert.match(diff.suggestedName, /parent\.diff$/);
});

test("while attached, /open lists the attached agent's artefacts; detached, the parent's", async () => {
	const handlers = new Map();
	const bus = new Map();
	const commands = new Map();
	const pi = {
		on: (e, h) => { handlers.set(e, h); return () => {}; },
		events: { on: (e, h) => { bus.set(e, h); return () => {}; }, emit: () => {} },
		registerCommand: (name, opts) => commands.set(name, opts),
	};
	outputs(pi);
	const seen = [];
	const ctx = {
		sessionManager: { getBranch: () => branch("parent") },
		ui: {
			notify: (m) => seen.push(["notify", m]),
			// the picker factory receives the filtered items; capture them instead of drawing
			custom: async (factory) => { const picker = factory({ terminal: { rows: 40 } }, {}, {}, () => {}); seen.push(["items", picker.all.map((i) => i.prompt)]); return undefined; },
		},
	};
	await commands.get("open").handler("", ctx);
	assert.ok(seen.at(-1)[1].every((p) => /parent/.test(p)), "detached: the parent's artefacts");

	bus.get("statusbar:attached")({ name: "reviewer A", branch: () => branch("child") });
	await commands.get("open").handler("", ctx);
	assert.ok(seen.at(-1)[1].every((p) => /child/.test(p)), "attached: the agent's artefacts");

	bus.get("statusbar:attached")({ name: "reviewer A", branch: () => [] });
	await commands.get("open").handler("", ctx);
	assert.match(seen.at(-1)[1], /Nothing to open yet in reviewer A/, "an empty attached branch says whose it is");

	bus.get("statusbar:attached")({});
	await commands.get("open").handler("", ctx);
	assert.ok(seen.at(-1)[1].every((p) => /parent/.test(p)), "detached again: back to the parent");
});
