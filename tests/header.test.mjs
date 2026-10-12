// The header is pure text layout from a config file, so the markup, the layout and the file lookup
// are tested directly; the replacement in a live session is checked with a harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { STARTER, gitBranch, headerPath, hexColor, layout, readHeader, renderMarkup } from "../extensions/header.ts";

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

test("hex colours: #rrggbb in the markup and per-row art colours, the last repeating", () => {
	assert.equal(hexColor("#2a78d6", "x"), "\x1b[38;2;42;120;214mx\x1b[39m");
	assert.equal(hexColor("blue", "x"), undefined);
	assert.equal(renderMarkup("{#1baf7a:aqua}", {}, theme), "\x1b[38;2;27;175;122maqua\x1b[39m");
	const rows = layout({ art: ["A", "B", "C"], artColors: ["#000001", "#000002"], layout: "stacked", lines: ["x"] }, {}, theme, 80);
	assert.deepEqual(rows.slice(1, 4), ["\x1b[38;2;0;0;1mA\x1b[39m", "\x1b[38;2;0;0;2mB\x1b[39m", "\x1b[38;2;0;0;2mC\x1b[39m"]);
	assert.deepEqual(rows.slice(4), ["", "x", ""], "stacked: a blank row, then the lines");
	assert.match(readHeader(writeTmp({ art: ["a"], artColors: "red" })).error, /"artColors" must be an array/);
	assert.match(readHeader(writeTmp({ layout: "sideways" })).error, /"layout" must be "beside" or "stacked"/);
});

test("art wider than the terminal is left out, never cut mid-letter", () => {
	const cfg = { art: ["x".repeat(54)], layout: "stacked", lines: ["the lines still show"] };
	assert.equal(layout(cfg, {}, theme, 80).length, 5);
	assert.deepEqual(layout(cfg, {}, theme, 40), ["", "the lines still show", ""]);
});

test("the lab header: the cluster banner's wordmark and gradient, with HARNESS for CLUSTER", () => {
	const lab = JSON.parse(readFileSync(new URL("../profiles/lab/header.json", import.meta.url), "utf8"));
	assert.equal(readHeader(new URL("../profiles/lab/header.json", import.meta.url).pathname).error, undefined);
	assert.equal(lab.art.length, 7);
	assert.equal(lab.art[6].trim(), "H  A  R  N  E  S  S");
	assert.equal(lab.artColors[0], "#2a78d6", "cluster blue, as the MOTD's first row");
	assert.equal(lab.artColors.at(-1), "#1baf7a", "aqua, as its last");
	const width = Math.max(...lab.art.map((r) => [...r].length));
	assert.ok(width <= 60, `the wordmark is ${width} columns, so it fits a transcript beside the status column`);
	const rows = layout(lab, { version: "1.1.0", model: "m", endpoint: "e", hints: "H" }, theme, 100);
	assert.ok(rows.some((r) => r.includes("H  A  R  N  E  S  S")));
});

function writeTmp(obj) {
	const dir = mkdtempSync(join(tmpdir(), "hdr-tmp-"));
	const file = join(dir, "header.json");
	writeFileSync(file, JSON.stringify(obj));
	return file;
}
