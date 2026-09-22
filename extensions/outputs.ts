/**
 * outputs — `/open`: pick any tool result or reasoning block from this session and read it properly.
 *
 * Short things open in an overlay (read, escape, carry on). Anything longer than OPEN_IN_EDITOR_LINES
 * is written to a file and handed to $EDITOR, where you get syntax highlighting, search, and a
 * window that stays open while you keep working in the terminal.
 *
 * The content comes from the *session*, not from the rendered transcript, which matters more than it
 * sounds: the display collapses a 4,000-line command result to a single line, but the session still
 * holds all of it. So /open can show you output the transcript threw away, and it works on blocks
 * that scrolled off long ago. It also means nothing here depends on another extension's internals.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** A knob is a positive finite number or it is the default; "" and "lots" used to become 0 and NaN. */
const knob = (raw: string | undefined, fallback: number): number => {
	const n = Number(raw);
	return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
};
const TERMINAL_EDITORS = new Set(["vi", "vim", "nvim", "nano", "pico", "emacs", "micro", "hx", "helix", "joe", "ne", "ed", "kak"]);
/** Session entries carry content as a string or an array of blocks; anything else is treated as empty. */
const blocks = (content: unknown): any[] => (Array.isArray(content) ? content : []);
const OPEN_IN_EDITOR_LINES = knob(process.env.PI_OPEN_EDITOR_LINES, 40);
const MAX_ENTRIES = 40; // the picker is for finding something recent, not browsing all of history
const MIN_THINKING_CHARS = knob(process.env.PI_OPEN_MIN_THINKING, 200);

type Item = {
	kind: "tool" | "thinking" | "bash" | "diff";
	label: string; // what produced it, for the picker
	detail: string; // the command or file, for the picker
	text: string;
	lines: number;
	suggestedName: string;
	isError?: boolean;
	/** The message this belongs to — "it was when I asked about X" is how you remember it. */
	prompt: string;
	at?: number;
};

/** A line in the picker: either a heading for one of your messages, or something to open. */
type Row = { kind: "group"; prompt: string; at?: number } | { kind: "item"; item: Item };

const ago = (at?: number): string => {
	if (!at) return "";
	const s = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
};

/**
 * Reasoning blocks nearly all open the same way ("We need to…"), so the first 60 characters make a
 * useless label. Prefer the first line with something specific in it.
 */
