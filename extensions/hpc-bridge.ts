/**
 * hpc-bridge — what this profile adds on top of Pi's MCP support for one server.
 *
 * hpc-bridge (Pi starts it from mcp.json; since Pi 1.0 that is built in) can allocate a billed
 * compute block on a supercomputer. Its own spend gate is a tool parameter: ensure_endpoint_up(confirm_spend=True). On
 * Claude Code a skill tells the model to ask the user first; nothing enforces that on any host, and
 * Pi has no permission popups at all. So:
 *
 *   - The spend gate is enforced here. A call with confirm_spend=true reaches the server only after
 *     the user confirms in a dialog that names the facility, partition and account. Headless
 *     sessions (pi -p) block it outright unless PI_HPC_HEADLESS_SPEND=allow.
 *   - The credential guard is ported. hpc-bridge's PreToolUse hook refuses tool inputs that look
 *     like an inline secret; the same pattern refuses them here, on bash and the two shell tools.
 *   - The column gets an HPC row while a facility is connected: status, block state, spend so far,
 *     partition and account -- read from the server's own result objects as they come back.
 *
 * Nothing here talks to the server. It observes tool calls and results through Pi's events and
 * reads the same mcp.json Pi reads, so the tool prefix (`mcp__<server>__`) follows that config.
 *
 * The operations guidance is the plugin's own. hpc-bridge ships it as skills/driving-hpc/SKILL.md,
 * bundled into the wheel at hpc_bridge/_guidance/SKILL.md; uvx keeps every installed version in
 * uv's cache. At load this finds the newest of those, re-emits its frontmatter as quoted YAML (the
 * original's is not valid YAML, which Pi reports as a skill conflict) into the agent cache dir, and
 * advertises it through resources_discover. Nothing is copied into this repository: a new
 * hpc-bridge release reaches the skill the next time uvx installs it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** hpc-bridge's own guard, hooks/credential-guard.sh: a credential-looking key followed by = or :. */
export const CREDENTIAL = /(password|api[_-]?key|secret|token)\s*[=:]/i;
export const looksLikeCredential = (text: string): boolean => CREDENTIAL.test(text);
export const CREDENTIAL_REASON =
	"Possible inline credential in the command. hpc-bridge holds secrets in its endpoint/broker; do not pass them on a command line.";

export type HpcState = {
	facility?: string;
	/** EndpointStatus.status or ConnectFacilityResult.phase, whichever came last */
	status?: string;
	block?: string;
	spend?: number;
	partition?: string;
	account?: string;
	notice?: string;
	/** when the block was last seen warm */
	warmSince?: number;
	lastTool?: string;
	/** when the last non-error hpc result arrived: warmth is only trusted this fresh */
	at?: number;
	/** spend has been acknowledged this session -- from then on the server re-provisions without asking */
	spendConfirmed?: boolean;
};

/**
 * hpc-bridge's idle-release window (max_idletime, 600s on the Globus Labs MEP). A block not heard
 * from for longer may have been released; the server itself only finds out on its next call, and
 * that call re-provisions if spend was ever confirmed. So a result older than this is not evidence
 * of a warm block, for the row or for the gate.
 */
export const IDLE_S = Number(process.env.PI_HPC_IDLE_S) || 600;
export const isFresh = (s: HpcState, now = Date.now()): boolean => s.block === "warm" && s.at !== undefined && now - s.at < IDLE_S * 1000;

