// The header is pure text layout from a config file, so the markup, the layout and the file lookup
// are tested directly; the replacement in a live session is checked with a harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARTER, gitBranch, headerPath, layout, readHeader, renderMarkup } from "../extensions/header.ts";

// a theme that shows what was styled, so the tests can read it
const theme = {
	fg: (name, text) => {
		if (name === "nope") throw new Error("unknown colour");
		return `<${name}>${text}</${name}>`;
	},
	bold: (text) => `<b>${text}</b>`,
	italic: (text) => `<i>${text}</i>`,
};
const values = { version: "1.1.0", model: "qwen3.8-flash-next", endpoint: "globus3" };

test("markup: styles nest, values substitute, backslash escapes, typos stay visible", () => {
	assert.equal(renderMarkup("plain", values, theme), "plain");
	assert.equal(renderMarkup("{accent:hi}", values, theme), "<accent>hi</accent>");
	assert.equal(renderMarkup("{bold:{accent:pi}} {dim:v{version}}", values, theme), "<b><accent>pi</accent></b> <dim>v1.1.0</dim>");
	assert.equal(renderMarkup("{muted:model} {model} via {endpoint}", values, theme), "<muted>model</muted> qwen3.8-flash-next via globus3");
	assert.equal(renderMarkup("\\{literal\\} and \\\\", values, theme), "{literal} and \\", "backslash escapes braces and itself");
	assert.equal(renderMarkup("a } b", values, theme), "a } b", "a stray closing brace at top level is text");
	assert.equal(renderMarkup("{nosuchvalue}", values, theme), "{nosuchvalue}", "an unknown value is left as written");
	assert.equal(renderMarkup("{nope:text}", values, theme), "text", "an unknown colour draws plain");
	assert.equal(renderMarkup("{italic:x}", values, theme), "<i>x</i>");
	assert.equal(renderMarkup("a { b", values, theme), "a { b", "a lone brace is just a brace");
	assert.equal(renderMarkup("{accent:unclosed", values, theme), "<accent>unclosed</accent>", "an unclosed span runs to the end");
});

test("layout: art beside the lines when there is room, stacked when narrow, blank rows around", () => {
	const cfg = { art: ["AA", "BB", "CC"], artStyle: "accent", lines: ["one", "two"] };
	const wide = layout(cfg, values, theme, 80);
	assert.equal(wide[0], "");
	assert.equal(wide.at(-1), "");
	assert.equal(wide.length, 5, "three art rows, two lines beside them, a blank above and below");
	assert.match(wide[1], /^<accent>AA<\/accent> {2}one$/);
	assert.match(wide[2], /^<accent>BB<\/accent> {2}two$/);
	assert.match(wide[3], /^<accent>CC<\/accent> {2}$/);
	const narrow = layout(cfg, values, theme, 20);
	assert.deepEqual(narrow.slice(1, 4), ["<accent>AA</accent>", "<accent>BB</accent>", "<accent>CC</accent>"], "stacked: art first");
	assert.deepEqual(layout({ lines: ["just text"] }, values, theme, 80), ["", "just text", ""]);
	assert.deepEqual(layout({}, values, theme, 80), ["", ""], "an empty config is two blank rows, not a crash");
});

test("the starter reproduces today's header and parses", () => {
	const rows = layout(STARTER, { ...values, hints: "HINTS" }, theme, 120);
	assert.ok(rows.some((r) => r.includes("<b><accent>pi</accent></b> <dim>v1.1.0</dim>")));
	assert.ok(rows.some((r) => r.includes("HINTS")));
	assert.ok(rows.some((r) => r.includes("this one is <b><mdLink>yours</mdLink></b>")));
});

test("the file: a project's .pi/header.json wins over the user's; bad files say what is wrong", () => {
	const cwd = mkdtempSync(join(tmpdir(), "hdr-cwd-"));
	const agent = mkdtempSync(join(tmpdir(), "hdr-agent-"));
	try {
		assert.equal(headerPath(cwd, agent), undefined, "neither: the built-in header stays");
		writeFileSync(join(agent, "header.json"), JSON.stringify({ lines: ["user"] }));
		assert.equal(headerPath(cwd, agent), join(agent, "header.json"));
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "header.json"), JSON.stringify({ lines: ["project"] }));
		assert.equal(headerPath(cwd, agent), join(cwd, ".pi", "header.json"));
		assert.deepEqual(readHeader(join(cwd, ".pi", "header.json")).config, { lines: ["project"] });
		writeFileSync(join(agent, "header.json"), "{ not json");
		assert.match(readHeader(join(agent, "header.json")).error, /header\.json: /);
		writeFileSync(join(agent, "header.json"), JSON.stringify({ lines: "one string" }));
		assert.match(readHeader(join(agent, "header.json")).error, /"lines" must be an array of strings/);
		writeFileSync(join(agent, "header.json"), JSON.stringify(["not", "an", "object"]));
		assert.match(readHeader(join(agent, "header.json")).error, /expected an object/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	}
});

test("the branch comes from .git/HEAD without a subprocess", () => {
	const repo = mkdtempSync(join(tmpdir(), "hdr-git-"));
	try {
		assert.equal(gitBranch(repo), "");
		mkdirSync(join(repo, ".git"));
		mkdirSync(join(repo, "sub"));
		writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/demo-day\n");
		assert.equal(gitBranch(join(repo, "sub")), "demo-day", "found from a subdirectory");
		writeFileSync(join(repo, ".git", "HEAD"), "0123456789abcdef\n");
		assert.equal(gitBranch(repo), "0123456", "a detached head shows its short hash");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
