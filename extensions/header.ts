/**
 * header — the startup header, from a file you edit.
 *
 * Pi lets an extension replace the header with ctx.ui.setHeader(factory). This one renders it
 * from JSON, so changing what the session opens with is an edit, not a code change:
 *
 *   <cwd>/.pi/header.json         a project's own (a demo directory, say), else
 *   <agent-dir>/header.json       yours, for every session
 *
 * With neither, nothing is replaced and Pi's (or pi-cc's) header shows as before.
 *
 *   {
 *     "art":   ["██████  ", "██  ██  "],          // optional, drawn in the left column
 *     "artStyle": "accent",                       // any theme colour
 *     "lines": [
 *       "{bold:{accent:pi}} {dim:v{version}}",   // {style:text}, nestable
 *       "{hints}",                                // Pi's key hints, from your keybindings
 *       "{muted:model} {model} {muted:via} {endpoint}"
 *     ]
 *   }
 *
 * Styles are the theme's colour names (accent, muted, dim, text, success, warning, error, mdLink,
 * …), `#rrggbb`, and bold and italic. `artColors` colours the art row by row (a gradient down a
 * wordmark), and `"layout": "stacked"` puts wide art above the lines instead of beside them. Values: {version} {model} {provider} {endpoint} {thinking} {cwd}
 * {branch} {user} {host} {date} {hints}. \{ and \} are literal braces ("\\{" in a JSON string).
 *
 * pi-cc-extensions draws its own header and sets it after this one, so it must be off
 * ("showStartupHeader": false in <agent-dir>/pi-cc-extensions.json); measured on Pi 1.1.0, the
 * replacement is then in place from the first frame, with no flash of another header.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { agentDir } from "./lib/paths.ts";
import { lifecycle } from "./lib/lifecycle.ts";
import { endpointLabels as endpointLabelMap } from "./lib/bus.ts";

export type HeaderConfig = {
	art?: string[];
	/** one theme colour for the whole art */
	artStyle?: string;
	/** per-row colours, `#rrggbb` or theme names; the last repeats -- a gradient down a wordmark */
	artColors?: string[];
	/** "beside": art left of the lines (narrow terminals stack); "stacked": art above, always */
	layout?: "beside" | "stacked";
	lines?: string[];
	gap?: number;
};
export type Values = Record<string, string>;
type Style = { fg(name: string, text: string): string; bold(text: string): string; italic?(text: string): string };

/** The project's header file if it has one, else the user's; undefined when neither exists. */
export function headerPath(cwd: string, dir = agentDir()): string | undefined {
	for (const file of [join(cwd, ".pi", "header.json"), join(dir, "header.json")]) if (existsSync(file)) return file;
	return undefined;
}

/** Parse and check a header file; the error says what to fix. */
export function readHeader(file: string): { config?: HeaderConfig; error?: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		return { error: `${file}: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${file}: expected an object with "lines" and optionally "art"` };
	const c = raw as Record<string, unknown>;
	const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
	if (c.lines !== undefined && !strings(c.lines)) return { error: `${file}: "lines" must be an array of strings` };
	if (c.art !== undefined && !strings(c.art)) return { error: `${file}: "art" must be an array of strings` };
	if (c.artStyle !== undefined && typeof c.artStyle !== "string") return { error: `${file}: "artStyle" must be a theme colour name` };
	if (c.gap !== undefined && (typeof c.gap !== "number" || c.gap < 0)) return { error: `${file}: "gap" must be a number of columns` };
	if (c.artColors !== undefined && !strings(c.artColors)) return { error: `${file}: "artColors" must be an array of #rrggbb or theme colour names` };
	if (c.layout !== undefined && c.layout !== "beside" && c.layout !== "stacked") return { error: `${file}: "layout" must be "beside" or "stacked"` };
	return { config: c as HeaderConfig };
}

/** `#rrggbb` as a 24-bit foreground colour; the reset is the default-foreground code, so it nests. */
export function hexColor(hex: string, text: string): string | undefined {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) return undefined;
	return `\x1b[38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}m${text}\x1b[39m`;
}

/** A colour that is either `#rrggbb` or a theme name; unknown names draw plain. */
const colour = (theme: Style, name: string, text: string): string => {
	const hex = hexColor(name, text);
	if (hex !== undefined) return hex;
	try {
		return theme.fg(name, text);
	} catch {
		return text;
	}
};

/**
 * The markup: `{style:text}` styles its text (nestable), `{name}` is a value, `\{` and `\}` are
 * braces (a backslash, not doubled braces: `{bold:{accent:pi}}` must close two spans). An unknown style draws the text plain and an unknown value is left as written, so a
 * typo shows up where it is rather than blanking the header.
 */