/** The first JSON object in a tool's text output; hpc-bridge returns pydantic models as JSON. */
export function parseResult(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}" && --depth === 0) {
			try {
				return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/** Fold one tool's result into the state. Pure, so the tests can drive it without a server. */
export function applyResult(state: HpcState, tool: string, result: Record<string, unknown> | undefined, now = Date.now()): HpcState {
	const next: HpcState = { ...state, lastTool: tool, at: now };
	if (!result) return next;
	const str = (k: string) => (typeof result[k] === "string" ? (result[k] as string) : undefined);
	const num = (k: string) => (typeof result[k] === "number" ? (result[k] as number) : undefined);
	switch (tool) {
		case "connect_facility":
			next.facility = str("facility") ?? next.facility;
			next.status = str("phase") ?? next.status;
			next.notice = str("notice");
			break;
		case "ensure_endpoint_up":
		case "stop_endpoint":
		case "teardown_endpoint":
			next.status = str("status") ?? next.status;
			next.block = str("block_state") ?? next.block;
			next.spend = num("session_spend") ?? next.spend;
			next.partition = str("partition") ?? next.partition;
			next.account = str("account") ?? next.account;
			next.notice = str("notice");
			break;
		case "run_shell":
		case "poll_task":
		case "reset_session":
			next.block = str("block_state") ?? next.block;
			next.spend = num("session_spend") ?? next.spend;
			break;
		default:
			return next;
	}
	if (next.block === "warm") next.warmSince ??= now;
	else if (next.block === "cold") next.warmSince = undefined;
	if (next.block === "warm" || next.block === "provisioning") next.spendConfirmed = true;
	return next;
}

export type SlotState = "ok" | "warn" | "error" | "busy" | "idle";

/** "1m", "2h10m": the block has been warm this long. */
const warmFor = (since: number, now: number): string => {
	const m = Math.max(1, Math.round((now - since) / 60_000));
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

/**
 * What the column shows, and what /hpc shows.
 *
 * `column` is three or four short rows for a ~21-column cell: the facility; status and block with
 * how long it has been warm; partition and account when known; spend once there is a block. The
 * server's `notice` is not among them -- it is prose for the model ("worker live on globus1
 * (py3.12.3, dill0.3.9). billed block bounds -- a task runs up to ~7180s...") and it wrapped into
 * seven rows cut mid-word. `full` has everything, for /hpc and the dashboard.
 */
export function describe(s: HpcState, now = Date.now(), prefix = "mcp__hpc__"): { text: string; state: SlotState; column: string[]; full: string[] } {
	if (!s.facility && !s.status) {
		const idle = ["no facility connected", "ask: what HPC facilities can I use?"];
		return { text: "hpc –", state: "idle", column: idle, full: idle };
	}
	const facility = s.facility ?? "?";
	// Warmth is trusted only as long as the idle window: after that the block may have been released
	// and the server would not know either -- say so rather than count up a block that may be gone.
	const stale = s.block === "warm" && s.at !== undefined && now - s.at >= IDLE_S * 1000;
	const spending = !stale && (s.block === "warm" || s.block === "provisioning");
	const state: SlotState =
		s.status === "failed" || s.status === "unsupported"
			? "error"
			: stale || s.status?.startsWith("needs_") || s.status === "draining" || s.status === "tearing_down"
				? "warn"
				: spending
					? "busy"
					: "ok";
	const status = s.status?.replace(/_/g, " ");
	const block = stale
		? `warm? no news ${warmFor(s.at as number, now)}`
		: s.block === "warm" && s.warmSince !== undefined
			? `warm ${warmFor(s.warmSince, now)}`
			: s.block;
	const where = [s.partition, s.account].filter(Boolean).join(" · ");
	const spend = s.spend !== undefined && (s.block !== undefined || s.spend > 0) ? `${s.spend.toFixed(2)} node-h` : "";
	const column = [
		facility,
		[status, block].filter(Boolean).join(" · "),
		...(where ? [where] : []),
		...(spend ? [spend] : []),
	];
	const full = [
		`${facility}${status ? ` · ${status}` : ""}`,
		...(block ? [`block ${block}`] : []),
		...(s.partition || s.account ? [`partition ${s.partition ?? "default"} · account ${s.account ?? "default"}`] : []),
		...(spend ? [`spent ${spend} this session`] : []),
		...(s.notice ? [s.notice] : []),
		...(stale ? ["the next hpc call will re-check, and may restart the block"] : []),
		...(spending ? [`release the block: ${prefix}stop_endpoint`] : []),
	];
	const head = spending ? `${facility} · ${block}` : `${facility} · ${status ?? "connected"}`;
	return { text: `hpc ${head}`, state, column, full };
}

// ── the driving-hpc skill, from the installed plugin ─────────────────────────────────────────
/** A YAML double-quoted scalar: the one form every parser reads the same way. */
export const yamlString = (v: string): string => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The SKILL.md with its frontmatter re-emitted as quoted scalars; the body untouched. */
export function skillText(body: string, name = "driving-hpc"): string {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
	if (!m) return `---\nname: ${yamlString(name)}\ndescription: ${yamlString("Operations guidance served by hpc-bridge")}\n---\n\n${body}`;
	const fields: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (kv) fields[kv[1]] = kv[2].replace(/^["'](.*)["']$/, "$1");
	}
	fields.name ??= name;
	fields.description ??= "Operations guidance served by hpc-bridge";
	const head = Object.entries(fields).map(([k, v]) => `${k}: ${yamlString(v)}`).join("\n");
	return `---\n${head}\n---\n${body.slice(m[0].length)}`;
}

/** uv's cache (UV_CACHE_DIR, else ~/.cache/uv), where uvx unpacks every version it has installed. */
export const uvCacheDir = (): string => process.env.UV_CACHE_DIR || join(homedir(), ".cache", "uv");

/** The newest hpc_bridge/_guidance/SKILL.md under uv's cache, or undefined before the server has ever run. */
export function findPluginSkill(cacheDir = uvCacheDir()): string | undefined {
	let best: { file: string; mtime: number } | undefined;
	const walk = (dir: string, depth: number) => {
		if (depth > 7) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const path = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === "hpc_bridge") {
					const file = join(path, "_guidance", "SKILL.md");
					if (existsSync(file)) {
						const mtime = statSync(file).mtimeMs;
						if (!best || mtime > best.mtime) best = { file, mtime };
					}
				} else if (!e.name.startsWith(".") && e.name !== "node_modules") walk(path, depth + 1);
			}
		}
	};
	walk(cacheDir, 0);
	return best?.file;
}

