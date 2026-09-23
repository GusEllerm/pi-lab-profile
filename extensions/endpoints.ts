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
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MODELS_JSON = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "models.json");
const ALCF_HOST = "inference-api.alcf.anl.gov";
const isArgo = (m: { provider: string }) => m.provider === "argo" || m.provider === "argo-openai";
const ALCF_TOKEN_ERROR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "alcf-token", "last-error");
const PROBE_TIMEOUT_MS = 8000;

type AnyModel = { id: string; provider: string; baseUrl: string };
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
let listEndpointsMemo: { at: number; gateway: string; value: Promise<unknown> } | undefined;
function listEndpoints(gateway: string, headers: Record<string, string>): Promise<unknown> {
	if (!listEndpointsMemo || listEndpointsMemo.gateway !== gateway || Date.now() - listEndpointsMemo.at > 5000) {
		const value = getJson(`${gateway}list-endpoints`, headers).catch((e) => {
			listEndpointsMemo = undefined; // a failure is not worth remembering for five seconds
			throw e;
		});
		listEndpointsMemo = { at: Date.now(), gateway, value };
	}
	return listEndpointsMemo.value;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	} catch (e) {
		// undici reports "fetch failed" and puts the real reason (ECONNREFUSED, ENOTFOUND, a cert
		// error) on `cause`; a timeout arrives as a bare abort. Neither helps anyone as printed.
		const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
		if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new Error(`no answer in ${PROBE_TIMEOUT_MS / 1000}s`);
		const cause = err?.cause?.code ?? err?.cause?.message;
		throw new Error(cause ? `${err?.message ?? "fetch failed"} (${cause})` : (err?.message ?? String(e)));
	}
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
	const frameworks =
		(payload as { clusters?: Record<string, { frameworks?: Record<string, { models?: string[] }> }> })?.clusters?.[cluster]
			?.frameworks ?? {};
	// The path segment after the cluster is a framework name only sometimes (sophia/vllm/v1) and a
	// plain "api" otherwise (minerva/api/v1, metis/api/v1) -- so when it names nothing the gateway
	// lists, take every framework the cluster offers rather than none of them.
	const pool = frameworks[framework]?.models ?? Object.values(frameworks).flatMap((fw) => fw?.models ?? []);
	return [...new Set(pool)].filter((id) => !NON_CHAT.test(id)).sort();
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
		const hint = /fetch failed|ECONNREFUSED|ENOTFOUND|no answer in/i.test(why) ? `tunnel down — run: globus-tunnel ensure (${why})` : why;
		return models.map((m) => ({ model: m, label: `? down    ${m.id}  (${hint})` }));
	}
}

