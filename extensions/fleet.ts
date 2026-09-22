/**
 * fleet — one interactive surface for subagents, replacing pi-subagents' two.
 *
 *   ● Agents · 2 running · 1 queued                                    ↓ select · enter view
 *   ├─ ● M7-08 hitscan finish t2   9 tools · 31.7k (10%) · 14 t/s · 202s
 *   │    thinking…
 *   └─ ○ M7-03 playerstates t2     14 tools · 37.0k (13%) · 202s · ↗ ALCF Minerva
 *        Plan read. First action: stub + commit as instructed.
 *
 * Keys (only while the prompt is empty, so typing is never disturbed):
 *   ↓ / ←   enter the list        ↑ / ↓  move        esc  back to the prompt
 *   enter   ATTACH to that agent  s  steer it        m  move its endpoint
 * Attached: the transcript pane shows that agent's conversation (statusbar.ts swaps the pane), the
 * column reports its numbers, typing steers it, and esc detaches. /attach [agent] does the same.
 *
 * Data comes from pi-subagents' lifecycle events plus `getRecord(id)` from its
 * `Symbol.for("pi-subagents:manager")` registry: tokens, tool uses, context %, the model in use,
 * and the agent's own AgentSession (public `sessionManager` for the transcript, `steer()` for
 * steering, `subscribe()` for live updates). Only top-level agents are visible — the package hides
 * an agent's own children from every top-level surface, so a nested tree is not available yet.
 *
 * Turn pi-subagents' surfaces off to avoid three lists: "widgetMode": "off" and "fleetView": false
 * in ~/.pi/agent/subagents.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, Markdown, matchesKey, ScrollView, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "fleet";
const TICK_MS = 500; // elapsed times and token counts move while the main session is idle
const SPEED_WINDOW_MS = Number(process.env.PI_SPEED_WINDOW_MS ?? 10_000);
const FINISHED_LINGER_MS = 20_000;
const MAX_PANE_MESSAGES = 120; // tail of the attached agent's transcript that gets rendered
const MAX_TURN_SCAN = 400; // messages scanned for the turn count / activity line
const LIVE_TTL_MS = 400; // how long one agent's stats are reused across renders

type Tracked = {
	id: string;
	type: string;
	description: string;
	status: string;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	samples: { t: number; out: number }[];
};

type Live = {
	status: string;
	turns: number;
	tokens: number;
	output: number;
	toolUses: number;
	contextPercent: number | null;
	modelId?: string;
	activity?: string;
	session?: any;
};

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
const secs = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};
const oneLine = (s: string, limit: number) => truncateToWidth(s.replace(/\s+/g, " ").trim(), limit, "…");

function record(id: string): any {
	const registry = (globalThis as Record<symbol, { getRecord?: (id: string) => any }>)[Symbol.for("pi-subagents:manager")];
	try {
		return registry?.getRecord?.(id);
	} catch {
		return undefined;
	}
}

/**
 * Everything about one agent, cached briefly. Each lookup walks the agent's session
 * (getSessionStats and the transcript scan); the list renders many times a second while the main
 * session streams, and doing that per row per frame exhausted the heap.
 */
const liveCache = new Map<string, { at: number; value: Live | undefined }>();
function live(id: string): Live | undefined {
	const hit = liveCache.get(id);
	if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.value;
	const value = readLive(id);
	liveCache.set(id, { at: Date.now(), value });
	return value;
}

function readLive(id: string): Live | undefined {
	const r = record(id);
	if (!r) return undefined;
	const u = r.lifetimeUsage ?? {};
	let contextPercent: number | null = null;
	try {
		contextPercent = r.session?.getSessionStats?.().contextUsage?.percent ?? null;
	} catch {}
	const { turns, activity } = readSession(id, r.session);
	return {
		status: r.status ?? "running",
		turns,
		tokens: (u.input ?? 0) + (u.output ?? 0) + (u.cacheWrite ?? 0),
		output: u.output ?? 0,
		toolUses: r.toolUses ?? 0,
		contextPercent,
		modelId: r.invocation?.modelId,
		activity,
		session: r.session,
	};
}

/**
 * Turn count and current activity, read from the agent's own transcript: pi-subagents' registry
 * exposes neither (its widget gets them from an internal tracker). Cached briefly — the list
 * re-renders twice a second and an agent's branch can be long.
 */