/** Write the plugin's skill, frontmatter quoted, under the agent cache; returns the skill directory. */
export function installSkill(agentDir: string, source: string | undefined): string | undefined {
	if (!source) return undefined;
	const dir = join(agentDir, "cache", "hpc-bridge", "driving-hpc");
	const text = skillText(readFileSync(source, "utf8"));
	const target = join(dir, "SKILL.md");
	try {
		mkdirSync(dir, { recursive: true });
		if (!existsSync(target) || readFileSync(target, "utf8") !== text) writeFileSync(target, text);
		return dir;
	} catch {
		return undefined;
	}
}

/** hpc-bridge's tools, for recognising the server when no mcp.json names it. */
export const HPC_TOOLS = new Set([
	"list_facilities", "connect_facility", "authenticate", "complete_login", "complete_preauth", "ensure_endpoint_up",
	"run_shell", "poll_task", "reset_session", "login_shell", "stop_endpoint", "teardown_endpoint",
]);

type McpEntry = { command?: string; args?: string[]; url?: string };

/** The `mcpServers` Pi reads: the agent directory's mcp.json, then the project's, which wins by name. */
export function readMcpServers(cwd: string): Record<string, McpEntry> {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const out: Record<string, McpEntry> = {};
	for (const file of [join(agentDir, "mcp.json"), join(cwd, ".pi", "mcp.json")]) {
		if (!existsSync(file)) continue;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, McpEntry> };
			for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
				// a project entry with no command keeps the user-level one (it only overrides exposure)
				if (entry && typeof entry === "object" && (entry.command || entry.url || !out[name])) out[name] = { ...out[name], ...entry };
			}
		} catch {
			// a malformed file is Pi's to report; nothing to gate on here
		}
	}
	return out;
}

/** Pi names MCP tools `mcp__<server>__<tool>`, with anything but letters, digits and _ replaced by _. */
export const toolPrefix = (server: string): string => `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`;

/** The hpc-bridge server in mcp.json -- the one whose command mentions hpc-bridge -- and its tool prefix. */
export function hpcServer(cwd: string): { name: string; prefix: string } | undefined {
	for (const [name, spec] of Object.entries(readMcpServers(cwd))) {
		const argv = [spec.command, ...(spec.args ?? [])].join(" ");
		if (/hpc-bridge/.test(argv)) return { name, prefix: toolPrefix(name) };
	}
	return undefined;
}
export const hpcPrefix = (cwd: string): string | undefined => hpcServer(cwd)?.prefix;

