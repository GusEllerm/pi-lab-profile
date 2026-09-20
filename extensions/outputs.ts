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

const OPEN_IN_EDITOR_LINES = Number(process.env.PI_OPEN_EDITOR_LINES ?? 40);
const MAX_ENTRIES = 40; // the picker is for finding something recent, not browsing all of history

type Item = {
	kind: "tool" | "thinking" | "bash";
	label: string; // what produced it, for the picker
	detail: string; // the command or file, for the picker
	text: string;
	lines: number;
	suggestedName: string;
	isError?: boolean;
};

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

/** Walk the session and collect everything worth re-reading, newest last. */
function collect(ctx: ExtensionContext): Item[] {
	const items: Item[] = [];
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	let n = 0;
	for (const entry of (ctx.sessionManager?.getBranch?.() ?? []) as { type?: string; message?: any }[]) {
		const m = entry?.message;
		if (entry?.type !== "message" || !m) continue;

		if (m.role === "assistant") {
			for (const part of (m.content ?? []) as any[]) {
				if (part?.type === "toolCall" && part.id) calls.set(part.id, { name: part.name, args: part.arguments ?? {} });
				if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
					const text = part.thinking.trim();
					items.push({
						kind: "thinking",
						label: "reasoning",
						detail: oneLine(text, 60),
						text,
						lines: text.split("\n").length,
						suggestedName: nameFor("thinking", undefined, undefined, ++n),
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
			});
			continue;
		}

		if (m.role === "toolResult") {
			const text = (typeof m.content === "string" ? m.content : ((m.content ?? []) as any[]).map((c) => c?.text ?? "").join("\n")).trim();
			if (!text) continue;
			const call = m.toolCallId ? calls.get(m.toolCallId) : undefined;
			const tool = m.toolName ?? call?.name ?? "tool";
			items.push({
				kind: "tool",
				label: tool,
				detail: oneLine(call?.args ? JSON.stringify(call.args) : text, 60),
				text,
				lines: text.split("\n").length,
				suggestedName: nameFor("tool", tool, call?.args, ++n),
				isError: Boolean(m.isError),
			});
		}
	}
	return items;
}

class Pager implements Component {
	constructor(
		private title: string,
		private lines: string[],
		private theme: Theme,
		private close: () => void,
	) {}
	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(20, width - 4);
		const row = (s: string) => {
			const cell = truncateToWidth(s, inner, "…");
			return t.fg("borderAccent", "│ ") + cell + " ".repeat(Math.max(0, inner - visibleWidth(cell))) + t.fg("borderAccent", " │");
		};
		const head = truncateToWidth(this.title, Math.max(8, width - 12), "…");
		const out = [t.fg("borderAccent", "┌─") + t.fg("accent", ` ${head} `) + t.fg("borderAccent", `${"─".repeat(Math.max(0, width - visibleWidth(head) - 5))}┐`)];
		for (const line of this.lines) out.push(row(line));
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

	pi.on("session_shutdown", () => {
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
			const child = spawn(cmd[0], [...cmd.slice(1), file], { detached: true, stdio: "ignore" });
			child.on("error", () => ctx.ui.notify(`Could not run ${cmd[0]}. The content is at ${file}`, "warning"));
			child.unref();
			ctx.ui.notify(`${item.label} · ${item.lines} lines → ${cmd[0]}  (${file})`, "info");
		} catch (e) {
			ctx.ui.notify(`Could not open that: ${(e as Error).message}`, "error");
		}
	}

	async function show(ctx: ExtensionContext, item: Item): Promise<void> {
		if (item.lines > OPEN_IN_EDITOR_LINES) return openInEditor(ctx, item);
		await ctx.ui.custom<void>((_tui, theme, _kb, done) => new Pager(`${item.label} · ${item.lines} lines`, item.text.split("\n"), theme, done), {});
	}

	pi.registerCommand("open", {
		description: "Open a tool result or reasoning block: short ones in a pager, long ones in $EDITOR",
		handler: async (args, ctx) => {
			const items = collect(ctx);
			if (!items.length) return ctx.ui.notify("Nothing to open yet — no tool results or reasoning in this session.", "info");

			const arg = args.trim().toLowerCase();
			const filtered = arg ? items.filter((i) => i.label.toLowerCase().includes(arg) || i.detail.toLowerCase().includes(arg)) : items;
			if (!filtered.length) return ctx.ui.notify(`Nothing matching "${arg}".`, "warning");

			const recent = filtered.slice(-MAX_ENTRIES).reverse(); // newest first: what you just saw is what you want
			const labels = recent.map((i) => {
				const size = `${i.lines} line${i.lines === 1 ? "" : "s"}`;
				const where = i.lines > OPEN_IN_EDITOR_LINES ? "editor" : "pager";
				return `${(i.isError ? "✗ " : "  ") + i.label.padEnd(10)} ${size.padStart(9)}  ${where.padEnd(6)}  ${i.detail}`;
			});
			const choice = await ctx.ui.select("Open which output?", labels);
			const picked = choice ? recent[labels.indexOf(choice)] : undefined;
			if (picked) await show(ctx, picked);
		},
	});
}
