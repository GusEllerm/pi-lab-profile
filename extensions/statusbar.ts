/**
 * statusbar — a fixed-layout footer plus one status dashboard.
 *
 *   ~/Projects/doom (main)                         qwen3.8-flash-next · thinking medium · ctx 16.5% of 262k
 *   ⇄ globus3 ✓           agents 3 ●         images 3/6 ⚠        in 82M · out 300k · cache 96%
 *
 * Wide fullscreen terminals (≥ 120 columns) get a right-hand sidebar beside the transcript instead,
 * and the footer shrinks to the path. /sidebar off|on toggles it.
 *
 * Every slot is always in the same column; an idle slot is dimmed ("agents –"), never removed.
 * Colour encodes state only: ✓ ok · ⚠ warning · ✗ problem · ● busy.
 * /status opens a dashboard with every section; inside it, e runs /endpoints and a runs /agents.
 * Nothing opens on a click: the footer and sidebar are read-only.
 *
 * Why a whole footer: Pi prints every extension's setStatus() text on one line, sorted by key,
 * joined by a single space and truncated, so statuses run into each other and the last ones fall off.
 *
 * Slot data:
 *  - endpoint, images: published by endpoints.ts and image-window.ts over the event bus,
 *      pi.events.emit("statusbar:slot", { id, text, state?, statusKey?, details?: () => string[] })
 *    The bar emits "statusbar:ready" at session start so they (re)publish regardless of load order.
 *  - agents: published by fleet.ts as a slot (it owns the agent list and its live detail).
 *  - usage: this session branch's assistant-message usage and ctx.getContextUsage().
 *  - speed: output tokens/s over a sliding SPEED_WINDOW_MS (10 s) of the reply being streamed,
 *    sampled per message_update. Restarts each reply, so a pause for tool execution is not averaged
 *    in as slow generation. Idle shows the last reply's average. Providers that report usage.output
 *    while streaming (vLLM on globus) give exact counts; ones that don't (the ALCF gateway sends the
 *    whole reply at once) fall back to a chars/4 estimate, marked "~". Main session only — subagents
 *    stream in their own sessions.
 *  - any other extension's setStatus() text: an "OTHER" dashboard section, flagged "+N" in the footer.
 *
 * How the sidebar gets there — relies on Pi internals, checked before use: in fullscreen mode Pi's
 * layout root is VStack[ScrollView transcript, dock] (pi-coding-agent chat-viewport.js), held in the
 * viewport's private `layoutRoot`. We rebuild it as VStack[HStack[transcript, sidebar], dock]. If the
 * root is not that shape (a Pi update changed it) nothing is touched and the footer stays as it was.
 * setLayoutRoot is wrapped so the sidebar re-attaches whenever Pi installs a fresh root.
 */
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	HStack,
	isViewportTUI,
	matchesKey,
	ScrollView,
	type TUI,
	truncateToWidth,
	type TuiMouseEvent,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";

// The sidebar narrows with the terminal rather than vanishing; it only goes away when even a
// narrow column would leave the transcript too cramped. Override with PI_SIDEBAR_MIN_COLUMNS /
// PI_SIDEBAR_WIDTH, or at runtime with /sidebar <columns> | auto | min <columns>.
const SIDEBAR_MIN_COLUMNS = Number(process.env.PI_SIDEBAR_MIN_COLUMNS ?? 72);
const SIDEBAR_FIXED_WIDTH = Number(process.env.PI_SIDEBAR_WIDTH ?? 0); // 0 = pick from terminal width
const SIDEBAR_COMPACT_BELOW = 30; // narrower than this, label and value stack instead of sharing a row
const SPEED_WINDOW_MS = Number(process.env.PI_SPEED_WINDOW_MS ?? 10_000);

export type SlotState = "ok" | "warn" | "error" | "busy" | "idle" | "plain";

/** What the column shows instead of the session's own numbers while attached to a subagent. */
export interface AttachedStats {
	status: string;
	modelId?: string;
	contextPercent: number | null;
	tokens: number;
	output: number;
	turns: number;
	rate?: number;
	elapsedMs: number;
}

export interface Slot {
	id: string;
	text: string;
	state?: SlotState;
	/** setStatus() key this slot stands in for; its raw text is not repeated under OTHER. */
	statusKey?: string;
	details?: () => string[];
}

type Color = Parameters<Theme["fg"]>[0];
const MARK: Partial<Record<SlotState, [string, Color]>> = {
	ok: ["✓", "success"],
	warn: ["⚠", "warning"],
	error: ["✗", "error"],
	busy: ["●", "accent"],
};

function sidebarWidthFor(termWidth: number, override: number): number {
	if (override > 0) return Math.min(override, Math.max(16, termWidth - 40));
	if (termWidth >= 150) return 36;
	if (termWidth >= 120) return 32;
	if (termWidth >= 96) return 28;
	return 24;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");
const fmt = (n: number) =>
	n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : `${n}`;
const secs = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};