export function renderMarkup(src: string, values: Values, theme: Style): string {
	let i = 0;
	const apply = (style: string, text: string): string => {
		if (style === "bold") return theme.bold(text);
		if (style === "italic") return theme.italic ? theme.italic(text) : text;
		return colour(theme, style, text);
	};
	const parse = (inner: boolean): string => {
		let out = "";
		while (i < src.length) {
			const ch = src[i];
			if (ch === "\\" && (src[i + 1] === "{" || src[i + 1] === "}" || src[i + 1] === "\\")) {
				out += src[i + 1];
				i += 2;
			} else if (ch === "}" && inner) {
				i++;
				return out;
			} else if (ch === "{") {
				const m = /^\{([A-Za-z][\w-]*|#[0-9a-fA-F]{6})(:|\})/.exec(src.slice(i));
				if (!m) {
					out += ch;
					i++;
				} else if (m[2] === "}") {
					i += m[0].length;
					out += values[m[1]] ?? `{${m[1]}}`;
				} else {
					i += m[0].length;
					out += apply(m[1], parse(true));
				}
			} else {
				out += ch;
				i++;
			}
		}
		return out;
	};
	return parse(false);
}

/**
 * The header's rows at a width. "beside" puts the art left of the lines and stacks them on a
 * narrow terminal; "stacked" always puts the art on top. Art wider than the terminal is left out
 * rather than cut mid-letter, so a wordmark never reads as garbage -- the lines still show.
 */
export function layout(config: HeaderConfig, values: Values, theme: Style, width: number): string[] {
	const lines = (config.lines ?? []).map((l) => renderMarkup(l, values, theme));
	const artWidth = Math.max(0, ...(config.art ?? []).map((l) => visibleWidth(l)));
	const art = artWidth <= width ? (config.art ?? []) : [];
	const colours = config.artColors?.length ? config.artColors : undefined;
	const paint = (l: string, row: number) => colour(theme, colours ? colours[Math.min(row, colours.length - 1)] : (config.artStyle ?? "accent"), l);
	const gap = config.gap ?? 2;
	const fit = (l: string) => truncateToWidth(l, Math.max(1, width), "");
	if (!art.length) return ["", ...lines, ""].map(fit);
	if (config.layout === "stacked" || width < artWidth + gap + 24)
		return ["", ...art.map(paint), ...(lines.length ? ["", ...lines] : []), ""].map(fit);
	const rows = Math.max(art.length, lines.length);
	const top = Math.floor((rows - art.length) / 2);
	const out: string[] = [""];
	for (let r = 0; r < rows; r++) {
		const a = art[r - top] ?? "";
		const left = a ? paint(a, r - top) + " ".repeat(Math.max(0, artWidth - visibleWidth(a))) : " ".repeat(artWidth);
		out.push(fit(`${left}${" ".repeat(gap)}${lines[r] ?? ""}`));
	}
	out.push("");
	return out;
}

/** Pi's compact key hints, from the bindings in use (as Pi's own header and pi-cc's draw them). */
export function hintsLine(theme: Style): string {
	const key = (id: string): string => {
		try {
			const keys = getKeybindings().getKeys(id as never) as string[];
			return keys.join("/").replace(/\balt\b/g, process.platform === "darwin" ? "option" : "alt");
		} catch {
			return "";
		}
	};
	const hint = (k: string, what: string) => (k ? `${theme.fg("dim", k)}${theme.fg("muted", ` ${what}`)}` : "");
	return [
		hint(key("app.interrupt") || "escape", "interrupt"),
		hint([key("app.clear"), key("app.exit")].filter(Boolean).join("/") || "ctrl+c/ctrl+d", "clear/exit"),
		hint("/", "commands"),
		hint("!", "bash"),
		hint(key("app.tools.expand") || "ctrl+o", "more"),
	]
		.filter(Boolean)
		.join(theme.fg("muted", " · "));
}

/** The git branch of `cwd`, read from .git/HEAD once (no subprocess); "" outside a repository. */
export function gitBranch(cwd: string): string {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const head = join(dir, ".git", "HEAD");
		if (existsSync(head)) {
			try {
				const ref = readFileSync(head, "utf8").trim();
				return ref.startsWith("ref: refs/heads/") ? ref.slice(16) : ref.slice(0, 7);
			} catch {
				return "";
			}
		}
		if (dirname(dir) === dir) return "";
	}
}

/** The starter written by /header init: today's header, made editable. */
export const STARTER: HeaderConfig = {
	art: ["██████  ", "██  ██  ", "████  ██", "██    ██"],
	artStyle: "accent",
	lines: [
		"{bold:{accent:pi}} {dim:v{version}}",
		"{hints}",
		"{muted:model} {model} {muted:via} {endpoint}",
		"",
		"{accent:There are many agent harnesses, but this one is {bold:{mdLink:yours}}.}",
	],
};

export default function (pi: ExtensionAPI): void {
	const life = lifecycle(pi);
	let ctxRef: ExtensionContext | undefined;
	let config: HeaderConfig | undefined;
	let source: string | undefined;
	let problem: string | undefined;
	let branch = "";
	const labels = endpointLabelMap(pi);

	const values = (theme: Style): Values => {
		const m = ctxRef?.model as { id?: string; provider?: string } | undefined;
		const cwd = process.cwd();
		let thinking = "";
		try {
			thinking = pi.getThinkingLevel?.() ?? "";
		} catch {
			thinking = "";
		}
		return {
			version: VERSION,
			model: m?.id ?? "no model",
			provider: m?.provider ?? "",
			endpoint: (m?.provider && labels.get(m.provider)) || m?.provider || "",
			thinking,
			cwd: cwd.startsWith(homedir()) ? `~${cwd.slice(homedir().length)}` : cwd,
			branch,
			user: (() => {
				try {
					return userInfo().username;
				} catch {
					return "";
				}
			})(),
			host: hostname().replace(/\.local$/, ""),
			date: new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
			hints: hintsLine(theme),
		};
	};

	const load = (cwd: string) => {
		source = headerPath(cwd);
		config = undefined;
		problem = undefined;
		if (!source) return;
		const r = readHeader(source);
		config = r.config;
		problem = r.error;
	};

	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!config) return; // nothing to show: leave Pi's or pi-cc's header alone
		const cfg = config;
		let cache: { key: string; rows: string[] } | undefined;
		ctx.ui.setHeader((_tui, theme: Theme) => ({
			render(width: number): string[] {
				// the header draws every frame; the rows change only with the width or the model
				const m = ctxRef?.model as { id?: string; provider?: string } | undefined;
				const key = `${width}|${m?.provider}/${m?.id}|${labels.get(m?.provider ?? "") ?? ""}`;
				if (cache?.key === key) return cache.rows;
				let rows: string[];
				try {
					rows = layout(cfg, values(theme), theme, width);
				} catch {
					rows = [""];
				}
				cache = { key, rows };
				return rows;
			},
			invalidate() {
				cache = undefined;
			},
		}));
	};

	/** pi-cc's own header is set after this one and would win; say so once. */
	const piccHeaderOn = (): boolean => {
		const file = join(agentDir(), "pi-cc-extensions.json");
		if (!existsSync(file)) return false;
		try {
			return (JSON.parse(readFileSync(file, "utf8")) as { showStartupHeader?: boolean }).showStartupHeader !== false;
		} catch {
			return false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		branch = gitBranch(process.cwd());
		load(process.cwd());
		install(ctx);
		if (!ctx.hasUI) return;
		if (problem) ctx.ui.notify(`header: ${problem} — the built-in header is shown instead`, "warning");
		else if (config && piccHeaderOn())
			ctx.ui.notify(`header: pi-cc's own header is on and replaces this one — set "showStartupHeader": false in ${join(agentDir(), "pi-cc-extensions.json")}`, "warning");
	});
	pi.on("model_select", (_event, ctx) => {
		ctxRef = ctx;
	});

	pi.registerCommand("header", {
		description: "The startup header: /header (status) · /header reload · /header init (write a starter to edit) · /header off",
		handler: async (args, ctx) => {
			if (life.dead()) return;
			const verb = args.trim().toLowerCase();
			if (verb === "reload") {
				load(process.cwd());
				if (problem) return ctx.ui.notify(`header: ${problem}`, "error");
				if (!config) return ctx.ui.notify("header: no header.json — /header init writes one to edit", "warning");
				install(ctx);
				return ctx.ui.notify(`header: reloaded from ${source}`, "info");
			}
			if (verb === "init") {
				const file = join(agentDir(), "header.json");
				if (existsSync(file)) return ctx.ui.notify(`header: ${file} already exists — edit it, then /header reload`, "warning");
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, `${JSON.stringify(STARTER, null, 2)}\n`);
				load(process.cwd());
				install(ctx);
				return ctx.ui.notify(`header: wrote ${file} — edit it, then /header reload`, "info");
			}
			if (verb === "off") {
				ctx.ui.setHeader(undefined);
				return ctx.ui.notify("header: built-in header for this session (/header reload brings yours back)", "info");
			}
			const lines = [
				source ? `from ${source}${problem ? ` — ${problem}` : ""}` : "no header.json: the built-in header is showing",
				`edit ${join(agentDir(), "header.json")} (or a project's .pi/header.json), then /header reload`,
				"styles: {accent:…} {muted:…} {dim:…} {bold:…} {mdLink:…} — any theme colour; values: {version} {model} {endpoint} {thinking} {cwd} {branch} {user} {host} {date} {hints}; \\{ \\} for literal braces",
				...(piccHeaderOn() ? [`! pi-cc's header is on and wins: "showStartupHeader": false in pi-cc-extensions.json`] : []),
			];
			ctx.ui.notify(lines.join("\n"), problem ? "warning" : "info");
		},
	});
}
