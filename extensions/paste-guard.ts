/**
 * paste-guard — text that arrives faster than a hand can type is a paste, and goes into the
 * editor whole instead of being submitted line by line.
 *
 * Pi's editor relies on the terminal wrapping a paste in \x1b[200~ … \x1b[201~. Without the
 * markers the first carriage return submits what came before it and every later line goes to the
 * model as its own prompt -- upstream issues #7321 (Termux) and #2376 (tmux with extended-keys),
 * and what happened here on 23 Sept 2026 with a transcript pasted into a session. Measured that
 * day: with the markers the whole stack (pi-cc's editor, this profile) keeps a paste in the
 * editor, so the markers had not arrived; and Pi hands extensions the input one key at a time,
 * so a chunk can never be recognised as a paste by its shape. What is left is timing, the
 * heuristic proposed in #7321: three keys inside BURST_MS is a paste. From then on keys are
 * held back (carriage returns become newlines) until QUIET_MS pass without one, and the whole
 * burst is appended to the editor. The first two keys were typed before the burst was known;
 * they are already in the editor, so only what follows is held. A paste whose first line is two
 * characters long can still submit early -- the price of having no marker.
 *
 * Escape sequences (arrows, mouse reports, real bracketed pastes) are never held; they end a burst.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BURST_MS = 80;
export const QUIET_MS = 60;

/** The burst detector, clock supplied, so the timing can be tested without waiting. */
export class PasteBurst {
	private recent: number[] = [];
	private held: string | undefined;
	private burstMs: number;

	constructor(burstMs = BURST_MS) {
		this.burstMs = burstMs;
	}

	/** True while keys are being held back. */
	get holding(): boolean {
		return this.held !== undefined;
	}

	/** Feed one input event; returns true when it was held (and must be consumed). */
	feed(data: string, now: number): boolean {
		if (!data || data.includes("\x1b")) {
			this.recent = [];
			return false;
		}
		this.recent = this.recent.filter((t) => now - t < this.burstMs);
		this.recent.push(now);
		if (this.held === undefined && this.recent.length < 3) return false;
		this.held = (this.held ?? "") + data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		return true;
	}

	/** Everything held since the burst began, and forget it. */
	flush(): string | undefined {
		const text = this.held;
		this.held = undefined;
		this.recent = [];
		return text;
	}
}

export default function (pi: ExtensionAPI): void {
	let off: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	pi.on("session_start", (_event, ctx) => {
		off?.();
		off = undefined;
		if (!ctx.hasUI) return;
		const burst = new PasteBurst();
		let explained = false;
		const flush = () => {
			timer = undefined;
			const text = burst.flush();
			if (!text) return;
			ctx.ui.setEditorText(ctx.ui.getEditorText() + text);
			// once a session: a multi-line burst means the terminal sent no markers, which is a setting
			if (!explained && text.includes("\n")) {
				explained = true;
				ctx.ui.notify("paste-guard: that paste arrived without bracketed-paste markers, so it was reassembled from keystrokes. In iTerm2 check Profiles › Terminal › “Terminal may enable paste bracketing”; in tmux see pi issue #2376.", "info");
			}
			// Pi renders after input, not after a timer: setting the editor from here draws nothing until
			// the next key. A status write is the one API an extension has that asks for a frame.
			ctx.ui.setStatus("paste-guard", "");
			ctx.ui.setStatus("paste-guard", undefined);
		};
		off = ctx.ui.onTerminalInput((data) => {
			const heldBefore = burst.holding;
			const held = burst.feed(data, Date.now());
			if (heldBefore && !held) flush(); // an escape sequence ends the burst; put the text back first
			if (!held) return undefined;
			if (timer) clearTimeout(timer);
			timer = setTimeout(flush, QUIET_MS);
			return { consume: true };
		});
	});
	pi.on("session_shutdown", () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		off?.();
		off = undefined;
	});
}
