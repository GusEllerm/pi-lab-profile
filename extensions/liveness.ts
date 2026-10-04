/**
 * liveness — "is this agent stuck?", answered from inside the harness.
 *
 * An agent that looks stuck is in one of a few phases, each with its own normal wait: thinking
 * (request sent, no token yet), streaming (tokens arriving), a tool running, waiting on a human
 * (a question dialog), waiting on a subagent, or queued behind the concurrency cap. So the model
 * here keeps, per agent, the phase and the time of the last sign of progress, and judges that gap
 * against what the same phase usually takes -- never the total reply time, which scales with how
 * much the model has to say.
 *
 * "Usually" is measured, not guessed. PRIORS below came from 427 recorded sessions (56k entries,
 * 4 Oct 2026): bash answers in 4.7 s at p95 and 45 s at p99 but once hung for 2.6 h; a globus
 * reply with under 100 output tokens -- the time-to-first-token ceiling -- takes 12 s at p95 and
 * 31 s at p99; hpc run_shell returns within its 120 s sync wait. Every session keeps learning:
 * durations go into a reservoir per key, p95/p99 are read from it once it holds 20 samples, and
 * the reservoirs persist in <agent-dir>/cache/liveness.json so the next session starts informed.
 * A phase is `slow` past 2× its p95 and `stalled` past 2× its p99, both with floors, so a run
 * flagged stalled is one that has already outlasted twice the worst of a hundred normal ones.
 * Three identical tool calls in a row are `looping`, which is progress of the useless kind.
 *
 * Surfaces: a LIVENESS row in the column (hidden while everything is fine), marks on fleet's
 * agent rows, /stuck for the whole picture with the evidence, and one notification per episode.
 * Nothing is ever aborted from here; a stuck agent is the user's call.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── timings: what each wait usually takes ────────────────────────────────────────────────────
export type Quantiles = { p95: number; p99: number };

/** Seconds, from the recorded sessions. Keys: a tool name, `ttft:<provider>`, or `gap` (between tokens). */
export const PRIORS: Record<string, Quantiles> = {
	bash: { p95: 4.7, p99: 45 },
	read: { p95: 0.5, p99: 2 },
	edit: { p95: 0.5, p99: 2 },
	write: { p95: 0.5, p99: 2 },
	grep: { p95: 0.5, p99: 2 },
	find: { p95: 0.5, p99: 2 },
	ls: { p95: 0.5, p99: 2 },
	agent_browser: { p95: 16, p99: 37 },
	mcp__hpc__run_shell: { p95: 120, p99: 125 },
	mcp__hpc__poll_task: { p95: 180, p99: 185 },
	mcp__hpc__ensure_endpoint_up: { p95: 26, p99: 60 },
	mcp__hpc__connect_facility: { p95: 11, p99: 30 },
	mcp__hpc__list_facilities: { p95: 1, p99: 5 },
	"ttft:globus": { p95: 12, p99: 31 },
	"ttft:alcf-minerva": { p95: 4, p99: 7 },
	"ttft:alcf-metis": { p95: 3, p99: 5 },
	"ttft:alcf-sophia": { p95: 15, p99: 21 },
	"ttft:argo": { p95: 10, p99: 20 },
	"ttft:argo-openai": { p95: 10, p99: 20 },
	gap: { p95: 5, p99: 15 },
};
const DEFAULT_TOOL: Quantiles = { p95: 10, p99: 60 };
const DEFAULT_TTFT: Quantiles = { p95: 15, p99: 45 };

/** Seconds. A phase is never called slow or stalled sooner than this, however tight its history. */
export const FLOORS = {
	tool: { slow: 10, stalled: 60 },
	ttft: { slow: 20, stalled: 60 },
	gap: { slow: 15, stalled: 30 },
};

export const RESERVOIR = 200;
export const MIN_SAMPLES = 20;

