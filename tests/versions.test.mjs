// The pinned versions of Pi and the two packages are written in several places: the bundle script
// builds with them, and the README, the runbook and the setup guide tell people to install them.
// make-bundle.sh is the source; every other mention must agree, or a newcomer installs one version
// while a bundle carries another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const bundle = read("scripts/make-bundle.sh");
const pin = (name) => {
	const m = bundle.match(new RegExp(`^${name}=(\\S+)$`, "m"));
	assert.ok(m, `make-bundle.sh sets ${name}`);
	return m[1];
};
const pins = {
	"pi-coding-agent": pin("PI_VERSION"),
	"pi-cc-extensions": pin("PICC_VERSION"),
	"pi-subagents": pin("SUBAGENTS_VERSION"),
};

// Files that tell someone to install a package by name@version, and must name every one of them.
const installDocs = ["README.md", "docs/agent-setup.md", "docs/setup-guide.md"];

for (const path of [...installDocs, "docs/no-node.md", "docs/providers.md", "docs/endpoints.md"]) {
	test(`${path} names only the pinned versions`, () => {
		const text = read(path);
		for (const [name, version] of Object.entries(pins)) {
			for (const [, found] of text.matchAll(new RegExp(`${name}@(\\d[\\w.-]*\\w)`, "g"))) {
				assert.equal(found, version, `${path}: ${name}@${found}, but make-bundle.sh pins ${version}`);
			}
		}
	});
}

for (const path of installDocs) {
	test(`${path} installs every pinned package`, () => {
		const text = read(path);
		for (const [name, version] of Object.entries(pins)) {
			assert.ok(text.includes(`${name}@${version}`), `${path} does not mention ${name}@${version}`);
		}
	});
}

test("no-node.md describes the bundle at the pinned versions", () => {
	const text = read("docs/no-node.md");
	assert.match(text, new RegExp(`pi-cc-extensions ${pins["pi-cc-extensions"].replaceAll(".", "\\.")},`));
	assert.match(text, new RegExp(`pi-subagents ${pins["pi-subagents"].replaceAll(".", "\\.")},`));
	assert.match(text, new RegExp(`Pi ${pins["pi-coding-agent"].replaceAll(".", "\\.")}'s standalone binary`));
});

test("the README's 'verified on' line names the pinned versions", () => {
	const line = read("README.md").split("\n").find((l) => l.startsWith("Verified on Pi "));
	assert.ok(line, "README has a 'Verified on Pi' line");
	assert.ok(line.includes(`Pi ${pins["pi-coding-agent"]} `), line);
	assert.ok(line.includes(`pi-cc-extensions ${pins["pi-cc-extensions"]}`), line);
	assert.ok(line.includes(`pi-subagents ${pins["pi-subagents"]}`), line);
});
