/**
 * code-panels — render fenced code blocks as tinted panels instead of literal ``` fences.
 *
 * Pi's Markdown renderer hard-codes the fence lines (pi-tui components/markdown.js, `case "code"`),
 * and markdown transformers run before rendering, so they cannot remove them. This wraps
 * Markdown.prototype.renderToken for code tokens only and leaves every other token untouched.
 *
 * Output per block: a panel header carrying the language label, then the syntax-highlighted code
 * with a one-column inset, each line padded to full width on a theme background. The tint is a
 * background color, not gutter characters, so copying a selection yields clean code.
 *
 * Display-only: the session and model context keep the original Markdown.
 * Written against Pi 0.85.1; if a Pi update changes renderToken, the guard below falls back to
 * Pi's own rendering rather than breaking the transcript.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Tweak here. Backgrounds: selectedBg | userMessageBg | customMessageBg | toolPendingBg | toolSuccessBg
const PANEL_BG = "toolPendingBg" as const;
const INSET = " ";
const SHOW_LANGUAGE_LABEL = true;

const PATCHED = Symbol.for("code-panels.patched");
// Global so a /reload's fresh module instance feeds the already-installed patch.
const THEME_SLOT = Symbol.for("code-panels.theme");
const slot = globalThis as { [THEME_SLOT]?: () => Theme | undefined };

function renderPanel(token: { text: string; lang?: string }, width: number, theme: Theme): string[] {
	const bgAnsi = theme.getBgAnsi(PANEL_BG);
	// Highlighters and theme.fg emit resets; re-arm the background after any that would clear it.
	const keepBg = (s: string) => s.replace(/\x1b\[(?:0|49)?m/g, (m) => m + bgAnsi);
	const fill = (s: string) => {
		const pad = Math.max(0, width - visibleWidth(s));
		return `${bgAnsi}${keepBg(s)}${" ".repeat(pad)}\x1b[49m`;
	};

	const lang = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
	const lines: string[] = [];
	lines.push(fill(SHOW_LANGUAGE_LABEL && lang ? theme.fg("mdCodeBlockBorder", `${INSET}${lang}`) : ""));

	const inner = Math.max(1, width - INSET.length * 2);
	for (const codeLine of highlightCode(token.text, lang || undefined)) {
		const wrapped = codeLine.length === 0 ? [""] : wrapTextWithAnsi(codeLine, inner);
		for (const piece of wrapped) lines.push(fill(`${INSET}${piece}`));
	}
	lines.push(fill(""));
	return lines;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const ui = ctx.ui;
		// Read lazily so /theme switches apply; non-TUI modes may have no theme.
		slot[THEME_SLOT] = () => {
			try {
				return ui.theme;
			} catch {
				return undefined;
			}
		};
	});

	const proto = Markdown.prototype as unknown as {
		renderToken: (token: any, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
		[PATCHED]?: boolean;
	};
	if (proto[PATCHED] || typeof proto.renderToken !== "function") return; // /reload safety, API drift
	const original = proto.renderToken;

	proto.renderToken = function (token, width, nextTokenType, styleContext) {
		const theme = slot[THEME_SLOT]?.();
		if (token?.type !== "code" || typeof token.text !== "string" || !theme) {
			return original.call(this, token, width, nextTokenType, styleContext);
		}
		try {
			const lines = renderPanel(token, width, theme);
			if (nextTokenType && nextTokenType !== "space") lines.push("");
			return lines;
		} catch {
			return original.call(this, token, width, nextTokenType, styleContext);
		}
	};
	proto[PATCHED] = true;
}