// ── usage: summed once per assistant message, not on every render ─────────────────────────────
type Usage = { prompt: number; cacheRead: number; output: number; calls: number; cost: number };
function sumUsage(ctx: ExtensionContext): Usage {
	const u: Usage = { prompt: 0, cacheRead: 0, output: 0, calls: 0, cost: 0 };
	for (const e of ctx.sessionManager.getBranch()) {
		const m = (e as { type: string; message?: any }).message;
		if (e.type !== "message" || m?.role !== "assistant" || !m.usage) continue;
		u.calls++;
		u.prompt += (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
		u.cacheRead += m.usage.cacheRead ?? 0;
		u.output += m.usage.output ?? 0;
		u.cost += m.usage.cost?.total ?? 0;
	}
	return u;
}

// ── generation speed ──────────────────────────────────────────────────────────────────────────
type Speed = {
	live?: number; // tokens/s over the window, while streaming
	last?: number; // average tokens/s of the previous reply
	ttftMs?: number; // time to first token of the previous reply
	sessionAvg?: number;
	estimated: boolean; // true when counts came from a chars/4 estimate
	/** The whole reply landed at once (a gateway buffered it): that is delivery speed, not generation. */
	buffered: boolean;
	streaming: boolean;
};

class SpeedMeter {
	private samples: { t: number; tokens: number }[] = [];
	private streamStart = 0;
	private firstTokenAt?: number;
	private estimated = false;
	private streaming = false;
	private last?: { rate: number; ttftMs?: number; buffered: boolean };
	private sessionTokens = 0;
	private sessionMs = 0;

	start(): void {
		this.samples = [];
		this.streaming = true;
		this.estimated = false;
		this.streamStart = Date.now();
		this.firstTokenAt = undefined;
	}

	update(message: { usage?: { output?: number }; content?: { text?: string; thinking?: string }[] }): void {
		if (!this.streaming) this.start();
		const reported = message.usage?.output ?? 0;
		const chars = (message.content ?? []).reduce((n, c) => n + (c.text?.length ?? 0) + (c.thinking?.length ?? 0), 0);
		// thinking counts as generated tokens: it is what the GPU is producing
		const tokens = reported > 0 ? reported : Math.round(chars / 4);
		this.estimated = reported === 0 && chars > 0;
		const now = Date.now();
		if (tokens > 0 && this.firstTokenAt === undefined) this.firstTokenAt = now;
		this.samples.push({ t: now, tokens });
		const cutoff = now - SPEED_WINDOW_MS;
		while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
	}

	end(message: { usage?: { output?: number } }): void {
		const now = Date.now();
		const tokens = message.usage?.output ?? 0;
		const sampleSpanMs = this.samples.length > 1 ? this.samples[this.samples.length - 1].t - this.samples[0].t : 0;
		const tokensPerSample = tokens / Math.max(1, this.samples.length);
		const from = this.firstTokenAt ?? this.streamStart;
		const ms = now - from;
		if (tokens > 0 && ms > 200) {
			this.last = {
				rate: (tokens / ms) * 1000,
				ttftMs: this.firstTokenAt ? this.firstTokenAt - this.streamStart : undefined,
				// a real stream trickles in over many updates; a gateway that buffers hands it over at once
				buffered: tokens > 50 && (sampleSpanMs < 1500 || tokensPerSample > 25),
			};
			this.sessionTokens += tokens;
			this.sessionMs += ms;
		}
		this.streaming = false;
		this.samples = [];
	}

	read(): Speed {
		const first = this.samples[0];
		const latest = this.samples[this.samples.length - 1];
		const span = first && latest ? (latest.t - first.t) / 1000 : 0;
		return {
			live: this.streaming && span >= 0.5 ? (latest.tokens - first.tokens) / span : undefined,
			last: this.last?.rate,
			ttftMs: this.last?.ttftMs,
			sessionAvg: this.sessionMs > 0 ? (this.sessionTokens / this.sessionMs) * 1000 : undefined,
			estimated: this.estimated,
			buffered: this.last?.buffered ?? false,
			streaming: this.streaming,
		};
	}
}

/** "42 tok/s" while streaming, "last 42 tok/s" when idle, undefined before the first reply. */
function speedText(s: Speed): { text: string; live: boolean } | undefined {
	const tilde = s.estimated ? "~" : "";
	if (s.streaming && s.live !== undefined) return { text: `${tilde}${Math.round(s.live)} tok/s`, live: true };
	if (s.streaming) return { text: "…", live: true };
	if (s.last !== undefined) return { text: `last ${s.buffered ? "~" : ""}${Math.round(s.last)} tok/s`, live: false };
	return undefined;
}

/** Read-only overlay: sections of rows with a label gutter. Esc/Enter/q close; e, a run commands. */
class Dashboard implements Component {
	constructor(
		private sections: [string, string[]][],
		private theme: Theme,
		private close: (command?: string) => void,
	) {}
	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(20, width - 4);
		const row = (s: string) => {
			const cell = truncateToWidth(s, inner, "…");
			return t.fg("borderAccent", "│ ") + cell + " ".repeat(Math.max(0, inner - visibleWidth(cell))) + t.fg("borderAccent", " │");
		};
		const out = [t.fg("borderAccent", "┌─") + t.fg("accent", " status ") + t.fg("borderAccent", `${"─".repeat(Math.max(0, width - 11))}┐`)];
		for (const [label, lines] of this.sections) {
			lines.forEach((line, i) => out.push(row((i === 0 ? t.fg("accent", label.padEnd(10)) : " ".repeat(10)) + line)));
		}
		out.push(row(""), row(t.fg("dim", "e endpoints · a agents · esc close")));
		out.push(t.fg("borderAccent", `└${"─".repeat(Math.max(0, width - 2))}┘`));
		return out;
	}
	handleInput(data: string): void {
		if (data === "e") return this.close("endpoints");
		if (data === "a") return this.close("agents");
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") this.close();
	}
	handleMouse() {
		return { handled: true };
	}
	invalidate(): void {}
}

