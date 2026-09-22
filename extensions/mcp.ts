/**
 * mcp — MCP servers as Pi tools.
 *
 * Pi has no MCP support of its own, on purpose (its docs: "build or install those workflows as
 * extensions or packages"). This is that extension. Every server named in a config file is started
 * over stdio when the session starts, its tools are registered with Pi under `<server>_<tool>`, and
 * calls are forwarded. A resource the config names becomes a skill, so guidance a server ships
 * (hpc-bridge serves its own SKILL.md as one) reaches the model the way Pi expects.
 *
 * Config, merged in this order (later wins per server name):
 *   ~/.pi/agent/mcp.json            global
 *   <cwd>/.pi/mcp.json              project
 * {
 *   "servers": {
 *     "hpc": {
 *       "command": "uvx",
 *       "args": ["--from", "git+https://github.com/globus-labs/hpc-bridge", "hpc-bridge"],
 *       "env": { "HPC_BRIDGE_USER_DIR": "~/.pi/agent/hpc-bridge/user" },   // ~ expands; HOME is always passed
 *       "cwd": "~",                                                          // optional
 *       "timeoutMs": 180000,                                                 // per tool call; default 120000
 *       "prefix": "hpc",                                                     // tool name prefix; default: the server name
 *       "skills": [{ "uri": "hpcbridge://guidance/operations", "name": "driving-hpc" }]
 *     }
 *   }
 * }
 *
 * The server's own JSON schemas are handed to Pi as-is through TypeBox's Unsafe(): Pi validates
 * arguments with Value.Check, which accepts them, and sends them to the model unchanged. Nothing is
 * transcribed by hand, so a server that adds a parameter needs no change here.
 *
 * Scope, deliberately: tools and resources-as-skills. No sampling, elicitation, roots or
 * notifications until something needs them. /mcp shows what is connected.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type SkillSpec = { uri: string; name: string; description?: string };
type ServerSpec = {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	timeoutMs?: number;
	prefix?: string | false;
	skills?: SkillSpec[];
};
type Config = { servers?: Record<string, ServerSpec> };

const DEFAULT_TIMEOUT_MS = 120_000;
const CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "mcp");

const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Both config files, project entries overriding global ones by server name. */
export function readConfig(cwd: string): Record<string, ServerSpec> {
	const merged: Record<string, ServerSpec> = {};
	for (const file of [join(homedir(), ".pi", "agent", "mcp.json"), join(cwd, ".pi", "mcp.json")]) {
		try {
			if (!existsSync(file)) continue;
			const parsed = JSON.parse(readFileSync(file, "utf8")) as Config;
			for (const [name, spec] of Object.entries(parsed.servers ?? {})) merged[name] = spec;
		} catch (e) {
			throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return merged;
}

/** A skill file needs frontmatter; a resource that already carries it is written verbatim. */
export function skillText(body: string, name: string, description?: string): string {
	if (/^---\r?\n/.test(body)) return body;
	const desc = (description ?? `Guidance served by an MCP server as ${name}`).replace(/\n/g, " ");
	return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`;
}

/** What a tool call hands back to the model: the text parts joined, images noted, errors flagged. */
export function flattenContent(content: Array<{ type: string; text?: string; mimeType?: string }>): string {
	const parts = content.map((c) => {
		if (c.type === "text") return c.text ?? "";
		if (c.type === "image") return `[image ${c.mimeType ?? ""}]`;
		if (c.type === "resource") return `[resource]`;
		return `[${c.type}]`;
	});
	return parts.join("\n").trim();
}

type Live = { name: string; spec: ServerSpec; client: Client; tools: string[]; skills: string[]; startedAt: number };

export default async function (pi: ExtensionAPI): Promise<void> {
	let dead = false;
	const live = new Map<string, Live>();
	const errors: string[] = [];
	const skillPaths: string[] = [];

	/** Start one server, register its tools, materialise its skills. */
	async function start(name: string, spec: ServerSpec): Promise<void> {
		const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: homedir() };
		for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = expandHome(v);
		const transport = new StdioClientTransport({
			command: spec.command,
			args: spec.args ?? [],
			env,
			cwd: spec.cwd ? expandHome(spec.cwd) : undefined,
			stderr: "pipe",
		});
		const client = new Client({ name: "pi-lab-profile", version: "0.1.0" });
		await client.connect(transport);
		const timeout = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const prefix = spec.prefix === false ? "" : `${spec.prefix ?? name}_`;
		const entry: Live = { name, spec, client, tools: [], skills: [], startedAt: Date.now() };

		const { tools } = await client.listTools();
		for (const tool of tools) {
			const toolName = `${prefix}${tool.name}`;
			entry.tools.push(toolName);
			pi.registerTool({
				name: toolName,
				label: `${name}: ${tool.name}`,
				description: tool.description ?? `${tool.name} (MCP server ${name})`,
				// the server's schema, unchanged: Pi validates with Value.Check and the model sees JSON Schema
				parameters: Type.Unsafe(tool.inputSchema as object) as never,
				promptSnippet: `${toolName}: ${(tool.description ?? "").split("\n")[0].slice(0, 100)}`,
				async execute(_id, params, signal) {
					const current = live.get(name);
					if (!current) return { content: [{ type: "text", text: `MCP server ${name} is not connected` }], isError: true };
					try {
						const result = (await current.client.callTool({ name: tool.name, arguments: params as Record<string, unknown> }, undefined, {
							timeout,
							signal,
						})) as { content?: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean };
						return {
							content: [{ type: "text", text: flattenContent(result.content ?? []) || "(no output)" }],
							isError: Boolean(result.isError),
						};
					} catch (e) {
						return { content: [{ type: "text", text: `${toolName} failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
					}
				},
			});
		}

		for (const skill of spec.skills ?? []) {
			try {
				const read = await client.readResource({ uri: skill.uri });
				const text = read.contents.map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("\n");
				if (!text.trim()) throw new Error("resource is empty");
				const dir = join(CACHE_DIR, name, skill.name);
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "SKILL.md"), skillText(text, skill.name, skill.description));
				entry.skills.push(skill.name);
				skillPaths.push(dir);
			} catch (e) {
				errors.push(`${name}: skill ${skill.name} from ${skill.uri}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		live.set(name, entry);
	}

	// Awaited before session_start, so every tool exists before the first prompt.
	let servers: Record<string, ServerSpec> = {};
	try {
		servers = readConfig(process.cwd());
	} catch (e) {
		errors.push(e instanceof Error ? e.message : String(e));
	}
	await Promise.all(
		Object.entries(servers).map(async ([name, spec]) => {
			try {
				await start(name, spec);
			} catch (e) {
				errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}),
	);

	// Skills written above are advertised here; Pi asks once per startup and reload.
	pi.on("resources_discover", () => (skillPaths.length ? { skillPaths: [...skillPaths] } : undefined));

	pi.on("session_start", async (_event, ctx) => {
		dead = false;
		if (!ctx.hasUI) return;
		const n = [...live.values()].reduce((sum, s) => sum + s.tools.length, 0);
		if (live.size) ctx.ui.notify(`mcp: ${live.size} server${live.size === 1 ? "" : "s"}, ${n} tools${errors.length ? ` · ${errors.length} problem${errors.length === 1 ? "" : "s"}, see /mcp` : ""}`, errors.length ? "warning" : "info");
		else if (errors.length) ctx.ui.notify(`mcp: ${errors[0]}`, "warning");
	});

	// A reload restarts the servers: the activation that owns these child processes is going away,
	// and a tool registered by it would otherwise forward to a client whose owner is dead.
	pi.on("session_shutdown", () => {
		dead = true;
		for (const s of live.values()) void s.client.close().catch(() => {});
		live.clear();
	});

	pi.registerCommand("mcp", {
		description: "MCP servers this session started: /mcp · /mcp tools <server>",
		handler: async (args, ctx: ExtensionContext) => {
			if (dead) return;
			const [verb, which] = args.trim().split(/\s+/);
			if (verb === "tools" && which) {
				const s = live.get(which);
				return ctx.ui.notify(s ? `${which}: ${s.tools.join(", ")}` : `no server named ${which}`, s ? "info" : "warning");
			}
			const rows = [...live.values()].map(
				(s) => `${s.name}: ${s.tools.length} tools${s.skills.length ? `, skills ${s.skills.join(", ")}` : ""} · up ${Math.round((Date.now() - s.startedAt) / 1000)}s · ${s.spec.command} ${(s.spec.args ?? []).join(" ")}`,
			);
			if (!rows.length && !errors.length) rows.push("no MCP servers configured — see ~/.pi/agent/mcp.json or .pi/mcp.json");
			ctx.ui.notify([...rows, ...errors.map((e) => `! ${e}`)].join("\n"), errors.length ? "warning" : "info");
		},
	});
}