export class Timings {
	samples = new Map<string, number[]>();
	constructor(saved?: Record<string, number[]>) {
		for (const [k, v] of Object.entries(saved ?? {})) if (Array.isArray(v)) this.samples.set(k, v.filter((x) => typeof x === "number").slice(-RESERVOIR));
	}
	record(key: string, seconds: number): void {
		const xs = this.samples.get(key) ?? [];
		xs.push(seconds);
		if (xs.length > RESERVOIR) xs.shift();
		this.samples.set(key, xs);
	}
	/** Learned once there are enough samples; the prior until then; a default for the unknown. */
	quantiles(key: string): Quantiles & { source: "learned" | "prior" | "default" } {
		const xs = this.samples.get(key);
		if (xs && xs.length >= MIN_SAMPLES) {
			const s = [...xs].sort((a, b) => a - b);
			const at = (p: number) => s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))];
			return { p95: at(95), p99: at(99), source: "learned" };
		}
		const prior = PRIORS[key] ?? (key.startsWith("ttft:") ? DEFAULT_TTFT : key === "gap" ? PRIORS.gap : DEFAULT_TOOL);
		return { ...prior, source: PRIORS[key] ? "prior" : "default" };
	}
	toJSON(): Record<string, number[]> {
		return Object.fromEntries(this.samples);
	}
}

/** Where the slow and stalled lines fall for one wait, in seconds. */
export function thresholds(q: Quantiles, kind: keyof typeof FLOORS): { slow: number; stalled: number } {
	const f = FLOORS[kind];
	const slow = Math.max(2 * q.p95, f.slow);
	return { slow, stalled: Math.max(2 * q.p99, f.stalled, slow + 10) };
}

// ── the model ────────────────────────────────────────────────────────────────────────────────
export type Phase = "idle" | "queued" | "thinking" | "streaming" | "tool" | "waiting-human" | "waiting-agent" | "done";
export type Level = "ok" | "slow" | "stalled" | "looping" | "waiting";
export type Verdict = { level: Level; phase: Phase; since: number; waitMs: number; summary: string; evidence: string[]; /** two short rows for a ~21-cell column */ brief: string[] };

/** Tools that wait on a person: never stuck, however long. */
export const HUMAN_TOOLS = /ask_user|question|confirm/i;
/** Tools that wait on another agent: judged by that agent's own liveness. */
export const AGENT_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent", "SubagentWorkflow", "wait_for_subagent"]);
export const LOOP_RUN = 3;

type Running = { name: string; startedAt: number; lastUpdate: number };

export class LivenessModel {
	phase: Phase = "idle";
	/** when the current phase began */
	since = 0;
	/** the last sign of progress: a token, a tool update, a result */
	lastProgress = 0;
	provider = "";
	tools = new Map<string, Running>();
	calls: string[] = [];
	loop = 0;
	promptDepth = 0;
	private timings: Timings;

	constructor(timings: Timings) {
		this.timings = timings;
	}

	private enter(phase: Phase, now: number): void {
		if (this.phase !== phase) this.since = now;
		this.phase = phase;
		this.lastProgress = now;
	}

	queued(now: number): void {
		this.enter("queued", now);
	}
	/** A request went out. */
	start(provider: string, now: number): void {
		this.provider = provider;
		this.enter("thinking", now);
	}
	/** A token (text, thinking or tool-call delta) arrived. */
	token(now: number): void {
		if (this.phase === "thinking") this.timings.record(`ttft:${this.provider}`, (now - this.since) / 1000);
		else if (this.phase === "streaming") this.timings.record("gap", (now - this.lastProgress) / 1000);
		this.enter("streaming", now);
	}
	/** The reply is complete; tools, if any, follow. */
	messageEnd(now: number): void {
		if (this.phase === "thinking" || this.phase === "streaming") this.enter("idle", now);
	}
	toolStart(id: string, name: string, args: unknown, now: number): void {
		this.tools.set(id, { name, startedAt: now, lastUpdate: now });
		// three identical calls in a row is a loop; a different call ends it
		const sig = `${name} ${safe(args)}`;
		this.calls.push(sig);
		if (this.calls.length > 8) this.calls.shift();
		const tail = this.calls.slice(-LOOP_RUN);
		this.loop = tail.length === LOOP_RUN && tail.every((s) => s === sig) ? this.loop + 1 : 0;
		this.enter(HUMAN_TOOLS.test(name) ? "waiting-human" : AGENT_TOOLS.has(name) ? "waiting-agent" : "tool", now);
	}
	toolUpdate(id: string, now: number): void {
		const t = this.tools.get(id);
		if (t) t.lastUpdate = now;
		this.lastProgress = now;
	}
	toolEnd(id: string, now: number): void {
		const t = this.tools.get(id);
		if (t) {
			this.tools.delete(id);
			if (!HUMAN_TOOLS.test(t.name) && !AGENT_TOOLS.has(t.name)) this.timings.record(t.name, (now - t.startedAt) / 1000);
		}
		this.lastProgress = now;
		if (this.tools.size === 0) this.enter("idle", now);
		else this.enter(phaseOf(this.longest()!.name), now);
	}
	/** A UI dialog is up: the agent waits for the user, whatever else it was doing. */
	promptStart(now: number): void {
		this.promptDepth++;
		this.lastProgress = now;
	}
	promptEnd(now: number): void {
		this.promptDepth = Math.max(0, this.promptDepth - 1);
		this.lastProgress = now;
	}
	settled(now: number): void {
		this.tools.clear();
		this.loop = 0;
		this.enter("idle", now);
	}
	done(now: number): void {
		this.tools.clear();
		this.enter("done", now);
	}