export default function (pi: ExtensionAPI): void {
	const slots = new Map<string, Slot>();
	let ctxRef: ExtensionContext | undefined;
	let tuiRef: TUI | undefined;
	let usage: Usage = { prompt: 0, cacheRead: 0, output: 0, calls: 0, cost: 0 };
	let statusesRef: ReadonlyMap<string, string> = new Map();
	const speed = new SpeedMeter();
	let lastSpeedRender = 0;
	let enabled = true;

	const rerender = () => tuiRef?.requestRender();

	pi.events.on("statusbar:transcript", (data) => {
		attachedPane = (data as { component?: Component } | undefined)?.component;
		if (mountedTui) applySidebarWidth(currentWidth || sidebarWidthFor(mountedTui.terminal.columns ?? 0, widthOverride));
		rerender();
	});
	pi.events.on("statusbar:attached", (data) => {
		attached = (data as { name?: string; stats?: () => AttachedStats } | undefined)?.name
			? (data as { name: string; stats: () => AttachedStats })
			: undefined;
		rerender();
	});

	pi.events.on("statusbar:slot", (data) => {
		const slot = data as Slot;
		if (!slot?.id) return;
		slots.set(slot.id, slot);
		rerender();
	});

	function renderSlot(theme: Theme, text: string, state: SlotState | undefined, width: number): string {
		const mark = state && MARK[state];
		const body = state === "idle" ? theme.fg("dim", text) : theme.fg("muted", text);
		const cell = truncateToWidth(body + (mark ? ` ${theme.fg(mark[1], mark[0])}` : ""), Math.max(1, width - 2), "…");
		return cell + " ".repeat(Math.max(0, width - visibleWidth(cell)));
	}

	async function openDashboard(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const t = ctx.ui.theme;
		const markText = (s?: SlotState) => (s && MARK[s] ? `${t.fg(MARK[s]![1], MARK[s]![0])} ` : "");
		const ep = slots.get("endpoint");
		const img = slots.get("images");
		const u = ctx.getContextUsage();
		const claimed = new Set([...slots.values()].map((s) => s.statusKey).filter(Boolean));
		claimed.add("subagents");
		const other = [...statusesRef].filter(([k, v]) => !claimed.has(k) && stripAnsi(v).trim());

		const sections: [string, string[]][] = [
			["ENDPOINT", ep?.details?.() ?? [ep?.text ?? "unknown"]],
			["AGENTS", slots.get("agents")?.details?.() ?? ["none running"]],
			["ROUND", slots.get("round")?.details?.() ?? ["no round this session"]],
			["IMAGES", img?.details?.() ?? ["no images in this session"]],
			[
				"USAGE",
				[
					`context ${u?.tokens != null ? `${fmt(u.tokens)} tokens · ` : ""}${u?.percent != null ? `${u.percent.toFixed(1)}%` : "?"} of ${fmt(u?.contextWindow ?? 0)}`,
					`${fmt(usage.prompt)} prompt tokens over ${usage.calls} call${usage.calls === 1 ? "" : "s"} · cache ${usage.prompt ? ((100 * usage.cacheRead) / usage.prompt).toFixed(0) : 0}% · output ${fmt(usage.output)}${usage.cost > 0 ? ` · $${usage.cost.toFixed(4)}` : ""}`,
					(() => {
						const s2 = speed.read();
						const parts = [
							s2.streaming
								? `${s2.live !== undefined ? `${s2.estimated ? "~" : ""}${Math.round(s2.live)} tok/s now (${SPEED_WINDOW_MS / 1000}s window)` : "measuring…"}`
								: s2.last !== undefined
									? `${Math.round(s2.last)} tok/s last reply`
									: "no reply yet",
							s2.ttftMs !== undefined ? `first token ${(s2.ttftMs / 1000).toFixed(1)}s` : "",
							s2.buffered ? "delivered in one burst — delivery speed, not generation" : "",
							s2.sessionAvg !== undefined ? `${Math.round(s2.sessionAvg)} tok/s session average` : "",
						].filter(Boolean);
						return `speed: ${parts.join(" · ")}`;
					})(),
				],
			],
		];
		if (other.length) sections.push(["OTHER", other.map(([k, v]) => `${stripAnsi(v).trim()}  ${t.fg("dim", `(${k})`)}`)]);
		sections[0][1] = sections[0][1].map((l, i) => (i === 0 ? markText(ep?.state) + l : l));

		const command = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => new Dashboard(sections, theme, done), {
			overlay: true,
			// centred: the area above the footer varies (editor height, pi-subagents' agent list)
			overlayOptions: { anchor: "center", width: "80%", minWidth: 60, maxHeight: "70%" },
		});
		if (command) pi.sendUserMessage(`/${command}`, { expandPromptTemplates: true });
	}

	// ── sidebar ───────────────────────────────────────────────────────────────────────────────
	let sidebarWanted = true;
	let rowHeight = 0;

	/**
	 * The last thing you asked, pinned above the transcript — a reminder of the question while you
	 * read the answer, and a click target that jumps back to it.
	 *
	 * The jump itself is Pi's, not ours: it marks each prompt with an OSC 133 sequence and
	 * `scrollToPrompt(-1)` finds the nearest one above and puts that row at the top. It is already
	 * on ctrl+shift+up; this only makes it visible and clickable. scrollToPrompt is not in the
	 * public typings, so it is called behind a typeof check and the click degrades to nothing.
	 */
	let pinnedPrompt: string | undefined;
	let pinWanted = true;
	const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

	/**
	 * Pi's prompt marker sits at the *end* of a user message, so scrollToPrompt alone lands just
	 * past it — you see the reply, not the question. Measured: the first rows after a raw jump were
	 * "Thought for 2s" and the reply. Lift a couple of rows so the message itself is on screen.
	 */
	const PIN_JUMP_LIFT = Number(process.env.PI_PIN_JUMP_LIFT ?? 2);

	function jumpToLastPrompt(): void {
		const tui = mountedTui as unknown as {
			scrollToBottom?: () => void;
			scrollToPrompt?: (d: number) => void;
			scrollBy?: (n: number) => void;
		} | undefined;
		if (!tui || typeof tui.scrollToPrompt !== "function") return;
		tui.scrollToBottom?.(); // start from the end so "previous" means the most recent prompt
		tui.scrollToPrompt(-1);
		if (PIN_JUMP_LIFT > 0) tui.scrollBy?.(-PIN_JUMP_LIFT);
	}

	const pinBar: Component = {
		invalidate() {},
		handleMouse(event: TuiMouseEvent) {
			if (event.type !== "down" && event.type !== "click") return undefined;
			jumpToLastPrompt();
			return { consume: true };
		},
		render(width: number): string[] {
			const c = ctxRef;
			if (!pinWanted || !pinnedPrompt || !alive(c)) return [];
			const t = c.ui.theme;
			const hint = t.fg("dim", " ctrl+shift+↑");
			const room = Math.max(10, width - visibleWidth(hint) - 4);
			const body = t.fg("accent", "▲ ") + t.fg("muted", truncateToWidth(oneLine(pinnedPrompt), room, "…"));
			const pad = Math.max(1, width - visibleWidth(body) - visibleWidth(hint));
			return [body + " ".repeat(pad) + hint];
		},
	} as Component;
	let mountedRoot: Component | undefined;
	let mountedTui: TUI | undefined;
	let piRoot: Component | undefined;
	let piKids: Component[] | undefined;
	/** While attached to a subagent, fleet.ts supplies the transcript pane and the stats to show. */
	let attachedPane: Component | undefined;
	let attached: { name: string; stats: () => AttachedStats } | undefined;
	let widthOverride = SIDEBAR_FIXED_WIDTH;
	let minColumns = SIDEBAR_MIN_COLUMNS;
	let currentWidth = 0;
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;
	let resizeHooked = false;
	/**
	 * `/reload` throws away this activation's ctx but keeps the TUI — and with it whatever we
	 * installed as the layout root. Touching a stale ctx from a render throws *inside Pi's layout
	 * pass*, which is an uncaughtException and kills the session, so:
	 *   - every render here is stale-safe (see `alive`), and
	 *   - session_shutdown hands Pi's own root back before the new activation starts.
	 * The setLayoutRoot patch lives on the TUI under a shared symbol rather than in this closure,
	 * so reloading swaps the handler instead of stacking another wrapper that calls a dead one.
	 */
	const LAYOUT_HOOK = Symbol.for("pi-statusbar:layout-hook");
	type LayoutHook = { onRoot?: (component: Component) => void };
	let dead = false;
	const alive = (c: ExtensionContext | undefined): c is ExtensionContext => {
		if (dead || !c) return false;
		try {
			return c.hasUI; // getter throws once this activation has been replaced
		} catch {
			dead = true;
			return false;
		}
	};

	// endpoints.ts publishes the short names it uses ("globus3", "ALCF Minerva"); fall back to the
	// provider's display name so a provider it does not know about still reads sensibly.
	const endpointLabels = new Map<string, string>();
	pi.events.on("statusbar:endpoint-labels", (data) => {
		for (const [provider, label] of Object.entries((data ?? {}) as Record<string, string>)) endpointLabels.set(provider, label);
		rerender();
	});
	const providerLabel = (provider: string): string =>
		endpointLabels.get(provider) ?? (ctxRef?.modelRegistry.getProviderDisplayName(provider) ?? provider).split(" · ")[0];

	const sidebarShown = (width: number) =>
		sidebarWanted && mountedTui !== undefined && mountedTui === tuiRef && tuiRef?.mode === "fullscreen" && width >= minColumns;

	/**
	 * Pi calls render() on every frame it draws — including every keystroke you type and every
	 * chunk of streaming text — while this column only *changes* when one of its own events fires
	 * (message_update, throttled to 250ms; turn_end; a statusbar:slot; fleet's 500ms ticker while
	 * agents run). Measured, rebuilding it each frame cost ~13ms and ~6KB of output: one wheel
	 * event took 36.3ms with the column on and 23.1ms with `/sidebar off`.
	 *
	 * So the lines are cached against every value the body reads. Nothing here needs explicit
	 * invalidation: each live number already changes through an event that also requests a render,
	 * so a changed value means a changed key. The 1-second bucket is the backstop for anything
	 * time-derived that is not in the key — it caps staleness rather than carrying the design.
	 */
	let sidebarCache: { key: string; lines: string[] } | undefined;
	const sidebarKey = (width: number, c: ExtensionContext): string => {
		const u = c.getContextUsage();
		const att = attached?.stats();
		const sp = speedText(speed.read()); // the formatted string is what is displayed, so key on it
		return [
			width,
			rowHeight,
			c.ui.theme.fg("accent", "·"), // cheap theme fingerprint: the escape codes change with the theme
			c.model ? `${c.model.provider}/${c.model.id}` : "",
			pi.getThinkingLevel(),
			c.cwd,
			u?.percent?.toFixed(1) ?? "",
			u?.contextWindow ?? "",
			usage.prompt,
			usage.output,
			usage.cacheRead,
			usage.calls,
			sp?.text ?? "",
			sp?.live ?? "",
			attached?.name ?? "",
			att && [att.status, att.modelId, att.contextPercent, att.tokens, att.turns, att.rate, Math.round(att.elapsedMs / 500)].join(","),
			[...slots.values()].map((s) => `${s.id}:${s.state}:${s.text}:${(s.details?.() ?? []).join("~")}`).join("|"),
			[...statusesRef].map(([k, v]) => `${k}=${stripAnsi(v).trim()}`).join("|"),
			[...endpointLabels].join("|"),
			Math.floor(Date.now() / 1000), // backstop: nothing may be stale by more than a second
		].join("\u0000");
	};

	const sidebar: Component = {
		invalidate() {
			sidebarCache = undefined;
		},
		render(width: number): string[] {
			const c = ctxRef;
			if (!alive(c)) return [];
			const key = sidebarKey(width, c);
			if (sidebarCache?.key === key) return sidebarCache.lines;
			const lines = drawSidebar(width, c);
			sidebarCache = { key, lines };
			return lines;
		},
	} as Component;

	function drawSidebar(width: number, c: ExtensionContext): string[] {
		{
			const t = c.ui.theme;
			const inner = Math.max(10, width - 3);
			const compact = width < SIDEBAR_COMPACT_BELOW; // label on its own line, value indented
			const valueWidth = compact ? inner - 2 : inner - 11;
			const lines: string[] = [];
			const section = (label: string, state: SlotState | undefined, values: string[]) => {
				const mark = state && MARK[state];
				if (compact) lines.push(t.fg("accent", label) + (mark ? ` ${t.fg(mark[1], mark[0])}` : ""));
				values.forEach((v, i) => {
					const head = compact
						? "  "
						: i === 0
							? t.fg("accent", label.padEnd(9)) + (mark ? t.fg(mark[1], mark[0]) : " ") + " "
							: " ".repeat(11);
					lines.push(head + truncateToWidth(v, valueWidth, "…"));
				});
				lines.push("");
			};

			const att = attached?.stats();
			if (attached && att) {
				lines.push(t.fg("accent", "▶ ATTACHED"));
				lines.push(`  ${truncateToWidth(attached.name, valueWidth, "…")}`);
				lines.push(`  ${t.fg("dim", `${att.status} · esc to detach`)}`);
				lines.push("");
				const model = att.modelId?.split("/").slice(1).join("/") ?? "?";
				section("MODEL", undefined, [t.fg("text", model), t.fg("dim", att.modelId ? providerLabel(att.modelId.split("/")[0]) : "")]);
				const pct = att.contextPercent;
				const cells = Math.max(4, valueWidth);
				const filledA = pct == null ? 0 : Math.round((pct / 100) * cells);
				section("CONTEXT", pct != null && pct >= 85 ? "warn" : undefined, [
					pct == null ? "?" : `${pct.toFixed(1)}%`,
					t.fg("accent", "█".repeat(filledA)) + t.fg("borderMuted", "░".repeat(Math.max(0, cells - filledA))),
				]);
				section("AGENT", undefined, [
					`↻${att.turns} · ${fmt(att.tokens)} tok`,
					t.fg("dim", `${att.rate ? `${Math.round(att.rate)} t/s · ` : ""}${secs(att.elapsedMs)}`),
				]);
				lines.push(t.fg("dim", "esc detach · /status"));
				const height = Math.max(lines.length, rowHeight);
				const out: string[] = [];
				for (let i = 0; i < height; i++) {
					const cell = truncateToWidth(lines[i] ?? "", inner, "…");
					out.push(`${t.fg("borderMuted", "│")}  ${cell}${" ".repeat(Math.max(0, inner - visibleWidth(cell)))}`);
				}
				return out;
			}

			const ep = slots.get("endpoint");
			const host = (() => {
				try {
					return new URL((c.model as { baseUrl?: string } | undefined)?.baseUrl ?? "").host;
				} catch {
					return "";
				}
			})();
			section("ENDPOINT", ep?.state, [t.fg("text", ep?.text ?? "?"), t.fg("dim", host)]);
			section("MODEL", undefined, [
				t.fg("text", c.model?.id ?? "no model"),
				t.fg("dim", c.model?.reasoning ? `thinking ${pi.getThinkingLevel()}` : "no thinking"),
			]);

			const u = c.getContextUsage();
			const pct = u?.percent;
			const ctxState: SlotState | undefined = pct == null ? undefined : pct >= 90 ? "error" : pct >= 75 ? "warn" : undefined;
			const filled = Math.round(((pct ?? 0) / 100) * valueWidth);
			const barColor: Color = ctxState === "error" ? "error" : ctxState === "warn" ? "warning" : "accent";
			section("CONTEXT", ctxState, [
				`${pct == null ? "?" : `${pct.toFixed(1)}%`} of ${fmt(u?.contextWindow ?? c.model?.contextWindow ?? 0)}`,
				t.fg(barColor, "█".repeat(filled)) + t.fg("borderMuted", "░".repeat(Math.max(0, valueWidth - filled))),
			]);

			const img = slots.get("images");
			section("IMAGES", img?.state === "warn" ? "warn" : undefined, [
				img && img.state !== "idle" ? img.text.replace(/^images /, "") + " sent" : t.fg("dim", "none"),
			]);

			// rounds.ts only: shown once a dev/review/critique round has started, hidden for sessions
			// that never run one rather than sitting there permanently dimmed
			const rnd = slots.get("round");
			if (rnd && rnd.state !== "idle") section("ROUND", rnd.state, rnd.details?.() ?? [rnd.text]);

			const cache = usage.prompt ? `cache ${((100 * usage.cacheRead) / usage.prompt).toFixed(0)}% · ` : "";
			const sp = speedText(speed.read());
			section("USAGE", undefined, [
				`in ${fmt(usage.prompt)} · out ${fmt(usage.output)}`,
				t.fg("dim", `${cache}${usage.calls} call${usage.calls === 1 ? "" : "s"}`),
				...(sp ? [sp.live ? t.fg("accent", sp.text) : t.fg("dim", sp.text)] : []),
			]);

			const claimed = new Set([...slots.values()].map((x) => x.statusKey).filter(Boolean));
			claimed.add("subagents");
			const other = [...statusesRef].filter(([k, v]) => !claimed.has(k) && stripAnsi(v).trim());
			if (other.length) section("OTHER", undefined, other.map(([, v]) => stripAnsi(v).trim()));
			// only the commands that fit whole: a truncated "/ag" helps nobody
			const hints: string[] = [];
			for (const cmd of ["/status", "/endpoints", "/agents"]) {
				const next = [...hints, cmd].join("  ");
				if (next.length <= inner) hints.push(cmd);
			}
			if (hints.length) lines.push(t.fg("dim", hints.join("  ")));

			// divider down the full height of the row (height comes from the stack's visible() hook)
			const height = Math.max(lines.length, rowHeight);
			const out: string[] = [];
			for (let i = 0; i < height; i++) {
				const cell = truncateToWidth(lines[i] ?? "", inner, "…");
				out.push(`${t.fg("borderMuted", "│")}  ${cell}${" ".repeat(Math.max(0, inner - visibleWidth(cell)))}`);
			}
			return out;
		}
	}

	/**
	 * A window drag delivers a burst of resize events. Rebuild the layout and force one full repaint
	 * after they stop, rather than swapping layouts mid-drag: a partial repaint at a stale width is
	 * what leaves artefacts on screen until the next keystroke.
	 */
	function scheduleResizeSettle(): void {
		if (resizeTimer) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			resizeTimer = undefined;
			const tui = tuiRef;
			if (!tui) return;
			if (mountedTui === tui) applySidebarWidth(sidebarWidthFor(tui.terminal.columns ?? 0, widthOverride));
			tui.renderNow(true); // force: repaint every row, not just the ones that differ
		}, 120);
	}

	function mountSidebar(tui: TUI): void {
		if (!sidebarWanted || !isViewportTUI(tui)) return;
		const viewport = tui as unknown as {
			layoutRoot?: Component;
			setLayoutRoot(c: Component | undefined): void;
			[LAYOUT_HOOK]?: LayoutHook;
		};
		let hook = viewport[LAYOUT_HOOK];
		if (!hook) {
			// patch this TUI once, ever; later activations replace onRoot rather than re-wrapping
			hook = {};
			viewport[LAYOUT_HOOK] = hook;
			const original = viewport.setLayoutRoot.bind(tui);
			const installed = hook;
			viewport.setLayoutRoot = (component) => {
				original(component);
				if (component) installed.onRoot?.(component);
			};
		}
		hook.onRoot = (component) => {
			if (!dead && component !== mountedRoot) setTimeout(() => mountSidebar(tui), 0);
		};
		const root = viewport.layoutRoot;
		if (!root || root === mountedRoot) return;
		const kids = (root as { children?: Component[] }).children;
		if (!(root instanceof VStack) || kids?.length !== 2 || !(kids[0] instanceof ScrollView)) return; // unknown layout: leave it
		piRoot = root;
		piKids = kids;
		mountedTui = tui;
		applySidebarWidth(sidebarWidthFor(tui.terminal.columns ?? 0, widthOverride));
	}

	/** (Re)build the split layout at a given sidebar width. */
	function applySidebarWidth(nextWidth: number): void {
		const tui = mountedTui as unknown as { setLayoutRoot(c: Component | undefined): void } | undefined;
		if (!tui || !piKids) return;
		const [transcript, dock] = [attachedPane ?? piKids[0], piKids[1]];
		currentWidth = nextWidth;
		mountedRoot = new VStack([
			{
				component: pinBar,
				basis: 1,
				grow: 0,
				shrink: 0,
				// costs a transcript row, so it only takes one when there is something to pin
				visible: () => pinWanted && Boolean(pinnedPrompt),
			},
			{
				component: new HStack([
					{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 24 },
					{
						component: sidebar,
						basis: nextWidth,
						grow: 0,
						shrink: 1,
						minSize: 18,
						visible: (vp) => {
							rowHeight = vp.height;
							const wanted = sidebarWidthFor(vp.width, widthOverride);
							// terminal resized into another width class: rebuild once the drag settles
							if (wanted !== currentWidth) scheduleResizeSettle();
							return sidebarWanted && vp.width >= minColumns;
						},
					},
				]),
				basis: 0,
				grow: 1,
				shrink: 1,
				minSize: 1,
			},
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		tui.setLayoutRoot(mountedRoot);
	}

	function unmountSidebar(): void {
		const tui = mountedTui as unknown as { setLayoutRoot(c: Component | undefined): void } | undefined;
		mountedRoot = undefined;
		mountedTui = undefined;
		if (tui && piRoot) tui.setLayoutRoot(piRoot);
	}

	function install(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			setTimeout(() => mountSidebar(tui), 0);
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const c = alive(ctxRef) ? ctxRef : alive(ctx) ? ctx : undefined;
					if (!c) return []; // this activation is gone; the new one draws its own footer
					statusesRef = footerData.getExtensionStatuses();
					const sep = theme.fg("dim", " · ");
					const cwd = c.cwd.startsWith(homedir()) ? `~${c.cwd.slice(homedir().length)}` : c.cwd;
					const branch = footerData.getGitBranch();
					const where = `${cwd}${branch ? ` (${branch})` : ""}`;

					if (attached) {
						const banner = theme.fg("accent", `▶ attached: ${attached.name}`) + theme.fg("dim", " · typing steers it · esc detaches");
						return [truncateToWidth(banner, width, "…")];
					}

					// sidebar showing: everything else lives there, the footer is just the path
					if (sidebarShown(width)) {
						const hint = theme.fg("dim", "/status");
						const room = width - visibleWidth(hint) - 2;
						const shown = room >= where.length ? where : `…${where.slice(where.length - room + 1)}`;
						return [theme.fg("dim", shown) + " ".repeat(Math.max(1, width - visibleWidth(shown) - visibleWidth(hint))) + hint];
					}

					// line 1: path on the left; model · thinking · context right-aligned and never cut
					const u = c.getContextUsage();
					const pct = u?.percent;
					const ctxColor: Color = pct == null ? "dim" : pct >= 90 ? "error" : pct >= 75 ? "warning" : "muted";
					const right =
						theme.fg("text", c.model?.id ?? "no model") + sep +
						theme.fg("muted", c.model?.reasoning ? `thinking ${pi.getThinkingLevel()}` : "no thinking") + sep +
						theme.fg(ctxColor, `ctx ${pct == null ? "?" : `${pct.toFixed(1)}%`} of ${fmt(u?.contextWindow ?? c.model?.contextWindow ?? 0)}`);
					const room = width - visibleWidth(right) - 2;
					const shown = room >= where.length ? where : room > 4 ? `…${where.slice(where.length - room + 1)}` : "";
					const line1 = theme.fg("dim", shown) + " ".repeat(Math.max(1, width - visibleWidth(shown) - visibleWidth(right))) + right;

					// line 2: fixed columns — endpoint | agents | images | usage (+N other statuses)
					const ep = slots.get("endpoint");
					const img = slots.get("images");
					const ag = slots.get("agents");
					const claimed = new Set([...slots.values()].map((s) => s.statusKey).filter(Boolean));
					claimed.add("subagents");
					const others = [...statusesRef].filter(([k, v]) => !claimed.has(k) && stripAnsi(v).trim()).length;
					const cache = usage.prompt ? ` · cache ${((100 * usage.cacheRead) / usage.prompt).toFixed(0)}%` : "";
					const sp = speedText(speed.read());
					const usageText = `in ${fmt(usage.prompt)} · out ${fmt(usage.output)}${cache}${sp ? ` · ${sp.text}` : ""}${others ? `  +${others}` : ""}`;
					const w = [0.22, 0.17, 0.17].map((f) => Math.floor(width * f));
					const line2 =
						renderSlot(theme, `⇄ ${ep?.text ?? "endpoint ?"}`, ep?.state, w[0]) +
						renderSlot(theme, ag?.text ?? "agents –", ag?.state ?? "idle", w[1]) +
						renderSlot(theme, img?.text ?? "images –", img?.state ?? "idle", w[2]) +
						truncateToWidth(theme.fg("dim", usageText), Math.max(0, width - w[0] - w[1] - w[2]), "…");

					return [truncateToWidth(line1, width, "…"), truncateToWidth(line2, width)];
				},
			} as Component & { dispose?: () => void };
		});
	}

	// Give Pi its own layout root back before this activation's ctx goes stale. Without this the
	// next activation finds a root it does not recognise (VStack[HStack, dock]) and declines to
	// mount, leaving a dead sidebar on screen that crashes the next layout pass.
	pi.on("session_shutdown", () => {
		dead = true;
		const tui = mountedTui as unknown as { [LAYOUT_HOOK]?: LayoutHook } | undefined;
		if (tui?.[LAYOUT_HOOK]) tui[LAYOUT_HOOK].onRoot = undefined;
		unmountSidebar();
	});

	// what you just asked, caught as you send it
	pi.on("input", (event) => {
		const text = (event as { text?: string })?.text?.trim();
		if (!text || text.startsWith("/")) return undefined; // a command is not a question to be reminded of
		pinnedPrompt = text;
		rerender();
		return undefined;
	});

	/** On a resumed session the pin would be blank until the next message, so recover the last one. */
	function backfillPrompt(ctx: ExtensionContext): void {
		try {
			for (const entry of [...(ctx.sessionManager?.getBranch() ?? [])].reverse()) {
				const msg = (entry as { message?: { role?: string; content?: unknown } })?.message;
				if (msg?.role !== "user") continue;
				const text =
					typeof msg.content === "string"
						? msg.content
						: (msg.content as { type?: string; text?: string }[] | undefined)
								?.filter((p) => p?.type === "text" && p.text)
								.map((p) => p.text)
								.join(" ");
				if (text?.trim() && !text.trim().startsWith("/")) {
					pinnedPrompt = text.trim();
					return;
				}
			}
		} catch {
			// a shape change here costs the pin, nothing else
		}
	}

	pi.on("session_start", (_event, ctx) => {
		dead = false;
		ctxRef = ctx;
		if (!pinnedPrompt) backfillPrompt(ctx);
		if (!resizeHooked && ctx.hasUI) {
			resizeHooked = true;
			process.stdout.on("resize", scheduleResizeSettle);
		}
		usage = sumUsage(ctx);
		if (enabled) install(ctx);
		pi.events.emit("statusbar:ready", {});
	});
	// message_end fires before Pi appends the message to the session, so re-sum once the turn is stored
	pi.on("turn_end", (_event, ctx) => {
		usage = sumUsage(ctx);
		rerender();
	});
	pi.on("agent_end", (_event, ctx) => {
		usage = sumUsage(ctx);
		rerender();
	});
	pi.on("message_start", (event) => {
		if ((event.message as { role?: string })?.role === "assistant") speed.start();
	});
	pi.on("message_update", (event) => {
		const m = event.message as { role?: string };
		if (m?.role !== "assistant") return;
		speed.update(event.message as never);
		// the transcript re-renders on its own; throttle our own repaints to keep the number moving
		if (Date.now() - lastSpeedRender > 250) {
			lastSpeedRender = Date.now();
			rerender();
		}
	});
	pi.on("message_end", (event) => {
		if ((event.message as { role?: string })?.role === "assistant") speed.end(event.message as never);
		rerender();
	});
	pi.on("model_select", () => rerender());

	pi.registerCommand("pin", {
		description: "Pin your last message above the transcript: /pin on · /pin off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") pinWanted = arg === "on";
			else pinWanted = !pinWanted;
			if (mountedTui) applySidebarWidth(currentWidth || sidebarWidthFor(mountedTui.terminal.columns ?? 0, widthOverride));
			rerender();
			ctx.ui.notify(
				pinWanted
					? `Pinned message on${pinnedPrompt ? "" : " — nothing to pin until your next message"}. Click it, or ctrl+shift+↑, to jump back to it.`
					: "Pinned message off.",
				"info",
			);
		},
	});

	pi.registerCommand("sidebar", {
		description: `Right sidebar (fullscreen, ≥ ${SIDEBAR_MIN_COLUMNS} cols): /sidebar on|off · /sidebar <cols>|auto · /sidebar min <cols>`,
		handler: async (args, ctx) => {
			const arg = args.trim() || (sidebarWanted ? "off" : "on");
			const min = /^min\s+(\d+)$/.exec(arg);
			if (min) {
				minColumns = Number(min[1]);
				ctx.ui.notify(`sidebar: shown when the terminal is at least ${minColumns} columns`, "info");
				rerender();
				return;
			}
			if (arg === "auto" || /^\d+$/.test(arg)) {
				widthOverride = arg === "auto" ? 0 : Number(arg);
				sidebarWanted = true;
				if (tuiRef) mountSidebar(tuiRef);
				applySidebarWidth(sidebarWidthFor(tuiRef?.terminal.columns ?? 0, widthOverride));
				return;
			}
			sidebarWanted = arg === "on";
			if (sidebarWanted && tuiRef) mountSidebar(tuiRef);
			if (!sidebarWanted) unmountSidebar();
			if (sidebarWanted && tuiRef?.mode !== "fullscreen") ctx.ui.notify("The sidebar needs fullscreen mode (/settings → TUI mode).", "info");
			rerender();
		},
	});

	pi.registerCommand("status", {
		description: "Status dashboard: endpoint, agents, images, usage; /status off|on toggles the footer",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "off" || arg === "on") {
				enabled = arg === "on";
				if (enabled) install(ctx);
				else ctx.ui.setFooter(undefined);
				return;
			}
			await openDashboard(ctx);
		},
	});
}
