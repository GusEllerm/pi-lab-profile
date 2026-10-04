#!/usr/bin/env node
// Replay the liveness model over recorded Pi sessions and report how often it would have cried
// "stalled" on tool runs that completed normally -- the false-alarm rate behind its thresholds --
// and how early it would have caught the runs that really did hang. Reads ~/.pi/agent/sessions
// (or $PI_CODING_AGENT_DIR/sessions); nothing leaves the machine.
//
//   node scripts/liveness-replay.mjs            # priors only, as a fresh install would judge
//   node scripts/liveness-replay.mjs --learn    # let each session's own history sharpen the thresholds
//
// Only tool waits are replayed: a session file has when a request started and when its reply was
// appended, but not when the first token arrived, so the thinking and streaming phases cannot be
// judged from it. Those thresholds rest on the measured ceiling instead: a reply with under 100
// output tokens is all time-to-first-token, and on globus that is 12 s at p95, 31 s at p99.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LivenessModel, Timings, thresholds } from "../extensions/liveness.ts";

const learn = process.argv.includes("--learn");
const root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
const files = [];
for (const dir of readdirSync(root)) {
	const d = join(root, dir);
	try {
		if (!statSync(d).isDirectory()) continue;
		for (const f of readdirSync(d)) if (f.endsWith(".jsonl")) files.push(join(d, f));
	} catch {}
}

const timings = new Timings();
const perTool = new Map(); // name -> { runs, slow, stalled, longest, hangs: [] }
const stat = (name) => perTool.get(name) ?? perTool.set(name, { runs: 0, slow: 0, stalled: 0, longest: 0, firstAlarmAt: [] }).get(name);

for (const file of files) {
	const model = new LivenessModel(learn ? timings : new Timings());
	let lastAssistantEnd = 0;
	const starts = new Map();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let e;
		try { e = JSON.parse(line); } catch { continue; }
		if (e.type !== "message") continue;
		const m = e.message ?? {};
		const end = Date.parse(e.timestamp);
		if (m.role === "assistant") {
			lastAssistantEnd = end;
			// sessions before 3 Oct 2026 named hpc-bridge's tools hpc_<tool>; Pi 1.0 names them mcp__hpc__<tool>
			for (const b of m.content ?? []) if (b?.type === "toolCall") starts.set(b.id, { name: String(b.name).replace(/^hpc_/, "mcp__hpc__"), args: b.arguments, at: end });
		} else if (m.role === "toolResult") {
			const s = starts.get(m.toolCallId);
			if (!s) continue;
			starts.delete(m.toolCallId);
			const finished = m.timestamp ?? end;
			// judge the run the way the ticker would have: at its end, with the model's view at the time
			const fresh = new LivenessModel(learn ? timings : new Timings());
			fresh.toolStart(m.toolCallId, s.name, s.args, s.at);
			const v = fresh.verdict(finished);
			const st = stat(s.name);
			st.runs++;
			const ran = (finished - s.at) / 1000;
			st.longest = Math.max(st.longest, ran);
			if (v.level === "slow") st.slow++;
			if (v.level === "stalled") {
				st.stalled++;
				const t = thresholds(timings.quantiles(s.name), "tool");
				st.firstAlarmAt.push([Math.round(ran), t.stalled]);
			}
			fresh.toolEnd(m.toolCallId, finished); // records the duration into `timings` when learning
		}
	}
}

console.log(`${files.length} sessions · ${learn ? "learning as it goes" : "priors only"}\n`);
console.log("tool                              runs   slow  stalled  longest   (stalled = would have alarmed before the run finished)");
for (const [name, s] of [...perTool].sort((a, b) => b[1].runs - a[1].runs)) {
	if (s.runs < 5) continue;
	const pct = (n) => `${((100 * n) / s.runs).toFixed(1)}%`;
	console.log(`${name.padEnd(32)} ${String(s.runs).padStart(6)} ${pct(s.slow).padStart(6)} ${pct(s.stalled).padStart(8)} ${`${Math.round(s.longest)}s`.padStart(8)}`);
}
console.log("\nruns that would have been called stalled, longest first (seconds ran · alarm line):");
const all = [...perTool].flatMap(([name, s]) => s.firstAlarmAt.map(([ran, at]) => [ran, at, name])).sort((a, b) => b[0] - a[0]);
for (const [ran, at, name] of all.slice(0, 15)) console.log(`  ${name.padEnd(28)} ran ${String(ran).padStart(6)}s · alarm at ${at}s`);