function readSession(id: string, session: any): { turns: number; activity?: string } {
	let turns = 0;
	let activity: string | undefined;
	try {
		const branch = session?.sessionManager?.getBranch?.() ?? [];
		for (const e of branch.slice(-MAX_TURN_SCAN)) {
			const m = (e as { type?: string; message?: any }).message;
			if (e.type !== "message" || m?.role !== "assistant") continue;
			turns++;
			const calls = (m.content ?? []).filter((c: any) => c.type === "toolCall").map((c: any) => c.name);
			const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
			activity = calls.length ? `→ ${calls.join(", ")}` : text.trim() || activity;
		}
	} catch {}
	return { turns, activity };
}

/**
 * The attached agent's transcript: assistant text through pi's Markdown renderer, tool calls and
 * results as compact rows. Rebuilt only when the transcript or the width actually changes — this
 * renders on every frame while an agent streams.
 */
let paneCache: { key: string; rows: string[] } | undefined;
function attachedRows(session: any, width: number, theme: Theme): string[] {
	// Only the tail: a long-running agent's branch can hold thousands of messages, and this rebuilds
	// whenever it streams. MAX_PANE_MESSAGES keeps that bounded.
	const all = session?.sessionManager?.getBranch?.() ?? [];
	const entries = all.slice(-MAX_PANE_MESSAGES);
	const lastMessage = entries[entries.length - 1] as { message?: any } | undefined;
	const key = `${entries.length}:${width}:${JSON.stringify(lastMessage?.message?.content ?? "").length}`;
	if (paneCache?.key === key) return paneCache.rows;
	const rows: string[] = [];
	const mdTheme = getMarkdownTheme();
	for (const e of entries) {
		const m = (e as { type?: string; message?: any }).message;
		if (e.type !== "message" || !m) continue;
		if (m.role === "user" || m.role === "custom") {
			const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join(" ");
			if (!text.trim()) continue;
			rows.push("");
			for (const line of wrap(text.trim(), width - 4)) rows.push(truncateToWidth(theme.fg("userMessageText", `▌ ${line}`), width, "…"));
			continue;
		}
		if (m.role === "assistant") {
			const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
			if (text.trim()) {
				rows.push("");
				rows.push(...new Markdown(text.trim(), 1, 0, mdTheme).render(width - 2));
			}
			for (const call of (m.content ?? []).filter((c: any) => c.type === "toolCall")) {
				rows.push(
					truncateToWidth(
						theme.fg("toolTitle", `  → ${call.name}`) + theme.fg("dim", ` ${oneLine(JSON.stringify(call.arguments ?? {}), Math.max(10, width - 20))}`),
						width,
						"…",
					),
				);
			}
			continue;
		}
		if (m.role === "toolResult") {
			const text = (m.content ?? []).map((c: any) => (c.type === "text" ? c.text : "[image]")).join("\n").trim();
			if (!text) continue;
			const lines = text.split("\n");
			rows.push(truncateToWidth(theme.fg("dim", `  ⎿ ${oneLine(lines[0], Math.max(10, width - 8))}${lines.length > 1 ? `  (+${lines.length - 1} lines)` : ""}`), width, "…"));
		}
	}
	if (all.length > entries.length) rows.unshift(theme.fg("dim", `  … ${all.length - entries.length} earlier messages not shown`), "");
	if (!rows.length) rows.push(theme.fg("dim", "  (nothing yet)"));
	paneCache = { key, rows };
	return rows;
}


function wrap(text: string, width: number): string[] {
	if (width < 10) return [text];
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const word of paragraph.split(" ")) {
			if (visibleWidth(line) + visibleWidth(word) + 1 > width) {
				out.push(line);
				line = word;
			} else line = line ? `${line} ${word}` : word;
		}
		out.push(line);
	}
	return out.length ? out : [""];
}

/**
 * pi-subagents' own widget and fleet list must be off, or two lists fight over ↓ and the first
 * keypress goes to theirs. Its /agents → Settings writes <cwd>/.pi/subagents.json, which overrides
 * ~/.pi/agent/subagents.json — so a project can silently switch them back on.
 */
function subagentSurfaces(cwd: string): { on: boolean; projectFile: string } {
	const read = (file: string) => {
		try {
			return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			return {};
		}
	};
	const projectFile = join(cwd, ".pi", "subagents.json");
	const merged = { ...read(join(homedir(), ".pi", "agent", "subagents.json")), ...read(projectFile) };
	return { on: merged.widgetMode !== "off" || merged.fleetView !== false, projectFile };
}