export default function (pi: ExtensionAPI): void {
	let dead = false;
	let state: HpcState = {};
	const server = hpcServer(process.cwd());
	const prefix = server?.prefix ?? "mcp__hpc__";
	// the skill lives in uv's cache only once the server has been installed; until then there is nothing to advertise
	const skillDir = server ? installSkill(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), findPluginSkill()) : undefined;
	pi.on("resources_discover", () => (skillDir ? { skillPaths: [dirname(skillDir)] } : undefined));
	/** The hpc-bridge tool behind a Pi tool name: the configured server's, or, with no config, any server serving hpc-bridge's tool set. */
	const baseOf = (toolName: string): string | undefined => {
		if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
		if (server) return undefined;
		const m = /^mcp__[A-Za-z0-9_]+__(.+)$/.exec(toolName);
		return m && HPC_TOOLS.has(m[1]) ? m[1] : undefined;
	};

	const emit = (event: string, payload: unknown) => {
		if (dead) return;
		try {
			pi.events.emit(event, payload);
		} catch {
			dead = true;
		}
	};
	const publish = () => {
		const d = describe(state, Date.now(), prefix);
		emit("statusbar:slot", { id: "hpc", text: d.text, state: d.state, statusKey: "hpc", details: () => describe(state, Date.now(), prefix).column });
	};

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		const { toolName, input } = event as unknown as { toolName: string; input: Record<string, unknown> };
		const base = baseOf(toolName);

		// The credential guard, on exactly what hpc-bridge's own hook covers.
		if (toolName === "bash" || base === "run_shell" || base === "login_shell") {
			const command = typeof input?.command === "string" ? input.command : "";
			if (looksLikeCredential(command)) return { block: true, reason: CREDENTIAL_REASON };
		}

		// The spend gate. hpc-bridge trusts the model to have asked; this does not. And it is not the
		// confirm_spend flag that starts blocks: once spend is acknowledged the server keeps that for
		// the session, and every later ensure_endpoint_up -- or run_shell, which provisions on its
		// way to running -- re-allocates a billed block if the current one is cold. So the question
		// is "could this call provision?": an explicit confirm_spend=true, or any provisioning call
		// after spend was confirmed when the block is not provably warm within the idle window.
		const provisions = (base === "ensure_endpoint_up" || base === "run_shell") && (input?.shape ?? "compute") !== "login";
		const explicit = base === "ensure_endpoint_up" && input?.confirm_spend === true;
		const restart = provisions && !explicit && state.spendConfirmed === true && !isFresh(state);
		if (explicit || restart) {
			if (!ctx.hasUI) {
				if (process.env.PI_HPC_HEADLESS_SPEND === "allow") return undefined;
				return {
					block: true,
					reason:
						"Starting a billed compute block needs the user's confirmation, and this session has no UI to ask in. Run this interactively, or set PI_HPC_HEADLESS_SPEND=allow deliberately.",
				};
			}
			const partition = typeof input.partition === "string" ? input.partition : (state.partition ?? "the facility default");
			const account = typeof input.account === "string" ? input.account : (state.account ?? "the facility default");
			const ok = await ctx.ui.confirm(
				restart ? "Restart a billed compute block?" : "Start a billed compute block?",
				`Facility: ${state.facility ?? "not yet connected"}\nPartition: ${partition}\nAccount: ${account}\n\n` +
					(restart
						? `Spend was confirmed earlier this session and the block has not been heard from for ${state.at ? warmFor(state.at, Date.now()) : "a while"} -- it may have idled out. ` +
							`${base === "run_shell" ? "Running this command" : "This call"} will allocate a new scheduler node if so, charging the allocation until it is released.`
						: "This allocates a scheduler node and charges the allocation until it is released (hpc_stop_endpoint) or idles out."),
			);
			if (!ok) {
				return {
					block: true,
					reason: restart
						? "The user declined to restart a billed compute block. Ask them before calling hpc tools that provision again."
						: "The user declined to start a billed compute block. Do not retry with confirm_spend=true unless they ask for it.",
				};
			}
			if (explicit) state = { ...state, spendConfirmed: true }; // the server will remember it too
		}
		return undefined;
	});

	pi.on("tool_result", (event) => {
		const { toolName, content, isError } = event as unknown as { toolName: string; content: Array<{ type: string; text?: string }>; isError: boolean };
		const base = baseOf(toolName);
		if (!base || isError) return undefined;
		const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
		state = applyResult(state, base, parseResult(text));
		publish();
		return undefined;
	});

	pi.on("session_start", () => {
		dead = false;
		publish();
	});
	pi.events.on("statusbar:ready", () => publish());
	pi.on("session_shutdown", () => {
		dead = true;
	});

	pi.registerCommand("hpc", {
		description: "The hpc-bridge session: facility, block, spend. Tools are mcp__hpc__*; guidance is the driving-hpc skill; /mcp for the connection",
		handler: async (_args, ctx) => {
			if (dead) return;
			const d = describe(state, Date.now(), prefix);
			const guard = server ? "" : "\n! no hpc-bridge server in mcp.json — /mcp lists what Pi connected";
			ctx.ui.notify(`${d.text}\n${d.full.join("\n")}${guard}`, d.state === "error" ? "error" : d.state === "warn" ? "warning" : "info");
		},
	});
}
