// The column's arithmetic, kept apart from its drawing: what a session has spent, how fast the
// model is producing, and where the context is heading. Everything here takes data and clocks as
// arguments and is tested without a host; statusbar.ts renders what these report.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPEED_WINDOW_MS = Number(process.env.PI_SPEED_WINDOW_MS ?? 10_000);

// ── usage: summed once per assistant message, not on every render ─────────────────────────────
export type Usage = { prompt: number; cacheRead: number; output: number; calls: number; cost: number; estimated: boolean };
export function sumUsage(ctx: ExtensionContext): Usage {
	const u: Usage = { prompt: 0, cacheRead: 0, output: 0, calls: 0, cost: 0, estimated: false };
	for (const e of ctx.sessionManager.getBranch()) {
		const m = (e as { type: string; message?: any }).message;
		if (e.type !== "message" || m?.role !== "assistant" || !m.usage) continue;
		u.calls++;
		u.prompt += (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
		u.cacheRead += m.usage.cacheRead ?? 0;
		u.output += m.usage.output ?? 0;
		u.cost += m.usage.cost?.total ?? 0;
		// argo.ts fills in prompt tokens the proxy streamed as zero, and says so
		if (m.usage.estimated) u.estimated = true;
	}
	return u;
}

// ── generation speed ──────────────────────────────────────────────────────────────────────────
export type Speed = {
	live?: number; // tokens/s over the window, while streaming
	last?: number; // average tokens/s of the previous reply
	ttftMs?: number; // time to first token of the previous reply
	sessionAvg?: number;
	estimated: boolean; // true when counts came from a chars/4 estimate
	/** The whole reply landed at once (a gateway buffered it): that is delivery speed, not generation. */
	buffered: boolean;
	streaming: boolean;
};

export class SpeedMeter {
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
export function speedText(s: Speed): { text: string; live: boolean } | undefined {
	const tilde = s.estimated ? "~" : "";
	if (s.streaming && s.live !== undefined) return { text: `${tilde}${Math.round(s.live)} tok/s`, live: true };
	if (s.streaming) return { text: "…", live: true };
	if (s.last !== undefined) return { text: `last ${s.buffered ? "~" : ""}${Math.round(s.last)} tok/s`, live: false };
	return undefined;
}


/**
 * A minute of context-usage samples, for the trajectory under CONTEXT.
 *
 * At 92% the level is not the interesting number -- the slope is. One sample a second for sixty
 * seconds is enough to draw a shape and estimate a burn rate, and small enough that nothing needs
 * to think about it. Sampled from the column's own once-a-second cache miss rather than on a timer,
 * so it cannot outlive the activation.
 */
const SPARK = "▁▂▃▄▅▆▇█";
export class ContextTrail {
	private samples: { at: number; used: number }[] = [];

	sample(used: number): void {
		const now = Date.now();
		const last = this.samples[this.samples.length - 1];
		if (last && now - last.at < 900) return;
		// Age-based, not count-based: samples are only taken on frames the column actually draws, so
		// after an idle stretch a count-limited ring would average this burst against samples from
		// hours ago and report a rate and a countdown that describe the gap, not the present.
		while (this.samples.length && now - this.samples[0].at > 60_000) this.samples.shift();
		this.samples.push({ at: now, used });
		if (this.samples.length > 60) this.samples.shift();
	}

	/** Tokens per minute over the window, or undefined until there is enough to divide by. */
	rate(): number | undefined {
		const [first] = this.samples;
		const last = this.samples[this.samples.length - 1];
		if (!first || !last || last.at - first.at < 5000) return undefined;
		const perMs = (last.used - first.used) / (last.at - first.at);
		return perMs > 0 ? perMs * 60_000 : undefined;
	}

	/**
	 * Normalised to the window's own min and max, not to the context size: at 92% every bar would
	 * otherwise be full, which is exactly when the shape matters most.
	 */
	spark(width: number): string {
		if (this.samples.length < 3 || width < 4) return "";
		const points = this.samples.slice(-width);
		const values = points.map((p) => p.used);
		const low = Math.min(...values);
		const high = Math.max(...values);
		const span = high - low;
		return points
			.map((p) => SPARK[span === 0 ? 0 : Math.min(7, Math.floor(((p.used - low) / span) * 7.999))])
			.join("");
	}
}