	private longest(): Running | undefined {
		let best: Running | undefined;
		for (const t of this.tools.values()) if (!best || t.startedAt < best.startedAt) best = t;
		return best;
	}

	verdict(now: number): Verdict {
		const wait = now - this.lastProgress;
		const base = (level: Level, summary: string, evidence: string[] = [], brief: string[] = []): Verdict => ({ level, phase: this.phase, since: this.since, waitMs: wait, summary, evidence, brief });
		const briefOf = (q: Quantiles, t: { slow: number; stalled: number }) => [`usual ${fmtS(q.p95 * 1000)} · p99 ${fmtS(q.p99 * 1000)}`, `slow >${fmtS(t.slow * 1000)} · stuck >${fmtS(t.stalled * 1000)}`];
		if (this.promptDepth > 0) return base("waiting", "waiting for you (a dialog is open)");
		if (this.loop >= 1) return base("looping", `same call ${LOOP_RUN + this.loop - 1}× running`, [this.calls.at(-1) ?? ""]);
		switch (this.phase) {
			case "idle":
			case "done":
				return base("ok", this.phase === "done" ? "finished" : "idle");
			case "queued":
				return base("waiting", `queued ${fmtS(wait)} — waiting for a slot, not stuck`);
			case "waiting-human":
				return base("waiting", `waiting for you (${this.longest()?.name ?? "a question"}) ${fmtS(wait)}`);
			case "waiting-agent":
				return base("waiting", `waiting on a subagent (${this.longest()?.name}) ${fmtS(wait)} — see that agent's row`);
			case "thinking": {
				const q = this.timings.quantiles(`ttft:${this.provider}`);
				const t = thresholds(q, "ttft");
				const level: Level = wait >= t.stalled * 1000 ? "stalled" : wait >= t.slow * 1000 ? "slow" : "ok";
				return base(level, `no first token for ${fmtS(wait)}`, [`${this.provider} usually answers in ${fmtS(q.p95 * 1000)} (p95) · ${fmtS(q.p99 * 1000)} (p99) · ${q.source}`, `slow past ${fmtS(t.slow * 1000)} · stalled past ${fmtS(t.stalled * 1000)}`], briefOf(q, t));
			}
			case "streaming": {
				const q = this.timings.quantiles("gap");
				const t = thresholds(q, "gap");
				const level: Level = wait >= t.stalled * 1000 ? "stalled" : wait >= t.slow * 1000 ? "slow" : "ok";
				return base(level, level === "ok" ? "streaming" : `no token for ${fmtS(wait)} mid-reply`, [`tokens usually ${fmtS(q.p99 * 1000)} apart at worst (p99) · stalled past ${fmtS(t.stalled * 1000)}`], briefOf(q, t));
			}
			case "tool": {
				const t0 = this.longest()!;
				const ran = now - t0.startedAt;
				const q = this.timings.quantiles(t0.name);
				const t = thresholds(q, "tool");
				const level: Level = ran >= t.stalled * 1000 ? "stalled" : ran >= t.slow * 1000 ? "slow" : "ok";
				return base(level, `${t0.name} running ${fmtS(ran)}`, [`${t0.name} usually ${fmtS(q.p95 * 1000)} (p95) · ${fmtS(q.p99 * 1000)} (p99) · ${q.source}`, `slow past ${fmtS(t.slow * 1000)} · stalled past ${fmtS(t.stalled * 1000)}`], briefOf(q, t));
			}
		}
	}
}

