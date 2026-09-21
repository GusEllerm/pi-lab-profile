/**
 * Canaries for the upstream bugs this profile works around.
 *
 * Each test asserts that a *bug* is still present. When upstream fixes one, its test fails, and
 * that failure is the signal to delete the corresponding workaround rather than keep patching
 * around a fix. See docs/upstream-hover-width.md.
 *
 * Skipped when pi is not installed, so CI without it still passes.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const globalRoot = (() => {
	try {
		return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
})();
const piTui = globalRoot && join(globalRoot, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui");
const piCc = join(homedir(), ".pi/agent/npm/node_modules/pi-cc-extensions");

test("pi-tui Text still caches exactly one width", { skip: !piTui || !existsSync(piTui) }, async () => {
	const { Text } = await import(join(piTui, "dist/index.js"));
	const probe = new Text("some text long enough to wrap at a narrow width");
	const wide = probe.render(40);
	assert.equal(probe.render(40), wide, "a repeated render at one width should come from the cache");
	probe.render(20);
	assert.notEqual(
		probe.render(40),
		wide,
		"Text now keeps more than one width: delete the per-width cache in statusbar.ts",
	);
});

test("pi-tui hstack measures children it then stretches", { skip: !piTui || !existsSync(piTui) }, () => {
	const layout = readFileSync(join(piTui, "dist/layout.js"), "utf8");
	assert.match(
		layout,
		/const intrinsicHeights = entries\.map\(\(entry, index\) => measureHeight\(/,
		"the unconditional hstack height measure is gone: re-check the ScrollView measure stub",
	);
});

test("pi-cc hover still hit-tests at the terminal width", { skip: !existsSync(piCc) }, () => {
	const src = readFileSync(join(piCc, "extensions/renderer/mouse/interaction.ts"), "utf8");
	assert.match(
		src,
		/const width = Math\.max\(1, Number\(tui\.terminal\?\.columns\)/,
		"pi-cc no longer takes the hover width from the terminal: drop the hover guard",
	);
});
