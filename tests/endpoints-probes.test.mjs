// What the probes report for a server that answers, one that refuses, one that is not there, and
// an ALCF cluster in each job state -- with fetch stubbed, so the rows summarize() reads are the
// rows the probes actually emit (the tree test checks the label format on hand-written rows).
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeAlcf, probeServer, summarize } from "../extensions/endpoints.ts";

const ctx = { modelRegistry: { getApiKeyForProvider: async (p) => (p === "noauth" ? undefined : `key-for-${p}`) } };
const model = (provider, id, baseUrl) => ({ provider, id, baseUrl });
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

/** Route fetches by URL; a route that throws simulates the network. */
function stubFetch(routes) {
	const real = globalThis.fetch;
	const seen = [];
	globalThis.fetch = async (url, init) => {
		seen.push({ url, auth: init?.headers?.Authorization });
		for (const [match, handler] of routes) if (url.includes(match)) return handler(url, init);
		throw new Error(`unrouted: ${url}`);
	};
	return { seen, restore: () => (globalThis.fetch = real) };
}

test("probeServer: served models read up, configured-but-absent read absent, extras are noted; the provider's key is sent", async () => {
	const f = stubFetch([["/v1/models", () => reply({ data: [{ id: "demo-chat" }, { id: "extra-model" }] })]]);
	try {
		const rows = await probeServer(ctx, "my-server", [model("my-server", "demo-chat", "http://h:8000/v1"), model("my-server", "old-chat", "http://h:8000/v1")]);
		assert.deepEqual(rows.map((r) => r.label), ["● up      demo-chat", "○ absent  old-chat", "● up      extra-model  (served, not in models.json)"]);
		assert.equal(rows[2].note, "extra-model");
		assert.equal(summarize(rows), "2 up · 1 absent", "the served extra counts as up");
		assert.equal(f.seen[0].auth, "Bearer key-for-my-server", "a gateway that guards /models must not read as down");
	} finally {
		f.restore();
	}
});

test("probeServer: a refusal is reported as the HTTP status; nothing listening is 'nothing answers', and only globus gets the tunnel hint", async () => {
	const f = stubFetch([
		["guarded", () => reply({ error: "bad key" }, 401)],
		["127.0.0.1:8000", () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }],
		["127.0.0.1:18099", () => { throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }); }],
	]);
	try {
		const [guarded] = await probeServer(ctx, "g", [model("g", "m", "http://guarded/v1")]);
		assert.match(guarded.label, /^\? down    m  \(HTTP 401/);
		const [lab] = await probeServer(ctx, "globus", [model("globus", "qwen", "http://127.0.0.1:8000/v1")]);
		assert.match(lab.label, /tunnel down — run: globus-tunnel ensure \(fetch failed \(ECONNREFUSED\)\)/);
		const [own] = await probeServer(ctx, "dead", [model("dead", "m", "http://127.0.0.1:18099/v1")]);
		assert.match(own.label, /nothing answers at http:\/\/127\.0\.0\.1:18099\/v1 \(Unable to connect/, "Bun's wording, from the standalone Pi");
		assert.doesNotMatch(own.label, /globus-tunnel/);
		assert.equal(summarize([guarded, lab, own]), "3 down");
	} finally {
		f.restore();
	}
});

test("probeAlcf: live, queued and cold from the jobs list; offered models not configured are listed with the exclusion reason", async () => {
	const gateway = "https://inference-api.alcf.anl.gov/resource_server/";
	const f = stubFetch([
		["list-endpoints", () => reply({ clusters: { sophia: { frameworks: { vllm: { models: ["openai/gpt-oss-120b", "google/gemma-4-31B-it", "meta/llama-new", "some-embed-model"] } } } } })],
		["sophia/jobs", () => reply({ running: [{ Models: "openai/gpt-oss-120b" }], queued: [{ Models: "meta/llama-new,other" }] })],
	]);
	try {
		const rows = await probeAlcf(ctx, "alcf-sophia", [
			model("alcf-sophia", "openai/gpt-oss-120b", `${gateway}sophia/vllm/v1`),
			model("alcf-sophia", "openai/gpt-oss-20b", `${gateway}sophia/vllm/v1`),
		]);
		const labels = rows.map((r) => r.label);
		assert.equal(labels[0], "● live    openai/gpt-oss-120b");
		assert.equal(labels[1], "○ cold    openai/gpt-oss-20b", "configured, not in any job list: the first request starts it");
		assert.ok(labels.some((l) => l.startsWith("○ cold    google/gemma-4-31B-it  (excluded: ")), "the lab's exclusion reason travels with the row");
		assert.ok(labels.some((l) => l === "◌ queued  meta/llama-new  (offered, not in models.json)"));
		assert.ok(!labels.some((l) => l.includes("some-embed-model")), "non-chat models are not offered");
		assert.equal(summarize(rows), "1 live · 2 cold · 1 queued");
		assert.equal(f.seen[0].auth, "Bearer key-for-alcf-sophia");
	} finally {
		f.restore();
	}
});

test("probeAlcf: no token reads 'no auth' without a request; a URL without the marker is 'unknown'", async () => {
	const f = stubFetch([]);
	try {
		const [row] = await probeAlcf(ctx, "noauth", [model("noauth", "m", "https://inference-api.alcf.anl.gov/resource_server/minerva/api/v1")]);
		assert.match(row.label, /^\? no auth  m  \(/);
		assert.equal(f.seen.length, 0, "nothing is fetched without a token");
		const [odd] = await probeAlcf(ctx, "alcf-x", [model("alcf-x", "m", "https://inference-api.alcf.anl.gov/other/minerva/v1")]);
		assert.match(odd.label, /^\? unknown  m  \(unrecognised ALCF URL/);
	} finally {
		f.restore();
	}
});
