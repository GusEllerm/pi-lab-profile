/**
 * argo — Argonne's Argo LLM gateway as Pi providers, through argo-tools' SSH tunnel.
 *
 * argo-tools (github.com/GusEllerm/argo-tools) runs argo-proxy on a CELS home node and forwards its
 * port here: `localhost:<port>` then speaks both the OpenAI and Anthropic APIs, authenticating by
 * ANL username rather than a secret. This extension turns what that endpoint serves into Pi models:
 *
 *   argo/<claude-…>          Claude, over the Anthropic messages API (thinking levels survive)
 *   argo-openai/<gpt-…|gemini-…>   everything else, over chat completions
 *
 * Two providers because the two APIs disagree about baseUrl: Anthropic clients append /v1/messages
 * to a bare host; OpenAI clients append /chat/completions to a /v1 base.
 *
 * Spend. Claude models carry argo-dash's price table (read from the installed argo-dash when it is
 * on PATH, else the copy below), so Pi's own per-turn cost is the dash's "list $" for the same
 * tokens. One catch, measured: argo-proxy streams `message_start` with input and cache tokens
 * zeroed (only the non-streaming reply carries them), and Pi streams -- so an Argo Claude turn
 * arrives with input 0. Left alone that breaks more than the price: Pi's context gauge and its
 * auto-compaction trust that number. The message_end hook below fills it with Pi's own estimate
 * (chars/4) and marks the usage `estimated`, which the column shows as ≈. /argo spend shows the
 * dash's figures, which come from the proxy log and are exact.
 *
 * The tunnel is deliberately manual. argo-up needs a Duo push the first time (a real prompt, read
 * from the controlling terminal), and argo-down exists so that nothing on this machine can reach
 * Argo until you say so. This extension never brings the tunnel up on its own. /argo on runs
 * argo-up inside a pseudo-terminal it owns, relays its output into the chat, and turns the Duo
 * prompt into a Pi input dialog -- you type 1, approve the push on your phone, and the models
 * register when the chain is up. /argo down runs argo-down and unregisters them.
 *
 * Argo is metered, and argo-proxy can log every request body in plaintext on a shared node. While
 * the session model is on Argo, endpoints.ts shows the ENDPOINT row as "⚡ argo" in a warning
 * colour, on purpose.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Pager } from "./outputs.ts";

export type ArgoConfig = { user: string; port: number; file: string };

/** argo-setup writes KEY=VALUE lines; ANL_USER and ARGO_PORT are the two this needs. */
export function readArgoConfig(file = join(homedir(), ".config", "argo-tools", "config")): ArgoConfig | undefined {
	if (!existsSync(file)) return undefined;
	const vars: Record<string, string> = {};
	for (const raw of readFileSync(file, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["'](.*)["']$/, "$1");
	}
	if (!vars.ANL_USER) return undefined;
	const port = Number(vars.ARGO_PORT) || 44497;
	return { user: vars.ANL_USER, port, file };
}

export type Family = "claude" | "openai" | "gemini" | "other";
export const family = (id: string): Family =>
	id.startsWith("claude") ? "claude" : /^(gpt|o\d)/.test(id) ? "openai" : id.startsWith("gemini") ? "gemini" : "other";

/**
 * Argo's ids, made canonical: the `argo:` prefix goes; `[test]`, embedding and reranker models are
 * not chat models and go too; Claude ids get dots as dashes and their two alias orders folded
 * (`claude-4.8-opus` and `claude-opus-4.8` are the same model listed twice). Same rules as
 * argo-claude's, so the two tools name a model identically.
 */
export function canonical(raw: string): string | undefined {
	let id = raw.replace(/^argo:/, "").trim();
	if (!id || /\[test\]|embedding|reranker/i.test(id)) return undefined;
	if (id.startsWith("claude")) {
		id = id.replace(/\./g, "-");
		const m = /^claude-(\d[\d-]*)-(opus|sonnet|haiku|fable)$/.exec(id);
		if (m) id = `claude-${m[2]}-${m[1]}`;
	}
	return id;
}

export function dedupe(raw: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of raw) {
		const id = canonical(r);
		if (id && !seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	return out;
}

/** Frontier first, so /model opens on the models worth reaching for; the rest alphabetically. */
export const PREFERRED = [
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-5",
	"claude-sonnet-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
	"gpt-5.6-sol",
	"gpt-5.6-luna",
	"gpt-5.6-terra",
	"gpt-5.5",
	"gpt-5.4",
	"gemini-3.5-flash",
	"gemini-2.5-pro",
];
export function order(ids: string[]): string[] {
	const rank = new Map(PREFERRED.map((id, i) => [id, i]));
	return [...ids].sort((a, b) => {
		const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
		const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
		return ra !== rb ? ra - rb : a.localeCompare(b);
	});
}

// ── pricing: argo-dash's table, so a turn costs the same here as on the dash ──────────────────
export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type Pricing = {
	/** canonical Claude id → (input, output) USD per million tokens, Anthropic first-party list */
	rates: Record<string, [number, number]>;
	/** id → (input, output, last day inclusive) */
	promos: Record<string, [number, number, string]>;
	/** cached tokens as multiples of the input rate; Pi prices 1h writes at 2× on its own */
	cache: { read: number; w5m: number };
	verified: string;
	source: "argo-dash" | "bundled";
};

/**
 * argo-dash's table as of its PRICING_VERIFIED date. The dash is the authority: when it is on PATH
 * its live table replaces this one, so a re-verification there reaches Pi without a copy here.
 * Only Claude is priced, as on the dash; other families show no dollars rather than a guess.
 */
export const BUNDLED_PRICING: Pricing = {
	rates: {
		"claude-fable-5": [10, 50],
		"claude-mythos-5": [10, 50],
		"claude-opus-5": [5, 25],
		"claude-opus-4-8": [5, 25],
		"claude-opus-4-7": [5, 25],
		"claude-opus-4-6": [5, 25],
		"claude-opus-4-5": [5, 25],
		"claude-opus-4-1": [15, 75],
		"claude-sonnet-5": [3, 15],
		"claude-sonnet-4-6": [3, 15],
		"claude-sonnet-4-5": [3, 15],
		"claude-haiku-4-5": [1, 5],
	},
	promos: { "claude-sonnet-5": [2, 10, "2026-08-31"] },
	cache: { read: 0.1, w5m: 1.25 },
	verified: "2026-07-30",
	source: "bundled",
};

/** Runs inside python3 with argo-dash's path as argv[1]: import the script as a module, print its table. */
export const PRICING_DUMP = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("argo_dash", sys.argv[1])
spec = importlib.util.spec_from_loader("argo_dash", loader)
m = importlib.util.module_from_spec(spec)
loader.exec_module(m)
print(json.dumps({"rates": m.PRICING, "promos": m.PROMOS, "cache": m.CACHE_MULTIPLIER, "verified": m.PRICING_VERIFIED}))
`;

/** Validate a dump; anything malformed is rejected whole rather than half-applied. */
export function parsePricing(json: string): Pricing | undefined {
	try {
		const d = JSON.parse(json) as { rates?: unknown; promos?: unknown; cache?: unknown; verified?: unknown };
		const pair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number";
		if (!d.rates || typeof d.rates !== "object" || !Object.values(d.rates).every(pair)) return undefined;
		const promos: Record<string, [number, number, string]> = {};
		for (const [id, v] of Object.entries((d.promos ?? {}) as Record<string, unknown>)) {
			if (!pair(v) || typeof v[2] !== "string") return undefined;
			promos[id] = [v[0], v[1], v[2]];
		}
		const cache = d.cache as { read?: unknown; w5m?: unknown } | undefined;
		if (typeof cache?.read !== "number" || typeof cache?.w5m !== "number") return undefined;
		if (typeof d.verified !== "string") return undefined;
		return { rates: d.rates as Pricing["rates"], promos, cache: { read: cache.read, w5m: cache.w5m }, verified: d.verified, source: "argo-dash" };
	} catch {
		return undefined;
	}
}

export function findOnPath(name: string, path = process.env.PATH ?? ""): string | undefined {
	for (const dir of path.split(":")) {
		if (!dir) continue;
		const file = join(dir, name);
		if (existsSync(file)) return file;
	}
	return undefined;
}

/** The installed argo-dash's table, or the bundled one when the dash is absent or fails to import. */
export async function loadPricing(dash = findOnPath("argo-dash")): Promise<Pricing> {
	if (!dash) return BUNDLED_PRICING;
	return new Promise((resolve) => {
		const proc = spawn("python3", ["-c", PRICING_DUMP, dash], { stdio: ["ignore", "pipe", "ignore"], env: process.env });
		let out = "";
		const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
		proc.stdout?.on("data", (d) => (out += d));
		proc.on("error", () => resolve(BUNDLED_PRICING));
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve((code === 0 && parsePricing(out)) || BUNDLED_PRICING);
		});
	});
}

/** argo-dash's canon_model: dots to dashes, a -YYYYMMDD suffix dropped, alias order folded. */
export function ratesFor(id: string, pricing: Pricing, today = new Date()): Rates | undefined {
	const key = canonical(id.replace(/-\d{8}$/, ""));
	if (!key) return undefined;
	let pair = pricing.rates[key];
	if (!pair) return undefined;
	const promo = pricing.promos[key];
	if (promo && today.toISOString().slice(0, 10) <= promo[2]) pair = [promo[0], promo[1]];
	const [input, output] = pair;
	// rounded to a tenth of a cent per million: 3 × 0.1 is 0.30000000000000004 in floating point
	const cents = (v: number) => Math.round(v * 1000) / 1000;
	return { input, output, cacheRead: cents(input * pricing.cache.read), cacheWrite: cents(input * pricing.cache.w5m) };
}

type ModelDef = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: Rates;
};
const FREE: Rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Conservative metadata per family; unknown ids still register, with the family's defaults. */
export function modelDef(id: string, pricing?: Pricing): ModelDef {
	switch (family(id)) {
		case "claude":
			return { id, name: id, reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_000, cost: (pricing && ratesFor(id, pricing)) ?? FREE };
		case "openai": {
			const reasoning = /^(o\d|gpt-5)/.test(id);
			return { id, name: id, reasoning, input: ["text", "image"], contextWindow: reasoning ? 400_000 : 128_000, maxTokens: reasoning ? 32_000 : 16_000, cost: FREE };
		}
		case "gemini":
			return { id, name: id, reasoning: /pro|3\./.test(id), input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 65_000, cost: FREE };
		default:
			return { id, name: id, reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 8_000, cost: FREE };
	}
}

/** The two provider configs Pi needs, from a canonical id list. */
export function providers(ids: string[], cfg: { user: string; port: number }, pricing?: Pricing) {
	const base = `http://127.0.0.1:${cfg.port}`;
	const claude = ids.filter((id) => family(id) === "claude").map((id) => modelDef(id, pricing));
	const rest = ids.filter((id) => family(id) !== "claude").map((id) => modelDef(id));
	const compat = { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", supportsStrictMode: false };
	return {
		argo: { name: "Argo · Anthropic API via argo-tools", baseUrl: base, api: "anthropic-messages", apiKey: cfg.user, models: claude },
		"argo-openai": { name: "Argo · OpenAI-compatible via argo-tools", baseUrl: `${base}/v1`, api: "openai-completions", apiKey: cfg.user, authHeader: true, compat, models: rest },
	} as const;
}

// ── the input half of an Argo Claude turn, which the proxy streams as zero ───────────────────
const CHARS_PER_TOKEN = 4;
const IMAGE_CHARS = 4800;

type Block = { type?: string; text?: string; thinking?: string; arguments?: unknown; content?: unknown };
type Msg = { role?: string; content?: unknown; timestamp?: number };

/** Pi's own heuristic (chars/4, a flat 4800 chars per image) over what a request carried. */
export function estimateTokens(messages: Msg[], systemPrompt = ""): number {
	let chars = systemPrompt.length;
	const blocks = (content: unknown): number => {
		if (typeof content === "string") return content.length;
		if (!Array.isArray(content)) return content == null ? 0 : JSON.stringify(content).length;
		let n = 0;
		for (const b of content as Block[]) {
			if (b.type === "image") n += IMAGE_CHARS;
			else if (typeof b.text === "string") n += b.text.length;
			else if (typeof b.thinking === "string") n += b.thinking.length;
			else if (b.type === "toolCall") n += JSON.stringify(b.arguments ?? {}).length + 20;
			else if (b.content !== undefined) n += blocks(b.content);
			else n += JSON.stringify(b).length;
		}
		return n;
	};
	for (const m of messages) chars += blocks(m.content);
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export type Usage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	/** set here when the input count is Pi's estimate rather than the provider's */
	estimated?: boolean;
};

/**
 * An Argo Claude message whose prompt tokens came back as zero gets Pi's estimate in their place,
 * priced at the input rate (Argo's log shows almost no cache reads through Vertex, so that is the
 * rate the dash would apply too), and is marked. Anything the proxy did report is left alone.
 */
export function repairUsage(usage: Usage | undefined, promptTokens: number, rates: Rates | undefined): Usage | undefined {
	if (!usage || (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0) return undefined;
	const output = usage.output ?? 0;
	const cost = usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const input = rates ? (rates.input / 1e6) * promptTokens : cost.input;
	return {
		...usage,
		input: promptTokens,
		totalTokens: promptTokens + output,
		estimated: true,
		cost: { ...cost, input, total: input + cost.output + cost.cacheRead + cost.cacheWrite },
	};
}

/** What this session has spent through Argo: Pi's per-message cost, summed over the branch. */
export function sessionSpend(entries: { type?: string; message?: { role?: string; provider?: string; usage?: Usage } }[]): { turns: number; cost: number; estimated: boolean; unpriced: number } {
	const s = { turns: 0, cost: 0, estimated: false, unpriced: 0 };
	for (const e of entries) {
		const m = e.message;
		if (e.type !== "message" || m?.role !== "assistant" || !m.usage) continue;
		if (m.provider !== "argo" && m.provider !== "argo-openai") continue;
		s.turns++;
		s.cost += m.usage.cost?.total ?? 0;
		if (m.usage.estimated) s.estimated = true;
		if (m.provider === "argo-openai") s.unpriced++;
	}
	return s;
}

/**
 * Does the tail of a pseudo-terminal's output look like something waiting for the user? A prompt is
 * a line with no newline after it that asks for a passcode, an option, a password, or ends in a
 * colon or question mark. Duo's reads "Passcode or option (1-3): ".
 */
export function looksLikePrompt(buffer: string): string | undefined {
	if (buffer.endsWith("\n")) return undefined;
	const tail = buffer.slice(buffer.lastIndexOf("\n") + 1).trim();
	if (!tail) return undefined;
	return /passcode|option|passphrase|password|\(\d-\d\)|[:?]$/i.test(tail) ? tail : undefined;
}

/**
 * A pseudo-terminal relay: runs a command with a pty of its own (ssh reads a Duo prompt from the
 * controlling terminal, never from stdin), copies its output to our stdout, and copies our stdin to
 * its pty. Exits when the command does -- `ssh -f` leaves a master behind on purpose, and waiting
 * for the pty to close would wait for that. Python's pty module, so nothing new is installed.
 */
export const PTY_RELAY = `
import os, pty, select, sys
cmd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
watch_stdin = True
exited = None
while True:
    fds = [fd] + ([0] if watch_stdin else [])
    r, _, _ = select.select(fds, [], [], 0.2)
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b""
        if data:
            os.write(1, data)
        elif exited is not None:
            break
    if 0 in r:
        data = os.read(0, 4096)
        if data:
            os.write(fd, data)
        else:
            watch_stdin = False
    if exited is None:
        w, status = os.waitpid(pid, os.WNOHANG)
        if w == pid:
            exited = os.waitstatus_to_exitcode(status)
            # drain what is left, then stop: the ssh master keeps the pty open forever
            end = 10
            while end:
                r, _, _ = select.select([fd], [], [], 0.1)
                if not r:
                    end -= 1
                    continue
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                os.write(1, data)
            break
sys.exit(exited if exited is not None else 1)
`;

export default async function (pi: ExtensionAPI): Promise<void> {
	let dead = false;
	let cfg = readArgoConfig();
	let up = false;
	let registered = false;
	let models: string[] = [];
	let lastError: string | undefined;
	let child: ChildProcess | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let pricing: Pricing = BUNDLED_PRICING;

	const emit = (event: string, payload: unknown) => {
		if (dead) return;
		try {
			pi.events.emit(event, payload);
		} catch {
			dead = true;
		}
	};
	const base = () => `http://127.0.0.1:${cfg?.port ?? 44497}`;

	async function health(): Promise<boolean> {
		try {
			const res = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(3000) });
			return res.ok && /healthy/.test(await res.text());
		} catch {
			return false;
		}
	}

	/** Read the catalogue and register both providers; idempotent. */
	async function register(): Promise<number> {
		if (!cfg) throw new Error("no ~/.config/argo-tools/config — run argo-setup first");
		const res = await fetch(`${base()}/v1/models`, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`/v1/models: HTTP ${res.status}`);
		const payload = (await res.json()) as { data?: { id: string }[] };
		models = order(dedupe((payload.data ?? []).map((m) => m.id)));
		const p = providers(models, cfg, pricing);
		pi.registerProvider("argo", p.argo as never);
		pi.registerProvider("argo-openai", p["argo-openai"] as never);
		registered = true;
		lastError = undefined;
		setUp(true, true);
		return models.length;
	}
	function unregister(): void {
		if (!registered) return;
		try {
			pi.unregisterProvider("argo");
			pi.unregisterProvider("argo-openai");
		} catch {
			// nothing registered under those names any more
		}
		registered = false;
		models = [];
	}
	function setUp(next: boolean, force = false): void {
		if (up === next && !force) return;
		up = next;
		emit("argo:health", { up, port: cfg?.port, models: models.length });
	}

	// Startup: use the tunnel if it is already up; never open it. The price table loads alongside
	// the health probe -- it is a python import of argo-dash, ~50 ms, and must precede register().
	const [alive, table] = await Promise.all([cfg ? health() : Promise.resolve(false), loadPricing()]);
	pricing = table;
	if (alive) {
		try {
			await register();
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		}
	}

	// The proxy streams Claude's prompt tokens as 0; put Pi's estimate there so the context gauge,
	// auto-compaction and the price all see a number. Only the `argo` provider: the OpenAI path
	// reports usage in full (measured with stream_options.include_usage).
	pi.on("message_end", (event, ctx) => {
		const m = (event as { message?: { role?: string; provider?: string; model?: string; stopReason?: string; timestamp?: number; usage?: Usage } }).message;
		if (dead || !m || m.role !== "assistant" || m.provider !== "argo" || !m.usage) return undefined;
		if (m.stopReason === "error" || m.stopReason === "aborted") return undefined;
		const entries = ctx.sessionManager.getBranch() as { type?: string; message?: Msg }[];
		const prior: Msg[] = [];
		for (const e of entries) {
			if (e.type !== "message" || !e.message) continue;
			// the branch may or may not already hold this message; either way it is output, not input
			if (e.message === (m as Msg) || (e.message.role === "assistant" && (e.message.timestamp ?? 0) >= (m.timestamp ?? 0))) continue;
			prior.push(e.message);
		}
		let system = "";
		try {
			system = (ctx as { getSystemPrompt?: () => string }).getSystemPrompt?.() ?? "";
		} catch {
			// an estimate without the system prompt is still an estimate
		}
		const usage = repairUsage(m.usage, estimateTokens(prior, system), ratesFor(m.model ?? "", pricing));
		return usage ? { message: { ...m, usage } } : undefined;
	});
	// A light poll only while we claim to be up: argo-down closes the port on purpose, and the
	// column should say so before the next request fails with connection refused.
	poll = setInterval(() => {
		if (dead || !registered) return;
		void health().then((ok) => setUp(ok));
	}, 30_000);

	/** argo-up inside a pty we own; its prompts become Pi input dialogs. */
	async function runUp(ctx: ExtensionContext): Promise<void> {
		if (!cfg) return ctx.ui.notify("argo: no ~/.config/argo-tools/config — run argo-setup in a terminal first", "error");
		if (child) return ctx.ui.notify("argo: argo-up is already running", "warning");
		if (await health()) {
			const n = registered ? models.length : await register().catch(() => 0);
			return ctx.ui.notify(`argo: already up on localhost:${cfg.port} · ${n} models`, "info");
		}
		ctx.ui.notify("argo: running argo-up — a Duo prompt will appear here if the bastion needs one", "info");
		await new Promise<void>((resolve) => {
			const proc = spawn("python3", ["-c", PTY_RELAY, "argo-up"], { env: { ...process.env, TERM: "dumb" }, stdio: ["pipe", "pipe", "pipe"] });
			child = proc;
			let buffer = "";
			let asking = false;
			let announced = "";
			const timer = setTimeout(() => {
				ctx.ui.notify("argo: argo-up did not finish within 3 minutes; stopping it", "error");
				proc.kill("SIGTERM");
			}, 180_000);
			const onData = (d: Buffer) => {
				buffer += d.toString("utf8").replace(/\r/g, "");
				// completed lines go to the chat, once
				const lines = buffer.split("\n");
				for (const line of lines.slice(0, -1)) {
					const t = line.trim();
					if (t && t !== announced && !dead) {
						announced = t;
						ctx.ui.notify(t.replace(/^\[argo-up\]\s*/, "argo-up: "), /❌|failed|denied/i.test(t) ? "error" : "info");
					}
				}
				buffer = lines[lines.length - 1];
				const prompt = looksLikePrompt(buffer);
				if (prompt && !asking && !dead) {
					asking = true;
					void ctx.ui
						.input(prompt, /option/i.test(prompt) ? "1 for a Duo push" : "")
						.then((answer) => {
							if (answer === undefined) {
								ctx.ui.notify("argo: cancelled", "warning");
								proc.kill("SIGTERM");
								return;
							}
							proc.stdin?.write(`${answer}\n`);
							buffer = "";
							if (/option|passcode/i.test(prompt)) ctx.ui.notify("argo: approve the Duo push on your phone…", "info");
						})
						.finally(() => {
							asking = false;
						});
				}
			};
			proc.stdout?.on("data", onData);
			proc.stderr?.on("data", onData);
			proc.on("error", (e) => {
				if (!dead) ctx.ui.notify(`argo: could not run argo-up: ${e.message}`, "error");
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				child = undefined;
				void (async () => {
					if (dead) return resolve();
					if (code !== 0) {
						ctx.ui.notify(`argo: argo-up exited ${code} — see the lines above; argo-netcheck diagnoses the bastion`, "error");
						return resolve();
					}
					try {
						const n = await register();
						ctx.ui.notify(`argo: up on localhost:${cfg?.port} · ${n} models registered — /model to pick one`, "info");
					} catch (e) {
						ctx.ui.notify(`argo: tunnel up but the catalogue failed: ${e instanceof Error ? e.message : String(e)}`, "error");
					}
					resolve();
				})();
			});
		});
	}

	async function runDown(ctx: ExtensionContext): Promise<void> {
		await new Promise<void>((resolve) => {
			const proc = spawn("argo-down", [], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			proc.stdout?.on("data", (d) => (out += d));
			proc.stderr?.on("data", (d) => (out += d));
			proc.on("error", (e) => {
				if (!dead) ctx.ui.notify(`argo: could not run argo-down: ${e.message}`, "error");
				resolve();
			});
			proc.on("close", (code) => {
				unregister();
				setUp(false);
				if (!dead) {
					const lines = out.split("\n").map((l) => l.trim().replace(/^\[argo-down\]\s*/, "")).filter(Boolean);
					ctx.ui.notify(`argo: down${code ? ` (argo-down exited ${code})` : ""} — models unregistered\n${lines.slice(-4).join("\n")}`, code ? "warning" : "info");
				}
				resolve();
			});
		});
	}

	/** One line on what this session has put through Argo, in the dash's dollars. */
	function spendLine(ctx: ExtensionContext): string {
		const s = sessionSpend(ctx.sessionManager.getBranch() as Parameters<typeof sessionSpend>[0]);
		if (!s.turns) return "this session: nothing through Argo yet";
		const dollars = `${s.estimated ? "≈ " : ""}$${s.cost.toFixed(4)}`;
		const notes = [
			`${s.turns} turn${s.turns === 1 ? "" : "s"}`,
			`Claude at public list rates (${pricing.source === "argo-dash" ? "argo-dash's table" : "bundled table"}, verified ${pricing.verified})`,
			...(s.estimated ? ["input estimated — the proxy streams it as 0"] : []),
			...(s.unpriced ? [`${s.unpriced} unpriced (no rate for that family, as on the dash)`] : []),
		];
		return `this session: ${dollars} · ${notes.join(" · ")}`;
	}

	/**
	 * argo-dash's own report. --once reads the proxy log over the tunnel's ssh master (about a
	 * second, exact input and cache counts); --totals is the local ledger and needs nothing up.
	 */
	async function runSpend(ctx: ExtensionContext): Promise<void> {
		if (!findOnPath("argo-dash")) return ctx.ui.notify("argo: argo-dash is not on PATH — argo-tools installs it next to argo-up", "error");
		const run = (args: string[]) =>
			new Promise<{ code: number | null; out: string }>((resolve) => {
				const proc = spawn("argo-dash", args, { env: { ...process.env, TERM: "dumb", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
				let out = "";
				const timer = setTimeout(() => proc.kill("SIGTERM"), 30_000);
				proc.stdout?.on("data", (d) => (out += d));
				proc.stderr?.on("data", (d) => (out += d));
				proc.on("error", (e) => resolve({ code: null, out: e.message }));
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve({ code, out });
				});
			});
		ctx.ui.setStatus("argo-spend", ctx.ui.theme.fg("dim", up ? "argo-dash --once…" : "argo-dash --totals…"));
		let title = "Argo spend · argo-dash --once (proxy log, fresh)";
		let r = up ? await run(["--once"]) : { code: 1, out: "" };
		if (r.code !== 0) {
			title = "Argo spend · argo-dash --totals (local ledger)";
			r = await run(["--totals"]);
		}
		ctx.ui.setStatus("argo-spend", undefined);
		if (dead) return;
		const clean = r.out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
		if (r.code !== 0) return ctx.ui.notify(`argo: argo-dash failed (${r.code ?? "no start"}) — ${clean.trim().split("\n").slice(-2).join(" / ")}`, "error");
		const lines = [spendLine(ctx), "", ...clean.trimEnd().split("\n")];
		await ctx.ui.custom<void>((_tui, theme, _kb, done) => new Pager(title, lines, theme, done));
	}

	pi.registerCommand("argo", {
		description: "Argo gateway: /argo · /argo on (runs argo-up, Duo prompt in chat) · /argo down · /argo spend · /argo reload",
		handler: async (args, ctx) => {
			if (dead) return;
			const verb = args.trim().toLowerCase();
			if (verb === "on" || verb === "up") return runUp(ctx);
			if (verb === "down" || verb === "off") return runDown(ctx);
			if (verb === "spend" || verb === "cost" || verb === "usage") return runSpend(ctx);
			if (verb === "reload") {
				try {
					const n = await register();
					return ctx.ui.notify(`argo: ${n} models registered`, "info");
				} catch (e) {
					return ctx.ui.notify(`argo: ${e instanceof Error ? e.message : String(e)}`, "error");
				}
			}
			const ok = await health();
			setUp(ok);
			const lines = [
				cfg ? `${cfg.user} → localhost:${cfg.port} (${cfg.file})` : "not configured — run argo-setup in a terminal",
				ok ? `up · ${registered ? `${models.length} models registered` : "not registered — /argo reload"}` : "down — /argo on runs argo-up (Duo prompt appears here)",
				...(lastError ? [`last error: ${lastError}`] : []),
				spendLine(ctx),
				"/argo spend shows argo-dash's report · metered, and argo-proxy may log request bodies on the CELS node",
			];
			ctx.ui.notify(lines.join("\n"), ok ? "info" : "warning");
		},
	});

	pi.on("session_start", () => {
		dead = false;
		cfg ??= readArgoConfig();
		emit("argo:health", { up, port: cfg?.port, models: models.length });
	});
	pi.on("session_shutdown", () => {
		dead = true;
		if (poll) clearInterval(poll);
		poll = undefined;
		child?.kill("SIGTERM");
		child = undefined;
	});
}