function preview(text: string, n: number): string {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	const meaty = lines.find((l) => l.length > 25 && !/^(we need to|let'?s|okay|now|first,? )/i.test(l)) ?? lines[0] ?? "";
	return oneLine(meaty, n);
}

/** A file name that gives the editor a fighting chance at syntax highlighting. */
function nameFor(kind: string, tool: string | undefined, args: Record<string, unknown> | undefined, n: number): string {
	const path = typeof args?.path === "string" ? args.path : typeof args?.file === "string" ? args.file : undefined;
	if (path) {
		const base = path.split("/").pop() || "output";
		return `${String(n).padStart(2, "0")}-${base}`;
	}
	if (kind === "thinking") return `${String(n).padStart(2, "0")}-reasoning.md`;
	return `${String(n).padStart(2, "0")}-${tool ?? "output"}.txt`;
}

const oneLine = (s: string, n: number) => {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** Walk the session and collect everything worth re-reading, tagged with the message it followed. */
/** Everything worth opening in a session branch, in order, each tagged with the prompt it followed. */
export function collectFrom(branch: readonly unknown[]): Item[] {
	const items: Item[] = [];
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	let prompt = "(before your first message)";
	let n = 0;
	for (const entry of branch as { type?: string; message?: any; timestamp?: string }[]) {
		const m = entry?.message;
		if (entry?.type !== "message" || !m) continue;
		const at = entry.timestamp ? Date.parse(entry.timestamp) : undefined;

		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : blocks(m.content).filter((c) => c?.type === "text").map((c) => c.text).join(" ");
			if (text?.trim() && !text.trim().startsWith("/")) prompt = oneLine(text.trim(), 70);
			continue;
		}

		if (m.role === "assistant") {
			for (const part of blocks(m.content)) {
				if (part?.type === "toolCall" && part.id) calls.set(part.id, { name: part.name, args: part.arguments ?? {} });
				// A one-line "Should add a docstring to the get method" is readable where it already is;
				// listing every such aside buries the things worth reopening.
				if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim().length >= MIN_THINKING_CHARS) {
					const text = part.thinking.trim();
					items.push({
						kind: "thinking",
						label: "reasoning",
						detail: preview(text, 60),
						text,
						lines: text.split("\n").length,
						suggestedName: nameFor("thinking", undefined, undefined, ++n),
						prompt,
						at,
					});
				}
			}
			continue;
		}

		// a `!command` you ran yourself: its own entry shape, with the output on the message
		if (m.role === "bashExecution" && typeof m.output === "string" && m.output.trim()) {
			const text = m.output.replace(/\n+$/, "");
			items.push({
				kind: "bash",
				label: "!bash",
				detail: oneLine(String(m.command ?? ""), 60),
				text,
				lines: text.split("\n").length,
				suggestedName: `${String(++n).padStart(2, "0")}-bash.txt`,
				isError: typeof m.exitCode === "number" && m.exitCode !== 0,
				prompt,
				at,
			});
			continue;
		}

		if (m.role === "toolResult") {
			const text = (typeof m.content === "string" ? m.content : blocks(m.content).map((c) => c?.text ?? "").join("\n")).trim();
			const call = m.toolCallId ? calls.get(m.toolCallId) : undefined;
			const tool = m.toolName ?? call?.name ?? "tool";

			/**
			 * An edit's *result* is one line ("Successfully replaced 1 block(s)…"), which is useless to
			 * re-read. The change itself is on `details`: pi already computes `patch` (a real unified
			 * diff) and `diff` (the same with line numbers) — the very data pi-cc renders inline. So an
			 * edit becomes a diff entry rather than a status message, and no differ of our own is needed.
			 */
			const patch = typeof m.details?.patch === "string" ? m.details.patch.trim() : "";
			if (patch) {
				const path = typeof call?.args?.path === "string" ? call.args.path : "";
				const body = path ? `# ${path}\n\n${patch}` : patch;
				const plus = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
				const minus = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
				items.push({
					kind: "diff",
					label: tool,
					detail: `${path.split("/").pop() || "change"}  +${plus} −${minus}`,
					text: body,
					lines: body.split("\n").length,
					suggestedName: `${String(++n).padStart(2, "0")}-${(path.split("/").pop() || "change").replace(/\.[^.]+$/, "")}.diff`,
					isError: Boolean(m.isError),
					prompt,
					at,
				});
				continue;
			}
			/**
			 * A write has no `details` at all, so its result reads "Successfully wrote …" — no more
			 * use than an edit's did. The content it wrote is on the *call*, so show that instead,
			 * under the file's own name so the editor highlights it.
			 */
			if (tool === "write" && typeof call?.args?.content === "string" && call.args.content.trim()) {
				const path = typeof call.args.path === "string" ? call.args.path : "";
				const body = call.args.content.replace(/\n+$/, "");
				items.push({
					kind: "tool",
					label: "write",
					detail: `${path.split("/").pop() || "file"}  ${body.split("\n").length} lines written`,
					text: body,
					lines: body.split("\n").length,
					suggestedName: `${String(++n).padStart(2, "0")}-${path.split("/").pop() || "written.txt"}`,
					isError: Boolean(m.isError),
					prompt,
					at,
				});
				continue;
			}

			if (!text) continue;
			items.push({
				kind: "tool",
				label: tool,
				detail: call?.args ? oneLine(Object.values(call.args).map(String).join(" "), 60) : preview(text, 60),
				text,
				lines: text.split("\n").length,
				suggestedName: nameFor("tool", tool, call?.args, ++n),
				isError: Boolean(m.isError),
				prompt,
				at,
			});
		}
	}
	return items;
}

/** Group newest-first, each of your messages heading the things that came after it. */
function rowsFor(items: Item[]): Row[] {
	const rows: Row[] = [];
	let current: string | undefined;
	for (const item of [...items].reverse()) {
		if (item.prompt !== current) {
			current = item.prompt;
			rows.push({ kind: "group", prompt: item.prompt, at: item.at });
		}
		rows.push({ kind: "item", item });
	}
	return rows;
}

/**
 * The picker. Getting from "that reasoning block I just watched scroll past" to "this row in a
 * list" is the hard part, so it does three things a flat list of labels cannot:
 *   - groups entries under the message they followed, because that is how you remember them
 *   - previews the highlighted entry on the right, so you confirm before you commit
 *   - filters on the full text, so something you remember it *saying* will find it
 */
class Picker implements Component {
	private rows: Row[] = [];
	private cursor = 0; // index into this.rows, always on an item
	private filter = "";
	private top = 0; // first visible row, for scrolling the list

	// Plain fields rather than constructor parameter properties: Node's strip-only TypeScript mode
	// cannot parse those, and scripts/check.sh's parse step relies on it.
	private all: Item[];
	private height: number;
	private theme: Theme;
	private close: (chosen?: Item) => void;

	constructor(all: Item[], height: number, theme: Theme, close: (chosen?: Item) => void) {
		this.all = all;
		this.height = height;
		this.theme = theme;
		this.close = close;
		this.rebuild();
	}

	private rebuild(): void {
		const q = this.filter.toLowerCase();
		const matched = q
			? this.all.filter(
					(i) =>
						i.label.toLowerCase().includes(q) ||
						i.detail.toLowerCase().includes(q) ||
						i.prompt.toLowerCase().includes(q) ||
						i.text.toLowerCase().includes(q), // what you remember it saying
				)
			: this.all;
		this.rows = rowsFor(matched.slice(-MAX_ENTRIES));
		this.cursor = this.rows.findIndex((r) => r.kind === "item");
		this.top = 0;
	}

	private move(step: number): void {
		for (let i = this.cursor + step; i >= 0 && i < this.rows.length; i += step) {
			if (this.rows[i].kind === "item") {
				this.cursor = i;
				const listRows = this.height - 4;
				if (i < this.top) this.top = i;
				if (i >= this.top + listRows) this.top = i - listRows + 1;
				return;
			}
		}
	}

	private current(): Item | undefined {
		const row = this.rows[this.cursor];
		return row?.kind === "item" ? row.item : undefined;
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(30, width - 4);
		const listW = Math.max(30, Math.min(64, Math.floor(inner * 0.42)));
		const previewW = inner - listW - 3;
		const item = this.current();
		const previewLines = (item?.text ?? "").split("\n");

		const pad = (s: string, w: number) => {
			const cell = truncateToWidth(s, w, "…");
			return cell + " ".repeat(Math.max(0, w - visibleWidth(cell)));
		};

		const body: string[] = [];
		const listRows = this.height - 4;
		for (let n = 0; n < listRows; n++) {
			const rowIndex = this.top + n;
			const row = this.rows[rowIndex];
			let left: string;
			if (!row) left = pad("", listW);
			else if (row.kind === "group") {
				const when = ago(row.at);
				const head = truncateToWidth(`▸ ${row.prompt}`, Math.max(8, listW - visibleWidth(when) - 1), "…");
				left = t.fg("accent", head) + " ".repeat(Math.max(1, listW - visibleWidth(head) - visibleWidth(when))) + t.fg("dim", when);
			} else {
				const selected = rowIndex === this.cursor;
				const mark = row.item.isError ? "✗" : selected ? "→" : " ";
				const size = `${row.item.lines}L`;
				const text = `  ${mark} ${row.item.label.padEnd(9)} ${size.padStart(5)}  ${row.item.detail}`;
				left = selected ? t.fg("text", pad(text, listW)) : t.fg("muted", pad(text, listW));
			}
			const right = pad(previewLines[n] ?? "", previewW);
			body.push(`${left} ${t.fg("borderMuted", "│")} ${n < previewLines.length ? t.fg("muted", right) : right}`);
		}

		const title = item
			? `open · ${item.label} · ${item.lines} line${item.lines === 1 ? "" : "s"} · ${item.lines > OPEN_IN_EDITOR_LINES ? "enter → editor" : "enter → pager"}`
			: this.filter
				? `open · nothing matches "${this.filter}"`
				: "open · nothing to show";
		const head = truncateToWidth(title, Math.max(8, width - 6), "…");
		const out = [t.fg("borderAccent", "┌─") + t.fg("accent", ` ${head} `) + t.fg("borderAccent", `${"─".repeat(Math.max(0, width - visibleWidth(head) - 5))}┐`)];
		for (const line of body) out.push(`${t.fg("borderAccent", "│ ")}${line}${t.fg("borderAccent", " │")}`);
		const hint = this.filter ? `filter: ${this.filter}` : "type to filter · ↑↓ move · enter open · esc close";
		out.push(`${t.fg("borderAccent", "│ ")}${pad(t.fg("dim", hint), inner)}${t.fg("borderAccent", " │")}`);
		out.push(t.fg("borderAccent", `└${"─".repeat(Math.max(0, width - 2))}┘`));
		return out;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) return this.close();
		if (matchesKey(data, "enter")) return this.close(this.current());
		if (matchesKey(data, "down")) return this.move(1);
		if (matchesKey(data, "up")) return this.move(-1);
		if (matchesKey(data, "backspace")) {
			this.filter = this.filter.slice(0, -1);
			return this.rebuild();
		}
		if (data.length === 1 && data >= " " && data <= "~") {
			this.filter += data;
			this.rebuild();
		}
	}
	handleMouse() {
		return { handled: true };
	}
	invalidate(): void {}
}

