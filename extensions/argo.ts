/**
 * argo — Argonne's Argo LLM gateway as Pi providers, through argo-tools' SSH tunnel.
 *
 * argo-tools (github.com/GusEllerm/argo-tools) runs argo-proxy on a CELS home node and forwards its
 * port here: `localhost:<port>` then speaks both the OpenAI and Anthropic APIs, authenticating by
 * ANL username rather than a secret. This extension turns what that endpoint serves into Pi models:
 *
 *   argo/<claude-…>          Claude, over the Anthropic messages API: thinking levels and cache
 *                            accounting survive the proxy (verified: usage carries thinking_tokens
 *                            and cache_read/creation fields)
 *   argo-openai/<gpt-…|gemini-…>   everything else, over chat completions
 *
 * Two providers because the two APIs disagree about baseUrl: Anthropic clients append /v1/messages
 * to a bare host; OpenAI clients append /chat/completions to a /v1 base.
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

type ModelDef = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Conservative metadata per family; unknown ids still register, with the family's defaults. */
export function modelDef(id: string): ModelDef {
	switch (family(id)) {
		case "claude":
			return { id, name: id, reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_000, cost: FREE };
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
export function providers(ids: string[], cfg: { user: string; port: number }) {
	const base = `http://127.0.0.1:${cfg.port}`;
	const claude = ids.filter((id) => family(id) === "claude").map(modelDef);
	const rest = ids.filter((id) => family(id) !== "claude").map(modelDef);
	const compat = { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", supportsStrictMode: false };
	return {
		argo: { name: "Argo · Anthropic API via argo-tools", baseUrl: base, api: "anthropic-messages", apiKey: cfg.user, models: claude },
		"argo-openai": { name: "Argo · OpenAI-compatible via argo-tools", baseUrl: `${base}/v1`, api: "openai-completions", apiKey: cfg.user, authHeader: true, compat, models: rest },
	} as const;
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
		const p = providers(models, cfg);
		pi.registerProvider("argo", p.argo as never);
		pi.registerProvider("argo-openai", p["argo-openai"] as never);
		registered = true;
		lastError = undefined;
		setUp(true);
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
	function setUp(next: boolean): void {
		if (up === next) return;
		up = next;
		emit("argo:health", { up, port: cfg?.port });
	}

	// Startup: use the tunnel if it is already up; never open it.
	if (cfg && (await health())) {
		try {
			await register();
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		}
	}
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

	pi.registerCommand("argo", {
		description: "Argo gateway: /argo · /argo on (runs argo-up, Duo prompt in chat) · /argo down · /argo reload",
		handler: async (args, ctx) => {
			if (dead) return;
			const verb = args.trim().toLowerCase();
			if (verb === "on" || verb === "up") return runUp(ctx);
			if (verb === "down" || verb === "off") return runDown(ctx);
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
				"metered, and argo-proxy may log request bodies on the CELS node — see the profile's setup guide",
			];
			ctx.ui.notify(lines.join("\n"), ok ? "info" : "warning");
		},
	});

	pi.on("session_start", () => {
		dead = false;
		cfg ??= readArgoConfig();
		emit("argo:health", { up, port: cfg?.port });
	});
	pi.on("session_shutdown", () => {
		dead = true;
		if (poll) clearInterval(poll);
		poll = undefined;
		child?.kill("SIGTERM");
		child = undefined;
	});
}
