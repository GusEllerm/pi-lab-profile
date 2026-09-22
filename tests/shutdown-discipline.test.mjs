// The class of bug behind the review's H1, H2, M5 and M8: something that runs after
// session_shutdown -- a timer, a promise continuation, a process listener -- reaching for the
// captured pi/ctx. The host catches a throw inside a slash-command handler, but not one from a
// timer, an event callback or a promise nobody awaits, and pi installs no unhandledRejection
// handler, so those exit the process. These assertions pin the specific guards that closed each
// instance. They read the source because the failure is a crash minutes after a /reload, which no
// unit test would ever see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions");
const read = (name) => readFileSync(join(dir, name), "utf8");
const between = (src, start, end) => {
	const a = src.indexOf(start);
	const b = src.indexOf(end, a + 1);
	assert.ok(a !== -1, `marker not found: ${start}`);
	assert.ok(b !== -1, `marker not found: ${end}`);
	return src.slice(a, b);
};

test("rounds: a reload settles every phase still waiting, instead of leaving a 20-minute timer", () => {
	const src = read("rounds.ts");
	const shutdown = between(src, 'pi.on("session_shutdown"', "});");
	assert.match(shutdown, /for \(const settle of pending\) settle\(\);/, "shutdown must settle the pending set");
	assert.equal((src.match(/pending\.add\(abort\)/g) ?? []).length, 2, "both waits in runPhase register with `pending`");
	assert.doesNotMatch(src, /void round\(/, "a round must be launched through launch(), which is its only catch");
	assert.equal((src.match(/launch\(ctx, round\(/g) ?? []).length, 2, "both command sites go through launch()");
	assert.match(src, /async function runPhase[\s\S]*?\{\n\t\tif \(dead\) return RELOADED;/, "runPhase refuses on a dead activation");
});

test("rounds: the reply listener is subscribed before its timer is armed", () => {
	const spawn = between(read("rounds.ts"), "const spawn = (withModel?: string) =>", "let reply = await spawn(model);");
	const subscribe = spawn.indexOf("unsub = pi.events.on(");
	const arm = spawn.indexOf("timer = setTimeout(");
	assert.ok(subscribe !== -1 && arm !== -1, "expected both the subscription and the timer in spawn()");
	assert.ok(subscribe < arm, "a timer armed first can fire into an unsubscriber that was never assigned");
});

test("rounds: a phase that times out stops its agent rather than forgetting it", () => {
	const wait = between(read("rounds.ts"), "const outcome = await new Promise<AgentOutcome>", "emit(\"subagents:rpc:consume\"");
	const timeout = between(wait, "timer = setTimeout(() => {", "}, SPAWN_TIMEOUT_MS);");
	assert.match(timeout, /stopAgent\(id\);/, "the timeout branch must call stopAgent, not just the unsubscriber");
});

test("statusbar: the resize listener is removed on shutdown and its timer refuses when dead", () => {
	const src = read("statusbar.ts");
	assert.match(src, /process\.stdout\.on\("resize", scheduleResizeSettle\)/, "expected the resize hook");
	assert.match(src, /process\.stdout\.off\("resize", scheduleResizeSettle\)/, "every on() needs its off()");
	const settle = between(src, "function scheduleResizeSettle(): void {", "}, 120);");
	assert.equal((settle.match(/if \(dead\) return;/g) ?? []).length, 2, "dead-checked on entry and inside the timer");
	assert.match(src, /function mountSidebar\(tui: TUI\): void \{\n\t\tif \(dead\) return;/, "mountSidebar is reached from timers");
});

test("fleet: the steer continuation has a catch", () => {
	const steer = between(read("fleet.ts"), "Steer \"", "rerender();");
	assert.match(steer, /\.catch\(/, "an un-awaited promise with no catch is a process exit");
	assert.match(steer, /if \(dead\) return;/, "notify after an await must be dead-checked");
});

test("every extension that registers a process listener also removes it", () => {
	for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
		const src = read(name);
		const ons = [...src.matchAll(/process\.(stdout|stdin|stderr)\.on\("([a-z]+)"/g)];
		for (const [, stream, event] of ons) {
			assert.match(src, new RegExp(`process\\.${stream}\\.off\\("${event}"`), `${name}: process.${stream}.on("${event}") has no matching off()`);
		}
		if (/setInterval\(/.test(src)) assert.match(src, /clearInterval\(/, `${name}: setInterval without clearInterval`);
	}
});