export default function (pi: ExtensionAPI): void {
	const agents = new Map<string, Tracked>();
	/**
	 * Every agent this session has ever run, id → its token total. The roster forgets an agent
	 * 20s after it finishes, so summing the roster would make a cumulative figure go *down*.
	 */
	const tokensById = new Map<string, number>();
	let ctxRef: ExtensionContext | undefined;
	let tuiRef: TUI | undefined;
	let selectedId: string | undefined; // undefined = list not focused; an id survives list changes
	let attachedId: string | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	const rerender = () => tuiRef?.requestRender();

	/**
	 * After `/reload` the captured ctx is dead and every getter on it throws. A throw from a render
	 * happens inside Pi's layout pass, where it is an uncaughtException that takes the session with
	 * it — so read the session's model defensively and simply omit the "↗ endpoint" mark if it is
	 * not available any more.
	 */
	const sessionModelId = (): string | undefined => {
		try {
			const m = ctxRef?.model;
			return m ? `${m.provider}/${m.id}` : undefined;
		} catch {
			return undefined;
		}
	};
	const agentOf = (id: string | undefined) => (id ? agents.get(id) : undefined);

	/**
	 * Attach: the transcript pane becomes this agent's conversation, the column reports its numbers,
	 * and typing steers it. statusbar.ts owns the layout, so the pane is handed over on the bus.
	 */
	function attach(ctx: ExtensionContext, agent: Tracked): void {
		attachedId = agent.id;
		selectedId = undefined;
		paneCache = undefined;
		const content: Component = {
			invalidate() {},
			render(width: number): string[] {
				return attachedRows(live(agent.id)?.session, width, ctx.ui.theme);
			},
		};
		const pane = new ScrollView(content, { follow: "end", primary: true }); // pi's own scroll keys drive it
		emit("statusbar:transcript", { component: pane });
		emit("statusbar:attached", {
			name: agent.description || agent.type,
			stats: () => {
				const info = live(agent.id);
				return {
					status: info?.status ?? agent.status,
					modelId: endpointOverrides.get(agent.id) ?? info?.modelId,
					contextPercent: info?.contextPercent ?? null,
					tokens: info?.tokens ?? 0,
					output: info?.output ?? 0,
					turns: info?.turns ?? 0,
					rate: info ? rate(agent, info.output) : undefined,
					elapsedMs: (agent.endedAt ?? Date.now()) - agent.startedAt,
				};
			},
		});
		ctx.ui.notify(`Attached to "${oneLine(agent.description || agent.type, 40)}" — typing steers it, esc detaches.`, "info");
		rerender();
	}

	function detach(): void {
		if (!attachedId) return;
		attachedId = undefined;
		paneCache = undefined;
		emit("statusbar:transcript", {});
		emit("statusbar:attached", {});
		rerender();
	}
	const roster = () =>
		[...agents.values()]
			.filter((a) => !a.endedAt || Date.now() - a.endedAt < FINISHED_LINGER_MS)
			.sort((a, b) => a.startedAt - b.startedAt);

	const track = (status: string) => (data: unknown) => {
		const d = data as { id?: string; type?: string; description?: string; status?: string; durationMs?: number; tokens?: { output?: number } };
		if (!d?.id) return;
		const prev = agents.get(d.id);
		const ended = status !== "queued" && status !== "running";
		// :started arrives before :created for background spawns, so never downgrade running → queued
		const next = ended ? d.status || status : status === "queued" && prev?.status === "running" ? "running" : status;
		agents.set(d.id, {
			id: d.id,
			type: d.type ?? prev?.type ?? "agent",
			description: d.description ?? prev?.description ?? "",
			status: next,
			startedAt: status === "running" && prev?.status !== "running" ? Date.now() : (prev?.startedAt ?? Date.now()),
			endedAt: ended ? Date.now() : undefined,
			durationMs: d.durationMs,
			samples: prev?.samples ?? [],
		});
		ensureTicker();
		publishSlot();
		rerender();
	};
	for (const [event, status] of [
		["subagents:created", "queued"],
		["subagents:started", "running"],
		["subagents:completed", "completed"],
		["subagents:failed", "failed"],
	] as const) {
		pi.events.on(event, track(status));
	}

	function ensureTicker(): void {
		const active = !dead && roster().length > 0;
		if (active && !ticker)
			ticker = setInterval(() => {
				if (dead) {
					clearInterval(ticker);
					ticker = undefined;
					return;
				}
				publishSlot();
				rerender();
				// Only render() re-checks the roster, and a session without UI never renders: without
				// this the ticker kept emitting a slot every 500ms after the last agent aged out.
				if (!roster().length) {
					clearInterval(ticker);
					ticker = undefined;
				}
			}, TICK_MS);
		if (!active && ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	}

	function rate(a: Tracked, out: number): number | undefined {
		const now = Date.now();
		const last = a.samples[a.samples.length - 1];
		if (!last || now - last.t > 250) a.samples.push({ t: now, out });
		while (a.samples.length > 2 && a.samples[0].t < now - SPEED_WINDOW_MS) a.samples.shift();
		const first = a.samples[0];
		const latest = a.samples[a.samples.length - 1];
		const span = (latest.t - first.t) / 1000;
		return span >= 1 && latest.out > first.out ? (latest.out - first.out) / span : undefined;
	}

	/** Two lines per agent: the stats row, then whatever it is doing right now. */
	function rows(theme: Theme, width: number): string[] {
		const list = roster();
		if (!list.length) return [];
		const running = list.filter((a) => (live(a.id)?.status ?? a.status) === "running").length;
		const queued = list.filter((a) => (live(a.id)?.status ?? a.status) === "queued").length;
		const done = list.length - running - queued;
		const head =
			theme.fg("accent", "● Agents") +
			theme.fg("dim", ` · ${[running && `${running} running`, queued && `${queued} queued`, done && `${done} done`].filter(Boolean).join(" · ")}`);
		const hint = theme.fg("dim", selectedId === undefined ? "↓ select" : "↑↓ move · enter view · s steer · m move · esc back");
		const fit = (line: string) => truncateToWidth(line, width, "…");
		const out = [fit(head + " ".repeat(Math.max(1, width - visibleWidth(head) - visibleWidth(hint))) + hint)];

		list.forEach((a, i) => {
			const info = live(a.id);
			const state = info?.status ?? a.status;
			const finished = Boolean(a.endedAt);
			const isSelected = selectedId === a.id;
			const branch = theme.fg("dim", i === list.length - 1 ? "└─" : "├─");
			const glyph = finished
				? theme.fg(state === "completed" ? "success" : "error", state === "completed" ? "✓" : "✗")
				: theme.fg("accent", state === "running" ? (isSelected ? "●" : "○") : "◌");
			const name = a.description || a.type;
			const speed = info && !finished ? rate(a, info.output) : undefined;
			const stats = [
				info?.turns ? `↻${info.turns}` : undefined,
				info?.toolUses ? `${info.toolUses} tools` : undefined,
				info?.tokens ? `${fmt(info.tokens)}${info.contextPercent != null ? ` (${Math.round(info.contextPercent)}%)` : ""}` : undefined,
				speed !== undefined ? `${Math.round(speed)} t/s` : undefined,
				finished ? secs(a.durationMs ?? (a.endedAt ?? 0) - a.startedAt) : secs(Date.now() - a.startedAt),
				(() => {
					const on = endpointOverrides.get(a.id) ?? info?.modelId;
					return on && on !== sessionModelId() ? `↗ ${endpointLabel(on)}` : undefined;
				})(),
			].filter(Boolean);
			const label = isSelected ? theme.fg("text", name) : theme.fg(finished ? "dim" : "muted", name);
			const kind = theme.fg("dim", a.type);
			out.push(fit(`${branch} ${glyph} ${kind} ${label}  ${theme.fg("dim", stats.join(" · "))}`));
			const activity = finished ? undefined : oneLine(info?.activity || "thinking…", Math.max(20, width - 8));
			if (activity) out.push(fit(`${theme.fg("dim", i === list.length - 1 ? "     ⎿ " : "│    ⎿ ")}${theme.fg("dim", activity)}`));
		});
		return out;
	}

	const endpointLabels = new Map<string, string>();
	pi.events.on("statusbar:endpoint-labels", (data) => {
		for (const [provider, label] of Object.entries((data ?? {}) as Record<string, string>)) endpointLabels.set(provider, label);
	});
	const endpointLabel = (modelId: string): string => {
		const provider = modelId.split("/")[0];
		return endpointLabels.get(provider) ?? provider;
	};

	/** Sidebar/dashboard still read agents through statusbar's slot protocol. */
	function publishSlot(): void {
		const list = roster();
		const running = list.filter((a) => (live(a.id)?.status ?? a.status) === "running").length;
		const queued = list.filter((a) => (live(a.id)?.status ?? a.status) === "queued").length;
		// refresh the ledger for agents still tracked; finished ones keep their last known figure
		for (const a of list) {
			const t = live(a.id)?.tokens;
			if (t) tokensById.set(a.id, t);
		}
		let agentTokens = 0;
		for (const t of tokensById.values()) agentTokens += t;
		emit("statusbar:slot", {
			id: "agents",
			order: 3,
			tokens: agentTokens,
			text: running || queued ? `agents ${running}${queued ? ` +${queued} queued` : ""}` : "agents –",
			state: running || queued ? "busy" : "idle",
			statusKey: "subagents",
			details: () =>
				list.length
					? list.map((a) => {
							const info = live(a.id);
							const bits = [
								info?.tokens ? fmt(info.tokens) : undefined,
								info?.contextPercent != null ? `${Math.round(info.contextPercent)}%` : undefined,
								a.endedAt ? secs(a.durationMs ?? 0) : secs(Date.now() - a.startedAt),
							].filter(Boolean);
							return `${a.endedAt ? "✓" : "●"} ${oneLine(a.description || a.type, 28)} · ${bits.join(" · ")}`;
						})
					: ["none running"],
		});
	}

	/** Agents moved with /agent-model: pi-subagents' invocation keeps the spawn-time model. */
	const endpointOverrides = new Map<string, string>();

	/**
	 * `/reload` replaces the activation, and from that moment `pi.events.emit` throws
	 * ("extension ctx is stale"). That is survivable from a render — it is not survivable from a
	 * timer, where the throw is an uncaughtException that kills pi. The 500ms ticker below did
	 * exactly that. So: stop the clock on shutdown, and treat every emit as dead-checked.
	 */
	let dead = false;

	function emit(event: string, payload: unknown): void {
		if (dead) return;
		try {
			pi.events.emit(event, payload);
		} catch {
			dead = true; // the activation went away between the check and the call
		}
	}

	/** >0 while Pi is showing a blocking dialog (select/confirm/input/editor/custom). */
	let promptDepth = 0;
	pi.on("ui_prompt_start", () => {
		promptDepth++;
	});
	pi.on("ui_prompt_end", () => {
		promptDepth = Math.max(0, promptDepth - 1);
	});

	/**
	 * >0 while another extension is doing slow work before it can show its dialog, and wants the
	 * keyboard reserved for it — `/endpoints` probes four clusters for ~10s before its picker opens.
	 * Pi has no command-start event, so a command that keeps the user waiting says so itself:
	 *
	 *     pi.events.emit("fleet:keys-hold", {});   // …await the slow part…
	 *     pi.events.emit("fleet:keys-release", {});
	 *
	 * Without this, a ↓ pressed while waiting silently focuses the agent list instead, and the
	 * arrows that should have moved the picker have already been eaten by the time it appears.
	 */
	let keysHeld = 0;
	pi.events.on("fleet:keys-hold", () => {
		keysHeld++;
	});
	pi.events.on("fleet:keys-release", () => {
		keysHeld = Math.max(0, keysHeld - 1);
	});

	pi.registerCommand("agent-model", {
		description: "Move a running subagent to another endpoint: /agent-model [agent] [provider/model]",
		handler: async (args, ctx) => {
			const [who, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			// NB: not `live` — that is the module-level record lookup, and shadowing it here made the
			// filter below reference its own binding before initialization.
			const movable = roster().filter((a) => {
				const state = live(a.id)?.status ?? a.status;
				return state === "running" || state === "queued";
			});
			if (!movable.length) return ctx.ui.notify("No subagent is running.", "info");

			const name = (a: Tracked) => a.description || a.type;
			const nowOn = (a: Tracked) => endpointOverrides.get(a.id) ?? live(a.id)?.modelId;
			let target = who ? movable.find((a) => a.id.startsWith(who) || name(a).toLowerCase().includes(who.toLowerCase())) : undefined;
			if (!target && movable.length > 1) {
				// one row per agent: what it is doing, where it runs now, and how far along it is
				const labels = movable.map((a) => {
					const info = live(a.id);
					const on = nowOn(a);
					const where = on ? endpointLabel(on) : "inherited";
					const size = info?.tokens ? ` · ${fmt(info.tokens)} tok` : "";
					return `${truncateToWidth(name(a), 34, "…").padEnd(34)}  ${where}${size} · ${secs(Date.now() - a.startedAt)}`;
				});
				const choice = await ctx.ui.select("Move which agent?", labels);
				target = choice ? movable[labels.indexOf(choice)] : undefined;
			}
			target ??= movable[0];
			if (!target) return;

			const models = ctx.modelRegistry.getAvailable();
			const wanted = rest.join(" ");
			let model = wanted
				? models.find((m) => `${m.provider}/${m.id}` === wanted) ?? models.find((m) => m.id === wanted || m.provider === wanted)
				: undefined;
			if (!model) {
				const current = nowOn(target);
				// one row per endpoint+model: where it runs, its context window, and what is in use now
				const labels = models.map((m) => {
					const id = `${m.provider}/${m.id}`;
					const mark = id === current ? "  ◀ on this now" : id === `${ctx.model?.provider}/${ctx.model?.id}` ? "  ← this session" : "";
					return `${truncateToWidth(m.id, 30, "…").padEnd(30)}  ${endpointLabel(`${m.provider}/x`).padEnd(16)} ${fmt(m.contextWindow ?? 0).padStart(5)} ctx${mark}`;
				});
				const choice = await ctx.ui.select(`Move "${truncateToWidth(name(target), 40, "…")}" to`, labels);
				model = choice ? models[labels.indexOf(choice)] : undefined;
			}
			if (!model) return;

			const session = live(target.id)?.session;
			if (typeof session?.setModel !== "function") {
				return ctx.ui.notify("That agent has no live session to move (finished, or not started yet).", "warning");
			}
			try {
				await session.setModel(model); // session-only, same call /model makes for the main session
				endpointOverrides.set(target.id, `${model.provider}/${model.id}`);
				target.samples = []; // its tok/s belongs to the old endpoint
				ctx.ui.notify(
					`${name(target)} → ${model.id} @ ${endpointLabel(`${model.provider}/x`)} · takes effect on its next turn; its prompt cache starts cold there`,
					"info",
				);
				rerender();
			} catch (e) {
				ctx.ui.notify(`Could not move that agent: ${(e as Error).message}`, "error");
			}
		},
	});

	/** While attached, what you type steers that agent instead of the main session. */
	pi.on("input", async (event, ctx) => {
		if (!attachedId || event.source !== "interactive") return undefined;
		const agent = agentOf(attachedId);
		const text = event.text.trim();
		if (!agent || !text) return { action: "handled" as const };
		const session = live(agent.id)?.session;
		if (typeof session?.steer !== "function") {
			ctx.ui.notify("That agent has finished — esc to detach.", "warning");
			return { action: "handled" as const };
		}
		try {
			await session.steer(text);
			ctx.ui.notify("Sent to the agent.", "info");
		} catch (e) {
			ctx.ui.notify(`Could not steer: ${(e as Error).message}`, "error");
		}
		return { action: "handled" as const };
	});

	pi.registerCommand("attach", {
		description: "Attach the session view to a subagent: /attach [agent]; /attach main detaches",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "main" || arg === "off") return detach();
			const list = roster();
			if (!list.length) return ctx.ui.notify("No subagent is running.", "info");
			const named = arg
				? list.find((a) => a.id.startsWith(arg) || (a.description || a.type).toLowerCase().includes(arg.toLowerCase()))
				: undefined;
			const target = named ?? (list.length === 1 ? list[0] : undefined);
			if (target) return attach(ctx, target);
			const labels = list.map((a) => `${oneLine(a.description || a.type, 40).padEnd(42)} ${a.endedAt ? "finished" : "running"}`);
			const choice = await ctx.ui.select("Attach to which agent?", labels);
			if (choice) attach(ctx, list[labels.indexOf(choice)]);
		},
	});

	pi.registerCommand("fleet", {
		description: "Fleet list status; /fleet takeover turns pi-subagents' own widget and list off for this project",
		handler: async (args, ctx) => {
			const { on, projectFile } = subagentSurfaces(ctx.cwd);
			if (args.trim() !== "takeover") {
				return ctx.ui.notify(
					on
						? `pi-subagents' own panels are ON here (${projectFile}) — two lists will fight over ↓. Fix: /fleet takeover, or /agents → Settings.`
						: "fleet list is the only agent surface here.",
					on ? "warning" : "info",
				);
			}
			try {
				let current: Record<string, unknown> = {};
				try {
					current = JSON.parse(readFileSync(projectFile, "utf8"));
				} catch {}
				writeFileSync(projectFile, `${JSON.stringify({ ...current, widgetMode: "off", fleetView: false }, null, 2)}\n`);
				ctx.ui.notify(`Turned pi-subagents' widget and fleet list off in ${projectFile}. Restart pi to apply.`, "info");
			} catch (e) {
				ctx.ui.notify(`Could not write ${projectFile}: ${(e as Error).message}`, "error");
			}
		},
	});

	// Stop the clock before the activation is replaced. A ticker that outlives it emits into a dead
	// pi, and a throw from a timer is an uncaughtException — it takes the whole session down.
	pi.on("session_shutdown", () => {
		dead = true;
		if (ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
		liveCache.clear();
	});

	pi.on("session_start", (_event, ctx) => {
		dead = false;
		ctxRef = ctx;
		if (!ctx.hasUI) return;
		const surfaces = subagentSurfaces(ctx.cwd);
		if (surfaces.on) {
			ctx.ui.notify("pi-subagents' own agent panels are on in this project — ↓ will go to their list. Run /fleet takeover.", "warning");
		}

		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				tuiRef = tui;
				return {
					invalidate() {},
					render(width: number): string[] {
						ensureTicker();
						const list = roster();
						if (selectedId && !list.some((a) => a.id === selectedId)) selectedId = list[list.length - 1]?.id; // its agent dropped out
						return rows(theme, width);
					},
				} as Component;
			},
			{ placement: "belowEditor" },
		);

		// keys only when the prompt is empty, so ordinary typing is untouched
		ctx.ui.onTerminalInput((data) => {
			// A dialog on screen owns the keyboard. Without this, escape closing the /status
			// dashboard also detached from the attached agent (two escapes to get out of one
			// popup), and the arrow keys moved this list underneath an open picker.
			if (promptDepth > 0 || keysHeld > 0) return undefined;
			// With the Kitty keyboard protocol (iTerm2 and friends) one press also delivers a release;
			// acting on both moved the selection twice, which read as "skips the first agent".
			if (isKeyRelease(data)) return undefined;
			if (ctx.ui.getEditorText() !== "") return undefined;
			if (attachedId) {
				if (!matchesKey(data, "escape")) return undefined;
				detach();
				return { consume: true };
			}
			const list = roster();
			if (!list.length) return undefined;
			const index = selectedId ? list.findIndex((a) => a.id === selectedId) : -1;
			if (index < 0) {
				if (matchesKey(data, "down") || matchesKey(data, "left")) {
					// start on the first agent still working, else the first row
					selectedId = (list.find((a) => !a.endedAt) ?? list[0]).id;
					rerender();
					return { consume: true };
				}
				return undefined;
			}
			if (matchesKey(data, "down")) selectedId = list[Math.min(list.length - 1, index + 1)].id;
			else if (matchesKey(data, "up")) selectedId = index === 0 ? undefined : list[index - 1].id;
			else if (matchesKey(data, "escape")) selectedId = undefined;
			else if (matchesKey(data, "enter")) attach(ctx, list[index]);
						else if (data === "s") {
				const agent = list[index];
				// pi has no unhandledRejection handler, so a promise nobody catches is a process exit
				void ctx.ui
					.input(`Steer "${oneLine(agent.description || agent.type, 40)}"`, "message for the agent")
					.then(async (text) => {
						const session = live(agent.id)?.session;
						if (!text) return;
						if (typeof session?.steer !== "function") return ctx.ui.notify("That agent is no longer running.", "warning");
						await session.steer(text);
						if (dead) return; // the activation can go while steer() is in flight
						ctx.ui.notify("Steering message delivered.", "info");
					})
					.catch((error) => {
						if (dead) return;
						try {
							ctx.ui.notify(`Could not steer: ${error instanceof Error ? error.message : String(error)}`, "error");
						} catch {
							// stale between the rejection and here
						}
					});
			} else if (data === "m") pi.sendUserMessage(`/agent-model ${list[index].id}`, { expandPromptTemplates: true });
			else return undefined;
			rerender();
			return { consume: true };
		});
	});
}
