/**
 * endpoints — show which inference endpoint the active model hits, and what each endpoint serves.
 *
 *  - Footer status "→ <endpoint>" follows every model change (/model, Ctrl+P, session restore).
 *  - /endpoints probes every provider defined in ~/.pi/agent/models.json and lists its models with
 *    live state. Enter on a configured model switches to it.
 *      globus  GET {baseUrl}/models through the SSH tunnel (no auth)
 *      alcf-*  GET {gateway}/list-endpoints and {gateway}/{cluster}/jobs with the provider's own
 *              token (resolved through models.json's apiKey command, i.e. ~/.local/bin/alcf-token).
 *              Lists what the cluster offers beyond models.json and marks each model live / queued /
 *              cold (a cold model is started by its first request).
 *
 * Endpoint labels come from each provider's `name` in models.json, so adding a provider there is
 * enough for it to show up here.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODELS_JSON = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "models.json");
const ALCF_HOST = "inference-api.alcf.anl.gov";
const ALCF_TOKEN_ERROR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "alcf-token", "last-error");
const PROBE_TIMEOUT_MS = 8000;

type AnyModel = { id: string; provider: string; baseUrl: string; name?: string };
type Row = { label: string; model?: AnyModel; note?: string };

function customProviderIds(): string[] {
	try {
		return Object.keys(JSON.parse(readFileSync(MODELS_JSON, "utf8")).providers ?? {});
	} catch {
		return [];
	}
}

function hostOf(url: string): string {
	try {
		const u = new URL(url);
		return u.host;
	} catch {
		return url;
	}
}

function endpointLabel(ctx: ExtensionContext, model: AnyModel): string {
	const display = ctx.modelRegistry.getProviderDisplayName(model.provider);
	return display && display !== model.provider ? display : `${model.provider} · ${hostOf(model.baseUrl)}`;
}

function setEndpointStatus(ctx: ExtensionContext, model: AnyModel | undefined): void {
	if (!ctx.hasUI) return;
	if (!model) return ctx.ui.setStatus("endpoint", undefined);
	const theme = ctx.ui.theme;
	ctx.ui.setStatus("endpoint", theme.fg("dim", "→ ") + theme.fg("muted", endpointLabel(ctx, model)));
}

// One list-endpoints fetch serves every ALCF provider in a single /endpoints run.
let listEndpointsMemo: { at: number; value: Promise<unknown> } | undefined;
function listEndpoints(gateway: string, headers: Record<string, string>): Promise<unknown> {
	if (!listEndpointsMemo || Date.now() - listEndpointsMemo.at > 5000) {
		listEndpointsMemo = { at: Date.now(), value: getJson(`${gateway}list-endpoints`, headers) };
	}
	return listEndpointsMemo.value;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
	return res.json();
}

function lastTokenError(): string | undefined {
	try {
		return readFileSync(ALCF_TOKEN_ERROR, "utf8").trim();
	} catch {
		return undefined;
	}
}

// Offered but deliberately left out of models.json — Pi tool-loop test, 2026-09-17.
const EXCLUDED: Record<string, string> = {
	"sophia/google/gemma-4-31B-it": "Pi test hung — use the alcf-metis copy",
	"sophia/google/gemma-4-E4B-it": "tool calls come back as text",
	"sophia/meta-llama/Llama-4-Scout-17B-16E-Instruct": "doesn't call tools",
	"sophia/meta-llama/Llama-4-Maverick-17B-128E-Instruct": "tool calls come back as text",
	"sophia/meta-llama/Meta-Llama-3.1-70B-Instruct": "16k context, too small for Pi",
	"sophia/meta-llama/Meta-Llama-3.1-8B-Instruct": "stream ends without finish_reason",
	"sophia/mistralai/Mistral-Large-Instruct-2407": "no tool calling on this deployment",
};

// Not chat models: embeddings, genomics encoders, segmentation services.
const NON_CHAT = /embed|genslm|sam3|dinov3|amsc-/i;

/**
 * Chat models the gateway's list-endpoints payload offers on one cluster + framework, e.g.
 * {"clusters":{"sophia":{"frameworks":{"vllm":{"models":[...]}}}}}.
 */
function alcfOffered(payload: unknown, cluster: string, framework: string): string[] {
	const fw = (payload as { clusters?: Record<string, { frameworks?: Record<string, { models?: string[] }> }> })
		?.clusters?.[cluster]?.frameworks?.[framework];
	return (fw?.models ?? []).filter((id) => !NON_CHAT.test(id)).sort();
}

