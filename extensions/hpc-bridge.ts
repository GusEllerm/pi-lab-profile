/**
 * hpc-bridge — what this profile adds on top of the MCP bridge for one server.
 *
 * hpc-bridge (extensions/mcp.ts starts it from mcp.json) can allocate a billed compute block on a
 * supercomputer. Its own spend gate is a tool parameter: ensure_endpoint_up(confirm_spend=True). On
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
 * reads the same mcp.json the bridge reads, so the tool prefix follows that config.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./mcp.ts";

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
	at?: number;
};

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
	return next;
}

export type SlotState = "ok" | "warn" | "error" | "busy" | "idle";

/** What the column shows: a state colour, one line, and the detail rows. */
export function describe(s: HpcState, now = Date.now()): { text: string; state: SlotState; details: string[] } {
	if (!s.facility && !s.status) return { text: "hpc –", state: "idle", details: ["no facility connected", "ask: what HPC facilities can I use?"] };
	const spending = s.block === "warm" || s.block === "provisioning";
	const state: SlotState =
		s.status === "failed" || s.status === "unsupported"
			? "error"
			: s.status?.startsWith("needs_") || s.status === "draining" || s.status === "tearing_down"
				? "warn"
				: spending
					? "busy"
					: "ok";
	const facility = s.facility ?? "?";
	const head = spending ? `${facility} · block ${s.block}` : `${facility} · ${s.status ?? "connected"}`;
	const details = [
		`${facility}${s.status ? ` · ${s.status.replace(/_/g, " ")}` : ""}`,
		...(s.block ? [`block ${s.block}${s.block === "warm" && s.warmSince !== undefined ? ` · ${Math.max(1, Math.round((now - s.warmSince) / 60_000))} min` : ""}`] : []),
		...(s.spend !== undefined ? [`spent ${s.spend.toFixed(2)} node-h this session`] : []),
		...(s.partition || s.account ? [`${s.partition ?? "default partition"} · ${s.account ?? "default account"}`] : []),
		...(s.notice ? [s.notice.slice(0, 120)] : []),
		...(spending ? ["release: hpc_stop_endpoint"] : []),
	];
	return { text: `hpc ${head}`, state, details };
}

/** The bridge's tool prefix for the hpc-bridge server, from the same config it reads. */
export function hpcPrefix(cwd: string): string | undefined {
	let servers: ReturnType<typeof readConfig>;
	try {
		servers = readConfig(cwd);
	} catch {
		return undefined;
	}
	for (const [name, spec] of Object.entries(servers)) {
		const argv = [spec.command, ...(spec.args ?? [])].join(" ");
		if (/hpc-bridge/.test(argv)) return spec.prefix === false ? "" : `${spec.prefix ?? name}_`;
	}
	return undefined;
}

export default function (pi: ExtensionAPI): void {
	let dead = false;
	let state: HpcState = {};
	const prefix = hpcPrefix(process.cwd());
	const tool = (base: string) => `${prefix ?? "hpc_"}${base}`;
	const baseOf = (toolName: string): string | undefined =>
		prefix !== undefined && toolName.startsWith(prefix) ? toolName.slice(prefix.length) : undefined;

	const emit = (event: string, payload: unknown) => {
		if (dead) return;
		try {
			pi.events.emit(event, payload);
		} catch {
			dead = true;
		}
	};
	const publish = () => {
		const d = describe(state);
		emit("statusbar:slot", { id: "hpc", text: d.text, state: d.state, statusKey: "hpc", details: () => describe(state).details });
	};

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		const { toolName, input } = event as unknown as { toolName: string; input: Record<string, unknown> };
		const base = baseOf(toolName);

		// The credential guard, on exactly what hpc-bridge's own hook covers.
		if (toolName === "bash" || base === "run_shell" || base === "login_shell") {
			const command = typeof input?.command === "string" ? input.command : "";
			if (looksLikeCredential(command)) return { block: true, reason: CREDENTIAL_REASON };
		}

		// The spend gate. hpc-bridge trusts the model to have asked; this does not.
		if (base === "ensure_endpoint_up" && input?.confirm_spend === true) {
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
				"Start a billed compute block?",
				`Facility: ${state.facility ?? "not yet connected"}\nPartition: ${partition}\nAccount: ${account}\n\n` +
					"This allocates a scheduler node and charges the allocation until it is released (hpc_stop_endpoint) or idles out.",
			);
			if (!ok) {
				return { block: true, reason: "The user declined to start a billed compute block. Do not retry with confirm_spend=true unless they ask for it." };
			}
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
		description: "The hpc-bridge session: facility, block, spend. Tools are hpc_*; guidance is the driving-hpc skill",
		handler: async (_args, ctx) => {
			if (dead) return;
			const d = describe(state);
			const guard = prefix === undefined ? "\n! no hpc-bridge server in mcp.json — /mcp" : "";
			ctx.ui.notify(`${d.text}\n${d.details.join("\n")}${guard}`, d.state === "error" ? "error" : d.state === "warn" ? "warning" : "info");
		},
	});
	void tool; // the prefix helper is what /hpc's description refers to
}
