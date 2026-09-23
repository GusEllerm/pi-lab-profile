// The /endpoints tree: one folder per machine, models inside. The row model and the folder summary
// are pure, so they are tested directly; the component around them is driven live by the harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, treeRows } from "../extensions/endpoints.ts";

const globus = { provider: "globus", label: "globus cluster", baseUrl: "http://127.0.0.1:8000/v1", rows: [
	{ label: "● up      qwen3.8-flash-next", model: { id: "qwen3.8-flash-next", provider: "globus", baseUrl: "http://127.0.0.1:8000/v1" } },
	{ label: "● up      other-model  (served, not in models.json)", note: "other-model" },
] };
const alcf = { provider: "alcf-minerva", label: "ALCF Minerva", baseUrl: "https://inference-api.alcf.anl.gov/resource_server/minerva/api/v1", rows: [
	{ label: "● live    gpt-oss-120b", model: { id: "gpt-oss-120b", provider: "alcf-minerva", baseUrl: "x" } },
	{ label: "○ cold    nemotron-3-ultra", model: { id: "nemotron-3-ultra", provider: "alcf-minerva", baseUrl: "x" } },
	{ label: "○ cold    qwen3-235b", model: { id: "qwen3-235b", provider: "alcf-minerva", baseUrl: "x" } },
	{ label: "  minerva/jobs failed: HTTP 502" },
] };
const argo = { provider: "argo", label: "Argo · Anthropic API via argo-tools", baseUrl: "http://127.0.0.1:44497" };

test("a closed folder summarises what its probe found, in the probe's own words", () => {
	assert.equal(summarize(globus.rows), "2 up");
	assert.equal(summarize(alcf.rows), "1 live · 2 cold", "a note row without a state glyph is not counted");
	assert.equal(summarize(undefined), "probing…", "before the probe lands");
	assert.equal(summarize([]), "nothing served");
	assert.equal(summarize([{ label: "  probe failed: boom" }]), "1 note");
	assert.equal(summarize([{ label: "? no auth  gpt-oss-120b  (no token)" }]), "1 no auth", "two-word states survive");
	assert.equal(summarize([{ label: "? no auth gpt-oss-120b  (no token)" }]), "1 no auth gpt-oss-120b", "…which is why every probe label puts two spaces before the id");
	assert.equal(summarize([{ label: "? down    m  (tunnel closed — /argo up; x)" }, { label: "? down    n  (…)" }]), "2 down");
});

test("folders in section order; only an open one shows its URL and its models", () => {
	const closed = treeRows([globus, alcf, argo], new Set());
	assert.deepEqual(closed.map((r) => r.kind), ["folder", "folder", "folder"]);
	assert.deepEqual(closed.map((r) => r.section.provider), ["globus", "alcf-minerva", "argo"]);
	assert.ok(closed.every((r) => r.kind === "folder" && r.open === false));

	const one = treeRows([globus, alcf, argo], new Set(["alcf-minerva"]));
	assert.deepEqual(one.map((r) => r.kind), ["folder", "folder", "url", "model", "model", "model", "model", "folder"]);
	assert.equal(one[1].open, true);
	assert.equal(one[2].section, alcf, "the URL line belongs to the folder above it");
	assert.equal(one[3].row.model.id, "gpt-oss-120b");
	assert.equal(one[6].row.label, "  minerva/jobs failed: HTTP 502", "notes stay in the folder they came from");
});

test("an open folder whose probe has not landed shows its URL and nothing else yet", () => {
	const rows = treeRows([argo], new Set(["argo"]));
	assert.deepEqual(rows.map((r) => r.kind), ["folder", "url"]);
	argo.rows = [{ label: "● up      claude-opus-5  (55 ids · 38 models · metered)", model: { id: "claude-opus-5", provider: "argo", baseUrl: "x" } }];
	assert.deepEqual(treeRows([argo], new Set(["argo"])).map((r) => r.kind), ["folder", "url", "model"], "the same section object fills in as the probe resolves");
	assert.equal(summarize(argo.rows), "1 up");
});