/**
 * Per-model state from {cluster}/jobs: {"running":[{"Models":"a,b",...}],"queued":[...],...}.
 * Models absent from both lists are "cold": the first request asks the scheduler to start them.
 */
function alcfJobStates(jobs: unknown): Map<string, "live" | "queued"> {
	const states = new Map<string, "live" | "queued">();
	const lists = jobs as Record<string, { Models?: string }[] | undefined>;
	for (const [key, state] of [["queued", "queued"], ["running", "live"]] as const) {
		for (const job of lists?.[key] ?? []) {
			for (const id of (job.Models ?? "").split(",")) if (id.trim()) states.set(id.trim(), state);
		}
	}
	return states;
}

async function probeGlobus(models: AnyModel[]): Promise<Row[]> {
	const base = models[0].baseUrl.replace(/\/$/, "");
	try {
		const body = (await getJson(`${base}/models`)) as { data?: { id: string }[] };
		const served = new Set((body.data ?? []).map((m) => m.id));
		const rows: Row[] = models.map((m) => ({
			model: m,
			label: `${served.has(m.id) ? "● up    " : "○ absent"}  ${m.id}`,
		}));
		for (const id of served) {
			if (!models.some((m) => m.id === id)) rows.push({ label: `● up      ${id}  (served, not in models.json)`, note: id });
		}
		return rows;
	} catch (e) {
		const why = String((e as Error).message ?? e);
		const hint = /fetch failed|ECONNREFUSED/i.test(why) ? "tunnel down — run: globus-tunnel ensure" : why;
		return models.map((m) => ({ model: m, label: `? down    ${m.id}  (${hint})` }));
	}
}

async function probeAlcf(ctx: ExtensionContext, provider: string, models: AnyModel[]): Promise<Row[]> {
	const base = models[0].baseUrl;
	const gateway = base.slice(0, base.indexOf("/resource_server/") + "/resource_server/".length);
	const [cluster, framework] = base.slice(gateway.length).split("/");
	let token: string | undefined;
	try {
		token = await ctx.modelRegistry.getApiKeyForProvider(provider);
	} catch {
		token = undefined;
	}
	if (!token) {
		const why = lastTokenError() ?? "no token";
		return models.map((m) => ({ model: m, label: `? no auth ${m.id}  (${why})` }));
	}
	const auth = { Authorization: `Bearer ${token}` };
	const [listed, jobs] = await Promise.allSettled([
		listEndpoints(gateway, auth),
		getJson(`${gateway}${cluster}/jobs`, auth),
	]);
	const offered = listed.status === "fulfilled" ? alcfOffered(listed.value, cluster, framework) : [];
	const states = jobs.status === "fulfilled" ? alcfJobStates(jobs.value) : undefined;

	const state = (id: string): string => {
		const s = states?.get(id);
		if (s === "live") return "● live  ";
		if (s === "queued") return "◌ queued";
		if (states) return "○ cold  "; // first request starts a job; expect a wait or a 503
		return offered.includes(id) ? "? listed" : "? unknown";
	};
	const rows: Row[] = models.map((m) => ({ model: m, label: `${state(m.id)}  ${m.id}` }));
	for (const id of offered) {
		if (models.some((m) => m.id === id)) continue;
		const why = EXCLUDED[`${cluster}/${id}`];
		rows.push({ label: `${state(id)}  ${id}  (${why ? `excluded: ${why}` : "offered, not in models.json"})`, note: id });
	}
	if (listed.status === "rejected") rows.push({ label: `  list-endpoints failed: ${String(listed.reason?.message ?? listed.reason)}` });
	if (jobs.status === "rejected") rows.push({ label: `  ${cluster}/jobs failed: ${String(jobs.reason?.message ?? jobs.reason)}` });
	return rows;
}