/** Unified-diff colouring, using the same theme entries the transcript's diffs use. */
function paintDiff(line: string, t: Theme): string {
	if (/^\+\+\+|^---/.test(line)) return t.fg("dim", line);
	if (line.startsWith("@@")) return t.fg("accent", line);
	if (line.startsWith("+")) return t.fg("toolDiffAdded", line);
	if (line.startsWith("-")) return t.fg("toolDiffRemoved", line);
	if (line.startsWith("#")) return t.fg("dim", line);
	return t.fg("toolDiffContext", line);
}

class Pager implements Component {
	private title: string;
	private lines: string[];
	private theme: Theme;
	private close: () => void;
	private paint?: (line: string, t: Theme) => string;

	constructor(title: string, lines: string[], theme: Theme, close: () => void, paint?: (line: string, t: Theme) => string) {
		this.title = title;
		this.lines = lines;
		this.theme = theme;
		this.close = close;
		this.paint = paint;
	}
	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(20, width - 4);
		const row = (s: string) => {
			const cell = truncateToWidth(s, inner, "…");
			return t.fg("borderAccent", "│ ") + cell + " ".repeat(Math.max(0, inner - visibleWidth(cell))) + t.fg("borderAccent", " │");
		};
		const head = truncateToWidth(this.title, Math.max(8, width - 12), "…");
		const out = [t.fg("borderAccent", "┌─") + t.fg("accent", ` ${head} `) + t.fg("borderAccent", `${"─".repeat(Math.max(0, width - visibleWidth(head) - 5))}┐`)];
		for (const line of this.lines) out.push(row(this.paint ? this.paint(line, t) : line));
		out.push(row(""), row(t.fg("dim", "esc close")));
		out.push(t.fg("borderAccent", `└${"─".repeat(Math.max(0, width - 2))}┘`));
		return out;
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") this.close();
	}
	handleMouse() {
		return { handled: true };
	}
	invalidate(): void {}
}

