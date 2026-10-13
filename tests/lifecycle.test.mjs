// The shutdown guard, as a helper instead of a convention: the rule that a timer or continuation
// must not touch a replaced activation bit twice when each extension kept its own copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lifecycle } from "../extensions/lib/lifecycle.ts";
import { endpointLabels, on } from "../extensions/lib/bus.ts";

/** A pi stub whose handlers can be fired, and whose bus can be made to throw like a replaced activation's. */
function fakePi() {
	const handlers = new Map();
	const busHandlers = new Map();
	const emitted = [];
	let stale = false;
	return {
		handlers,
		emitted,
		goStale: () => (stale = true),
		on: (event, h) => (handlers.get(event) ?? handlers.set(event, []).get(event)).push(h),
		events: {
			on: (event, h) => (busHandlers.get(event) ?? busHandlers.set(event, []).get(event)).push(h),
			emit: (event, payload) => {
				if (stale) throw new Error("This extension ctx is stale after session replacement or reload");
				emitted.push([event, payload]);
				for (const h of busHandlers.get(event) ?? []) h(payload);
			},
		},
		fire: (event, ...args) => (handlers.get(event) ?? []).forEach((h) => h(...args)),
	};
}

test("dead from shutdown to the next start; emits are dropped in between", () => {
	const pi = fakePi();
	const life = lifecycle(pi);
	assert.equal(life.dead(), false);
	life.emit("statusbar:slot", { id: "x", text: "t" });
	assert.equal(pi.emitted.length, 1);
	pi.fire("session_shutdown");
	assert.equal(life.dead(), true);
	life.emit("statusbar:slot", { id: "x", text: "t" });
	assert.equal(pi.emitted.length, 1, "nothing leaves a dead activation");
	pi.fire("session_start", {}, {});
	assert.equal(life.dead(), false, "a new session revives the flag -- the step each hand copy had to remember");
});

test("an emit that throws marks the activation dead instead of propagating", () => {
	const pi = fakePi();
	const life = lifecycle(pi);
	pi.goStale();
	assert.doesNotThrow(() => life.emit("argo:health", { up: false, models: 0 }), "from a timer this would be an uncaughtException");
	assert.equal(life.dead(), true);
});

test("alive(): not dead, present, and a ctx whose getters still answer with a UI", () => {
	const pi = fakePi();
	const life = lifecycle(pi);
	assert.equal(life.alive(undefined), false);
	assert.equal(life.alive({ hasUI: true }), true);
	assert.equal(life.alive({ hasUI: false }), false, "nothing to draw into");
	const stale = {};
	Object.defineProperty(stale, "hasUI", { get: () => { throw new Error("stale"); } });
	assert.equal(life.alive(stale), false, "a throwing getter is the replaced activation");
	assert.equal(life.dead(), true, "and it is remembered");
});

test("every onShutdown cleanup runs, even when one throws", () => {
	const pi = fakePi();
	const life = lifecycle(pi);
	const ran = [];
	life.onShutdown(() => ran.push("a"));
	life.onShutdown(() => { throw new Error("clearInterval on something odd"); });
	life.onShutdown(() => ran.push("c"));
	pi.fire("session_shutdown");
	assert.deepEqual(ran, ["a", "c"]);
});

test("bus: endpointLabels fills from the event and reports the change", () => {
	const pi = fakePi();
	let changes = 0;
	const labels = endpointLabels(pi, () => changes++);
	pi.events.emit("statusbar:endpoint-labels", { globus: "globus3", "alcf-minerva": "ALCF Minerva" });
	assert.equal(labels.get("globus"), "globus3");
	assert.equal(changes, 1);
	pi.events.emit("statusbar:endpoint-labels", undefined);
	assert.equal(labels.size, 2, "an empty payload is tolerated");
	let seen;
	on(pi, "argo:health", (p) => (seen = p));
	pi.events.emit("argo:health", { up: true, models: 3 });
	assert.deepEqual(seen, { up: true, models: 3 });
});

test("no extension keeps its own dead flag or emit wrapper any more", () => {
	const dir = new URL("../extensions/", import.meta.url).pathname;
	const offenders = readdirSync(dir)
		.filter((f) => f.endsWith(".ts") && f !== "hpc-bridge.ts") // hpc-bridge is in another session's hands (13 Oct 2026)
		.filter((f) => /^\tlet dead = false;|pi\.events\.emit\(event, payload\)/m.test(readFileSync(join(dir, f), "utf8")));
	assert.deepEqual(offenders, [], "use lifecycle(pi) from extensions/lib/lifecycle.ts");
});