export default function (pi: ExtensionAPI): void {
	// Footer slot for statusbar.ts: short endpoint name, ✓/✗ from the last reply.
	let ctxRef: ExtensionContext | undefined;
	let lastReply: "ok" | "error" | "plain" = "plain";
	const shortName = (model: AnyModel): string => {
		if (hostOf(model.baseUrl) === ALCF_HOST) {
			const cluster = model.baseUrl.split("/resource_server/")[1]?.split("/")[0] ?? "";
			return `ALCF ${cluster.charAt(0).toUpperCase()}${cluster.slice(1)}`;
		}
		if (model.provider === "globus") return "globus3";
		return ctxRef ? endpointLabel(ctxRef, model).split(" · ")[0] : model.provider;
	};
	const publishTab = () => {
		const model = ctxRef?.model as AnyModel | undefined;
		if (!ctxRef || !model) return;
		const ctx = ctxRef;
		pi.events.emit("statusbar:slot", {
			id: "endpoint",
			text: shortName(model),
			state: lastReply,
			statusKey: "endpoint",
			details: () => [
				endpointLabel(ctx, model),
				`${model.baseUrl} · ${lastReply === "ok" ? "last reply ok" : lastReply === "error" ? "last reply failed" : "no reply yet"}`,
			],
		});
	};
	/** One short label per provider, so the sidebar, menus and cards all name endpoints the same way. */
	const publishLabels = () => {
		if (!ctxRef) return;
		const labels: Record<string, string> = {};
		for (const m of ctxRef.modelRegistry.getAll() as AnyModel[]) {
			if (!labels[m.provider]) labels[m.provider] = shortName(m);
		}
		pi.events.emit("statusbar:endpoint-labels", labels);
	};
	pi.events.on("statusbar:ready", () => {
		publishTab();
		publishLabels();
	});

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		setEndpointStatus(ctx, ctx.model as AnyModel | undefined);
		publishTab();
		publishLabels();
	});
	pi.on("model_select", (event, ctx) => {
		ctxRef = ctx;
		lastReply = "plain";
		setEndpointStatus(ctx, event.model as AnyModel);
		publishTab();
	});
	pi.on("message_end", (event) => {
		const m = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (m?.role !== "assistant") return;
		lastReply = m.errorMessage || m.stopReason === "error" ? "error" : "ok";
		publishTab();
	});

	pi.registerCommand("endpoints", {
		description: "List inference endpoints and their models with live status; Enter switches model",
		handler: async (_args, ctx) => {
			const ids = new Set(customProviderIds());
			const byProvider = new Map<string, AnyModel[]>();
			for (const m of ctx.modelRegistry.getAll() as AnyModel[]) {
				if (!ids.has(m.provider)) continue;
				byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
			}
			if (byProvider.size === 0) return ctx.ui.notify(`No providers found in ${MODELS_JSON}`, "warning");

			// Probing four clusters takes seconds, and until it finishes there is no picker for the
			// arrow keys to land in — so hold the keyboard, or the agent list quietly takes them.
			ctx.ui.setStatus("endpoints-probe", ctx.ui.theme.fg("dim", "probing endpoints…"));
			pi.events.emit("fleet:keys-hold", {});
			let sections: { provider: string; models: AnyModel[]; rows: Row[] }[];
			try {
				sections = await Promise.all(
					[...byProvider].map(async ([provider, models]) => {
						const rows = hostOf(models[0].baseUrl) === ALCF_HOST
							? await probeAlcf(ctx, provider, models)
							: await probeGlobus(models);
						return { provider, models, rows };
					}),
				);
			} finally {
				pi.events.emit("fleet:keys-release", {});
				ctx.ui.setStatus("endpoints-probe", undefined);
			}

			const options: string[] = [];
			const pick = new Map<string, Row>();
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
			for (const { provider, models, rows } of sections) {
				options.push(`── ${endpointLabel(ctx, models[0])}   [${provider}]`);
				options.push(`   ${models[0].baseUrl}`);
				for (const row of rows) {
					const mark = row.model && `${row.model.provider}/${row.model.id}` === current ? " ◀ active" : "";
					const text = `     ${row.label}${mark}`;
					options.push(text);
					pick.set(text, row);
				}
			}

			const choice = await ctx.ui.select("Inference endpoints — Enter on a model switches to it", options);
			const row = choice ? pick.get(choice) : undefined;
			if (!row) return;
			if (row.model) {
				const ok = await pi.setModel(ctx.modelRegistry.find(row.model.provider, row.model.id) ?? (row.model as never));
				if (!ok) ctx.ui.notify(`No credentials for ${row.model.provider}`, "error");
			} else if (row.note) {
				ctx.ui.notify(`${row.note} is available but not configured — add it to ${MODELS_JSON}`, "info");
			}
		},
	});
}