const phaseOf = (name: string): Phase => (HUMAN_TOOLS.test(name) ? "waiting-human" : AGENT_TOOLS.has(name) ? "waiting-agent" : "tool");
const safe = (v: unknown): string => {
	try {
		return JSON.stringify(v) ?? "";
	} catch {
		return String(v);
	}
};
export const fmtS = (ms: number): string => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${(s / 3600).toFixed(1)}h`;
};

/** Translate one Pi session event (the primary's, or a subagent's through session.subscribe) into the model. */
export function observe(model: LivenessModel, event: { type?: string; [k: string]: unknown }, now: number): boolean {
	switch (event.type) {
		case "message_start": {
			const m = event.message as { role?: string; provider?: string } | undefined;
			if (m?.role === "assistant") model.start(m.provider ?? "?", now);
			return true;
		}
		case "message_update": {
			const kind = (event.assistantMessageEvent as { type?: string } | undefined)?.type ?? "";
			if (/delta|start/.test(kind)) model.token(now);
			return true;
		}
		case "message_end":
			model.messageEnd(now);
			return true;
		case "tool_execution_start":
			model.toolStart(String(event.toolCallId), String(event.toolName), event.args, now);
			return true;
		case "tool_execution_update":
			model.toolUpdate(String(event.toolCallId), now);
			return true;
		case "tool_execution_end":
			model.toolEnd(String(event.toolCallId), now);
			return true;
		case "ui_prompt_start":
			model.promptStart(now);
			return true;
		case "ui_prompt_end":
			model.promptEnd(now);
			return true;
		case "agent_settled":
		case "agent_end":
			model.settled(now);
			return true;
		default:
			return false;
	}
}

// ── the extension ────────────────────────────────────────────────────────────────────────────
export const TICK_MS = 2000;

export default function (pi: ExtensionAPI): void {
	let dead = false;
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const file = join(agentDir, "cache", "liveness.json");
	let saved: Record<string, number[]> | undefined;
	try {
		if (existsSync(file)) saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, number[]>;
	} catch {
		saved = undefined;
	}
	const timings = new Timings(saved);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	const save = () => {
		if (saveTimer) return;
		saveTimer = setTimeout(() => {
			saveTimer = undefined;
			try {
				mkdirSync(join(agentDir, "cache"), { recursive: true });
				writeFileSync(file, JSON.stringify(timings.toJSON()));
			} catch {
				// a timing cache that cannot be written is a timing cache that starts over
			}
		}, 5000);
	};

	const primary = new LivenessModel(timings);
	/** subagents by id: their model, name, and how to stop listening */
	const agents = new Map<string, { model: LivenessModel; name: string; off?: () => void }>();
	const episodes = new Map<string, Level>(); // last level told per agent, so each episode is said once
	let ctxRef: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	const emit = (event: string, payload: unknown) => {
		if (dead) return;
		try {
			pi.events.emit(event, payload);
		} catch {
			dead = true;
		}
	};

	const publish = () => {
		const now = Date.now();
		const v = primary.verdict(now);
		const bad = v.level === "slow" || v.level === "stalled" || v.level === "looping";
		emit("statusbar:slot", {
			id: "liveness",
			text: bad ? `${v.level} · ${v.summary}` : "ok",
			state: v.level === "stalled" || v.level === "looping" ? "error" : v.level === "slow" ? "warn" : "idle",
			statusKey: "liveness",
			// the column is ~21 cells wide: the verdict and the phase on one row, two short rows of why
			details: () => {
				const d = primary.verdict(Date.now());
				const what = d.phase === "tool" ? d.summary.replace(/ running /, " ") : d.phase === "thinking" ? `no token ${fmtS(d.waitMs)}` : d.phase === "streaming" ? `no token ${fmtS(d.waitMs)}` : d.summary;
				return [`${d.level} · ${what}`, ...d.brief];
			},
		});
		const marks: Record<string, { level: Level; summary: string }> = {};
		for (const [id, a] of agents) {
			const av = a.model.verdict(now);
			marks[id] = { level: av.level, summary: av.summary };
		}
		emit("liveness:agents", marks);
		tell("you", v);
		for (const [id, a] of agents) tell(a.name, a.model.verdict(now), id);
	};
	const tell = (name: string, v: Verdict, id = "primary") => {
		const alarm = v.level === "stalled" || v.level === "looping";
		const before = episodes.get(id);
		if (alarm && before !== v.level && ctxRef?.hasUI) {
			ctxRef.ui.notify(`liveness: ${name === "you" ? "this session" : name} looks ${v.level} — ${v.summary}. ${v.evidence[0] ?? ""} /stuck for the picture`, "warning");
		}
		if (alarm) episodes.set(id, v.level);
		else if (v.level === "ok" || v.level === "waiting") episodes.delete(id);
	};
	const ensureTicker = () => {
		if (ticker || dead) return;
		ticker = setInterval(() => {
			if (dead) return;
			const active = primary.phase !== "idle" || agents.size > 0;
			if (!active) {
				clearInterval(ticker!);
				ticker = undefined;
			}
			publish();
		}, TICK_MS);
	};

	// the primary session, through Pi's own events
	for (const type of ["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "ui_prompt_start", "ui_prompt_end", "agent_end", "agent_settled"] as const) {
		pi.on(type as never, ((event: { type?: string }) => {
			if (dead) return undefined;
			if (observe(primary, event, Date.now())) {
				if (event.type?.startsWith("tool_execution_end") || event.type === "message_update") save();
				ensureTicker();
			}
			return undefined;
		}) as never);
	}

	// subagents: pi-subagents runs them in-process; their sessions stream the same events
	const registry = () => (globalThis as Record<symbol, { getRecord?: (id: string) => { session?: { subscribe?: (fn: (e: unknown) => void) => () => void } } } | undefined>)[Symbol.for("pi-subagents:manager")];
	const watch = (id: string, name: string) => {
		const have = agents.get(id);
		if (have?.off) return;
		const model = have?.model ?? new LivenessModel(timings);
		const entry = { model, name, off: undefined as (() => void) | undefined };
		agents.set(id, entry);
		try {
			const session = registry()?.getRecord?.(id)?.session;
			const off = session?.subscribe?.((e) => {
				if (!dead && e && typeof e === "object") observe(model, e as { type?: string }, Date.now());
			});
			if (off) {
				entry.off = off;
				model.start("subagent", Date.now());
			}
		} catch {
			// no session to listen to: the agent shows as running with no verdict beyond "no news"
		}
		ensureTicker();
	};
	pi.events.on("subagents:created", (data) => {
		const d = data as { id?: string; type?: string; description?: string } | undefined;
		if (!d?.id || dead) return;
		const model = agents.get(d.id)?.model ?? new LivenessModel(timings);
		model.queued(Date.now());
		agents.set(d.id, { model, name: d.description || d.type || d.id });
		ensureTicker();
	});
	pi.events.on("subagents:started", (data) => {
		const d = data as { id?: string; type?: string; description?: string } | undefined;
		if (d?.id && !dead) watch(d.id, d.description || d.type || d.id);
	});
	const finish = (data: unknown) => {
		const d = data as { id?: string } | undefined;
		const a = d?.id ? agents.get(d.id) : undefined;
		if (!a) return;
		a.off?.();
		a.model.done(Date.now());
		agents.delete(d!.id!);
		episodes.delete(d!.id!);
		publish();
	};
	pi.events.on("subagents:completed", finish);
	pi.events.on("subagents:failed", finish);

	pi.on("session_start", (_event, ctx) => {
		dead = false;
		ctxRef = ctx;
		primary.settled(Date.now());
		publish();
	});
	pi.events.on("statusbar:ready", () => publish());
	pi.on("session_shutdown", () => {
		dead = true;
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = undefined;
		for (const a of agents.values()) a.off?.();
	});

	pi.registerCommand("stuck", {
		description: "Is anything stuck? Every agent's phase, how long since progress, and what that wait usually takes",
		handler: async (_args, ctx) => {
			if (dead) return;
			const now = Date.now();
			const v = primary.verdict(now);
			const lines = [`this session: ${v.level} · ${v.summary}`, ...v.evidence.map((e) => `  ${e}`)];
			for (const [, a] of agents) {
				const av = a.model.verdict(now);
				lines.push(`${a.name}: ${av.level} · ${av.summary}`, ...av.evidence.map((e) => `  ${e}`));
			}
			if (!agents.size) lines.push("no subagents running");
			lines.push("stalled = past twice the worst of a hundred normal waits · steer: @name … · stop: x in the agent list · /argo check if an Argo model answers nothing");
			const worst = [v, ...[...agents.values()].map((a) => a.model.verdict(now))].some((x) => x.level === "stalled" || x.level === "looping");
			ctx.ui.notify(lines.join("\n"), worst ? "warning" : "info");
		},
	});
}