export default function (pi: ExtensionAPI): void {
	// one directory per session, so the editor's open tabs stay valid until pi exits
	const dir = join(tmpdir(), `pi-open-${process.pid}`);
	let dirMade = false;

	pi.on("session_shutdown", (event) => {
		// The directory is per pid, and the next activation reuses it: deleting it on a reload pulls
		// files out from under editors that still have them open.
		if ((event as { reason?: string } | undefined)?.reason === "reload") return;
		try {
			if (dirMade) rmSync(dir, { recursive: true, force: true });
		} catch {
			// a leftover temp dir is not worth a crash on the way out
		}
	});

	/** $EDITOR first, then whichever of these is actually installed. */
	function editorCommand(): string[] | undefined {
		const fromEnv = (process.env.VISUAL || process.env.EDITOR || "").trim();
		if (fromEnv) return fromEnv.split(/\s+/);
		for (const candidate of ["code", "cursor", "subl", "zed"]) {
			const found = spawnSync("command", ["-v", candidate], { shell: true, stdio: "ignore" });
			if (found.status === 0) return [candidate];
		}
		return undefined;
	}

	function openInEditor(ctx: ExtensionContext, item: Item): void {
		try {
			if (!dirMade) {
				mkdirSync(dir, { recursive: true });
				dirMade = true;
			}
			const file = join(dir, item.suggestedName);
			writeFileSync(file, item.text.endsWith("\n") ? item.text : `${item.text}\n`);
			const cmd = editorCommand();
			if (!cmd) return ctx.ui.notify(`Wrote ${file} — set $EDITOR to open it automatically.`, "info");
			// A terminal editor needs this terminal, which pi owns; spawned detached with no TTY it
			// opens nothing while the user is told it did. Hand them the path instead.
			if (TERMINAL_EDITORS.has(cmd[0].split("/").pop() ?? cmd[0])) {
				return ctx.ui.notify(`Wrote ${file} — ${cmd[0]} is a terminal editor, so open it from another shell.`, "info");
			}
			const child = spawn(cmd[0], [...cmd.slice(1), file], { detached: true, stdio: "ignore" });
			child.on("error", () => {
				// a child_process callback: the one continuation here the host does not catch
				try {
					ctx.ui.notify(`Could not run ${cmd[0]}. The content is at ${file}`, "warning");
				} catch {
					// the activation went away first
				}
			});
			child.unref();
			ctx.ui.notify(`${item.label} · ${item.lines} lines → ${cmd[0]}  (${file})`, "info");
		} catch (e) {
			ctx.ui.notify(`Could not open that: ${(e as Error).message}`, "error");
		}
	}

	async function show(ctx: ExtensionContext, item: Item): Promise<void> {
		if (item.lines > OPEN_IN_EDITOR_LINES) return openInEditor(ctx, item);
		const title = `${item.label} · ${item.detail} · ${item.lines} lines`;
		await ctx.ui.custom<void>(
			(_tui, theme, _kb, done) => new Pager(title, item.text.split("\n"), theme, done, item.kind === "diff" ? paintDiff : undefined),
			{},
		);
	}

	/**
	 * While attached to a subagent (fleet.ts), the transcript on screen is that agent's, so /open
	 * lists that agent's artefacts rather than the parent's. fleet publishes a live branch accessor
	 * on the same event the column uses; detaching publishes an empty payload.
	 */
	let attached: { name: string; branch: () => readonly unknown[] } | undefined;
	pi.events.on("statusbar:attached", (data) => {
		const d = data as { name?: string; branch?: () => readonly unknown[] } | undefined;
		attached = d?.name && typeof d.branch === "function" ? { name: d.name, branch: d.branch } : undefined;
	});
	const collect = (ctx: ExtensionContext): Item[] =>
		collectFrom(attached ? attached.branch() : ((ctx.sessionManager?.getBranch?.() ?? []) as unknown[]));
	const whose = () => (attached ? `in ${attached.name}` : "in this session");

	pi.registerCommand("open", {
		description: "Open a tool result or reasoning block from the session you are looking at (the attached agent's, when attached)",
		handler: async (args, ctx) => {
			const items = collect(ctx);
			if (!items.length) return ctx.ui.notify(`Nothing to open yet ${whose()} — no tool results or reasoning.`, "info");

			const arg = args.trim().toLowerCase();
			const filtered = arg
				? items.filter(
						(i) =>
							i.label.toLowerCase().includes(arg) ||
							i.detail.toLowerCase().includes(arg) ||
							i.prompt.toLowerCase().includes(arg) ||
							i.text.toLowerCase().includes(arg),
					)
				: items;
			if (!filtered.length) return ctx.ui.notify(`Nothing matching "${arg}".`, "warning");

			const picked = await ctx.ui.custom<Item | undefined>((tui, theme, _kb, done) => {
				const rows = Math.max(12, Math.min(30, (tui.terminal?.rows ?? 40) - 10));
				return new Picker(filtered, rows, theme, done);
			}, {});
			if (picked) await show(ctx, picked);
		},
	});
}