async function probeAlcf(ctx: ExtensionContext, provider: string, models: AnyModel[]): Promise<Row[]> {
	const base = models[0].baseUrl;
	const marker = base.indexOf("/resource_server/");
	// Without the marker the slice below would take the first sixteen characters of the URL as the
	// gateway and probe nonsense; say what happened instead.
	// every label is `<glyph> <state>  <id>…` — two spaces before the id — so summarize() can read the state back
	if (marker < 0) return models.map((m) => ({ model: m, label: `? unknown  ${m.id}  (unrecognised ALCF URL: no /resource_server/ in ${base})` }));
	const gateway = base.slice(0, marker + "/resource_server/".length);
	const [cluster, framework] = base.slice(gateway.length).split("/");
	let token: string | undefined;
	try {
		token = await ctx.modelRegistry.getApiKeyForProvider(provider);
	} catch {
		token = undefined;
	}
	if (!token) {
		const why = lastTokenError() ?? "no token";
		return models.map((m) => ({ model: m, label: `? no auth  ${m.id}  (${why})` }));
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

// ── the /endpoints tree: one folder per machine, models inside ───────────────────────────────
export type Section = { provider: string; label: string; baseUrl: string; rows?: Row[] };
export type TreeRow =
	| { kind: "folder"; section: Section; open: boolean }
	| { kind: "url"; section: Section }
	| { kind: "model"; section: Section; row: Row };

/**
 * "3 up · 1 cold" from the rows' leading state words, so a closed folder still says what is
 * inside. Every probe labels a model `<glyph> <word>  <id>…`; rows without a glyph are notes.
 */
export function summarize(rows: Row[] | undefined): string {
	if (!rows) return "probing…";
	const counts = new Map<string, number>();
	for (const r of rows) {
		const head = r.label.trim().split(/\s{2,}/)[0] ?? "";
		if (!/^[●○◌?]/.test(head)) continue;
		const word = head.slice(1).trim();
		counts.set(word, (counts.get(word) ?? 0) + 1);
	}
	if (!counts.size) return rows.length ? `${rows.length} note${rows.length === 1 ? "" : "s"}` : "nothing served";
	return [...counts].map(([word, n]) => `${n} ${word}`).join(" · ");
}

/** Folders in section order; an open folder shows its URL line and then its rows. */
export function treeRows(sections: Section[], open: Set<string>): TreeRow[] {
	const out: TreeRow[] = [];
	for (const section of sections) {
		const isOpen = open.has(section.provider);
		out.push({ kind: "folder", section, open: isOpen });
		if (!isOpen) continue;
		out.push({ kind: "url", section });
		for (const row of section.rows ?? []) out.push({ kind: "model", section, row });
	}
	return out;
}

/** Which folders are open, kept across /endpoints calls in a session so the view is where you left it. */
const openFolders = new Set<string>();

class EndpointTree implements Component {
	private rows: TreeRow[] = [];
	private cursor = 0;
	private top = 0;
	private closed = false;

	private sections: Section[];
	private active: string;
	private height: number;
	private theme: Theme;
	private close: (chosen?: Row) => void;

	constructor(sections: Section[], active: string, height: number, theme: Theme, close: (chosen?: Row) => void) {
		this.sections = sections;
		this.active = active;
		this.height = height;
		this.theme = theme;
		this.close = close;
		this.rebuild();
	}

	/** Probes land after the tree is up; the handler calls this as each one resolves. */
	refresh(): void {
		this.rebuild(this.rows[this.cursor]);
	}

	private rebuild(keep?: TreeRow): void {
		this.rows = treeRows(this.sections, openFolders);
		const same = (r: TreeRow) =>
			keep !== undefined && r.kind === keep.kind && r.section === keep.section && (r.kind !== "model" || keep.kind !== "model" || r.row.label === keep.row.label);
		const idx = this.rows.findIndex(same);
		this.cursor = idx >= 0 ? idx : Math.max(0, this.rows.findIndex((r) => r.kind !== "url"));
		this.scrollIntoView();
	}

	private scrollIntoView(): void {
		const listRows = this.height - 3;
		if (this.cursor < this.top) this.top = this.cursor;
		if (this.cursor >= this.top + listRows) this.top = this.cursor - listRows + 1;
	}

	private move(step: number): void {
		for (let i = this.cursor + step; i >= 0 && i < this.rows.length; i += step) {
			if (this.rows[i].kind === "url") continue;
			this.cursor = i;
			return this.scrollIntoView();
		}
	}

	private setOpen(section: Section, open: boolean): void {
		if (open) openFolders.add(section.provider);
		else openFolders.delete(section.provider);
		this.rebuild({ kind: "folder", section, open });
	}

	private done(chosen?: Row): void {
		if (this.closed) return;
		this.closed = true;
		this.close(chosen);
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(30, width - 4);
		const pad = (s: string, w: number) => {
			const cell = truncateToWidth(s, w, "…");
			return cell + " ".repeat(Math.max(0, w - visibleWidth(cell)));
		};
		const body: string[] = [];
		const listRows = this.height - 3;
		for (let n = 0; n < listRows; n++) {
			const i = this.top + n;
			const r = this.rows[i];
			if (!r) {
				body.push(pad("", inner));
				continue;
			}
			const selected = i === this.cursor;
			const arrow = selected ? "→" : " ";
			if (r.kind === "folder") {
				const summary = summarize(r.section.rows);
				const head = `${arrow} ${r.open ? "▾" : "▸"} ${r.section.label}  [${r.section.provider}]`;
				const left = truncateToWidth(head, Math.max(8, inner - visibleWidth(summary) - 2), "…");
				const gap = " ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(summary)));
				body.push((selected ? t.fg("text", left) : t.fg("accent", left)) + gap + t.fg("dim", summary));
			} else if (r.kind === "url") {
				body.push(t.fg("dim", pad(`      ${r.section.baseUrl}`, inner)));
			} else {
				const key = r.row.model ? `${r.row.model.provider}/${r.row.model.id}` : "";
				const mark = key && key === this.active ? " ◀ active" : "";
				const text = `${arrow}     ${r.row.label}${mark}`;
				body.push(selected ? t.fg("text", pad(text, inner)) : r.row.model ? t.fg("muted", pad(text, inner)) : t.fg("dim", pad(text, inner)));
			}
		}
		const pending = this.sections.filter((s) => !s.rows).length;
		const title = `Inference endpoints${pending ? ` · probing ${pending}…` : ""}`;
		const head = truncateToWidth(title, Math.max(8, width - 6), "…");
		const out = [t.fg("borderAccent", "┌─") + t.fg("accent", ` ${head} `) + t.fg("borderAccent", `${"─".repeat(Math.max(0, width - visibleWidth(head) - 5))}┐`)];
		for (const line of body) out.push(`${t.fg("borderAccent", "│ ")}${line}${t.fg("borderAccent", " │")}`);
		out.push(`${t.fg("borderAccent", "│ ")}${pad(t.fg("dim", "↑↓ move · → ← open/close a machine · enter on a model switches to it · esc close"), inner)}${t.fg("borderAccent", " │")}`);
		out.push(t.fg("borderAccent", `└${"─".repeat(Math.max(0, width - 2))}┘`));
		return out;
	}

	handleInput(data: string): void {
		const r = this.rows[this.cursor];
		if (matchesKey(data, "escape") || data === "q") return this.done();
		if (matchesKey(data, "down")) return this.move(1);
		if (matchesKey(data, "up")) return this.move(-1);
		if (!r) return;
		if (matchesKey(data, "right")) {
			if (r.kind === "folder" && !r.open) this.setOpen(r.section, true);
			return;
		}
		if (matchesKey(data, "left")) {
			// on a model, ← closes the folder it is in and lands on the folder line
			if (r.kind === "folder" ? r.open : true) this.setOpen(r.section, false);
			return;
		}
		if (matchesKey(data, "enter") || data === " ") {
			if (r.kind === "folder") return this.setOpen(r.section, !r.open);
			if (r.kind === "model" && data !== " ") return this.done(r.row);
		}
	}
	handleMouse() {
		return { handled: true };
	}
	invalidate(): void {}
}

/** Argo: is the tunnel answering, and how much does it serve. Never opens anything. */
async function probeArgo(models: AnyModel[], registered: number): Promise<Row[]> {
	const base = models[0].baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
	try {
		const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const served = (await getJson(`${base}/v1/models`)) as { data?: { id: string }[] };
		// the catalogue lists aliases; argo.ts folds them, so both counts are shown
		const n = served.data?.length ?? 0;
		return models.map((m) => ({ model: m, label: `● up      ${m.id}  (${n} ids · ${registered} models · metered)` }));
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		return models.map((m) => ({ model: m, label: `? down    ${m.id}  (tunnel closed — /argo on; ${why})` }));
	}
}

export default function (pi: ExtensionAPI): void {
	// Footer slot for statusbar.ts: short endpoint name, ✓/✗ from the last reply.
	let ctxRef: ExtensionContext | undefined;
	let lastReply: "ok" | "error" | "plain" = "plain";
	// argo.ts says whether the tunnel answers; the row must not claim a route that argo-down closed.
	let argoUp = false;
	let argoModels = 0;
	pi.events.on("argo:health", (data) => {
		const d = data as { up?: boolean; models?: number } | undefined;
		argoUp = Boolean(d?.up);
		argoModels = d?.models ?? argoModels;
		publishTab();
	});
	const shortName = (model: AnyModel): string => {
		// The lightning bolt is deliberate: an Argo session is metered and its prompts leave through
		// a proxy that may log them in full. argo-claude badges its status line the same way.
		if (isArgo(model)) return "⚡ argo";
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
			text: isArgo(model) && !argoUp ? "⚡ argo off" : shortName(model),
			// on Argo the row is always at least a warning: metered, and logged upstream
			state: isArgo(model) ? (argoUp ? (lastReply === "error" ? "error" : "warn") : "error") : lastReply,
			statusKey: "endpoint",
			details: () => [
				endpointLabel(ctx, model),
				`${model.baseUrl} · ${lastReply === "ok" ? "last reply ok" : lastReply === "error" ? "last reply failed" : "no reply yet"}`,
				...(isArgo(model)
					? [argoUp ? "metered · prompts leave via the Argo gateway · /argo spend for the dash's figures" : "tunnel is down — /argo on"]
					: []),
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
				// models.json providers, plus the ones argo.ts registers at runtime -- they are not
				// in that file, and /endpoints silently omitted them until this line existed
				if (!ids.has(m.provider) && !isArgo(m)) continue;
				byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
			}
			if (byProvider.size === 0) return ctx.ui.notify(`No providers found in ${MODELS_JSON}`, "warning");

			// One folder per machine. The tree opens at once with every folder saying "probing…"
			// and fills in as each probe lands: probing four clusters takes seconds, and a dialog
			// that is already up is what keeps the arrow keys from landing in the agent list.
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
			const sections: Section[] = [...byProvider].map(([provider, models]) => ({ provider, label: endpointLabel(ctx, models[0]), baseUrl: models[0].baseUrl }));
			if (ctx.model) openFolders.add(ctx.model.provider);
			if (openFolders.size === 0 && sections[0]) openFolders.add(sections[0].provider);
			let tree: EndpointTree | undefined;
			let render: (() => void) | undefined;
			for (const [provider, models] of byProvider) {
				const section = sections.find((s) => s.provider === provider)!;
				const probe = isArgo(models[0])
					? probeArgo(models, argoModels)
					: hostOf(models[0].baseUrl) === ALCF_HOST
						? probeAlcf(ctx, provider, models)
						: probeGlobus(models);
				void probe
					.catch((e): Row[] => [{ label: `  probe failed: ${e instanceof Error ? e.message : String(e)}` }])
					.then((rows) => {
						section.rows = rows;
						tree?.refresh();
						render?.();
					});
			}
			const row = await ctx.ui.custom<Row | undefined>((tui, theme, _kb, done) => {
				const height = Math.max(10, Math.min(30, (tui.terminal?.rows ?? 40) - 10));
				tree = new EndpointTree(sections, current, height, theme, done);
				render = () => {
					try {
						tui.requestRender();
					} catch {
						// the dialog may already be gone; a late probe has nothing to draw into
					}
				};
				return tree;
			}, {});
			render = undefined;
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
