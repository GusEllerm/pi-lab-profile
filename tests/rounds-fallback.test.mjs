// The documented contract of rounds.json: "a seat naming a model this machine does not have
// falls back to the session's model, and the round still runs". Driven through the real /round
// handler against a stand-in for pi-subagents' RPC, since the fallback lives in runPhase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import rounds from "../extensions/rounds.ts";

/** A pi whose bus answers like pi-subagents: pings reply, spawns reply (refusing unknown models), agents complete a moment later. */
function fakePi({ known, refuse = {} }) {
	const commands = new Map();
	const bus = new Map();
	const spawns = [];
	const sent = [];
	let nextId = 1;
	const emit = (event, payload) => {
		for (const h of [...(bus.get(event) ?? [])]) h(payload);
	};
	const pi = {
		registerCommand: (name, spec) => commands.set(name, spec),
		on: () => () => {},
		sendMessage: (msg) => sent.push(msg),
		events: {
			on: (event, h) => {
				(bus.get(event) ?? bus.set(event, []).get(event)).push(h);
				return () => bus.set(event, (bus.get(event) ?? []).filter((x) => x !== h));
			},
			emit: (event, payload) => {
				if (event === "subagents:rpc:ping") return emit(`subagents:rpc:ping:reply:${payload.requestId}`, { success: true });
				if (event === "subagents:rpc:spawn") {
					spawns.push(payload);
					const model = payload.options?.model;
					if (refuse[payload.type]) return emit(`subagents:rpc:spawn:reply:${payload.requestId}`, { success: false, error: refuse[payload.type] });
					if (model && !known.includes(model)) return emit(`subagents:rpc:spawn:reply:${payload.requestId}`, { success: false, error: `Model not found: ${model}` });
					const id = `agent-${nextId++}`;
					emit(`subagents:rpc:spawn:reply:${payload.requestId}`, { success: true, data: { id } });
					// the completion listener is subscribed after the spawn reply resolves
					setTimeout(() => emit("subagents:completed", { id, status: "completed", result: payload.type === "critic" ? "CONFIRMED — the change is sound." : `${payload.type} done` }), 5);
					return;
				}
				emit(event, payload);
			},
		},
	};
	return { pi, commands, spawns, sent };
}

const noop = () => {};
const ctxFor = (cwd, notices) => ({
	hasUI: false,
	cwd,
	ui: { notify: (m) => notices.push(m), setStatus: noop, select: async () => undefined },
});

const until = async (pred, ms = 3000) => {
	const t = Date.now() + ms;
	while (!pred() && Date.now() < t) await new Promise((r) => setTimeout(r, 10));
	assert.ok(pred(), "the round did not finish in time");
};

test("a seat whose model is not on this machine falls back to the session's model, and the round completes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "rounds-"));
	try {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "rounds.json"), JSON.stringify({
			dev: "alcf-metis/not-here",
			panel: [{ label: "reviewer A", model: "lab/have-this" }, { label: "reviewer B", model: "gone/model" }],
			critic: "lab/have-this",
		}));
		const { pi, commands, spawns, sent } = fakePi({ known: ["lab/have-this"] });
		rounds(pi);
		const notices = [];
		await commands.get("round").handler("tidy the thing", ctxFor(cwd, notices));
		await until(() => sent.length > 0);

		const byPhase = (type) => spawns.filter((s) => s.type === type).map((s) => s.options?.model);
		assert.deepEqual(byPhase("dev"), ["alcf-metis/not-here", undefined], "dev: the pinned model was refused, then spawned on the session's");
		assert.deepEqual(byPhase("reviewer"), ["lab/have-this", "gone/model", undefined], "reviewer A kept its model; B fell back");
		assert.deepEqual(byPhase("critic"), ["lab/have-this"]);
		assert.match(sent[0].content, /Round finished: tidy the thing/);
		assert.match(sent[0].content, /Verdict: /);
		assert.equal(readdirSync(join(cwd, ".pi", "rounds")).filter((f) => f.endsWith(".md")).length, 1, "the report was written");
		assert.ok(!notices.some((n) => /failed/i.test(n)), `no failure was reported: ${notices.join(" | ")}`);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a spawn refused for any other reason fails that phase, not the round, and is not retried", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "rounds-"));
	try {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "rounds.json"), JSON.stringify({ dev: "x/y", panel: [{ label: "A" }], critic: null }));
		const { pi, commands, spawns, sent } = fakePi({ known: ["x/y"], refuse: { dev: "too many agents" } });
		rounds(pi);
		const notices = [];
		await commands.get("round").handler("do it", ctxFor(cwd, notices));
		await until(() => sent.length > 0);
		assert.equal(spawns.filter((s) => s.type === "dev").length, 1, "no second attempt for a refusal that is not about the model");
		assert.match(sent[0].content, /could not start dev: too many agents/);
		assert.equal(spawns.some((s) => s.type === "reviewer"), false, "nothing to review: the panel is skipped");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
