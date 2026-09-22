// Acceptance tests for extensions/image-window.ts
// Run: npm test   (Node ≥ 22.18 strips the types itself)
import assert from "node:assert/strict";
import { test } from "node:test";
import imageWindow, { countImages, parseWindow, placeholder, trimImages } from "../extensions/image-window.ts";

const img = (tag: string) => ({ type: "image", mimeType: "image/png", data: `DATA-${tag}` });
const text = (t: string) => ({ type: "text", text: t });
const user = (...content: unknown[]) => ({ role: "user", content, timestamp: 0 });
const call = (id: string, path: string) => ({ type: "toolCall", id, name: "read", arguments: { path } });
const assistant = (...content: unknown[]) => ({ role: "assistant", content, timestamp: 0 });
const result = (toolCallId: string, ...content: unknown[]) => ({ role: "toolResult", toolCallId, toolName: "read", content, timestamp: 0 });

const images = (ms: any[]) => ms.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "image");
const placeholders = (ms: any[]) =>
	ms.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "text" && b.text.startsWith("[image removed"));

// 6 images: 1 @file attachment (oldest) + 4 read results, one of which carries 2 images.
function sixImageSession() {
	return [
		user(text('look at this <file name="/abs/shot0.png"></file>\n'), img("u0")),
		assistant(call("t1", "a.png")),
		result("t1", text("Read image file [image/png]"), img("a")),
		assistant(call("t2", "b.png")),
		result("t2", img("b")),
		assistant(call("t3", "pages.pdf")),
		result("t3", text("2 pages"), img("p1"), img("p2")),
		assistant(call("t4", "d.png")),
		result("t4", img("d")),
		user(text("what changed?")),
	];
}

test("6 images across 4 tool results + 1 attachment, N=3: newest three kept in order, three hinted placeholders", () => {
	const input = sixImageSession();
	const r = trimImages(input as any, 3);
	assert.deepEqual([r.total, r.sent, r.dropped], [6, 3, 3]);
	assert.deepEqual(images(r.messages).map((b: any) => b.data), ["DATA-p1", "DATA-p2", "DATA-d"]);
	assert.deepEqual(placeholders(r.messages).map((b: any) => b.text), [
		placeholder("/abs/shot0.png"),
		placeholder("a.png"),
		placeholder("b.png"),
	]);
});

test("one newest user message with 5 images, N=3: only its last three survive", () => {
	const input = [user(text("five"), img("0"), img("1"), img("2"), img("3"), img("4"))];
	const r = trimImages(input as any, 3);
	assert.deepEqual(images(r.messages).map((b: any) => b.data), ["DATA-2", "DATA-3", "DATA-4"]);
	assert.equal(placeholders(r.messages).length, 2);
	assert.equal((r.messages[0].content as any[])[1].type, "text"); // position kept, block replaced in place
});

test("no images: same array back, contents untouched", () => {
	const input = [user(text("hi")), assistant(text("hello")), user("plain string content")];
	const snapshot = structuredClone(input);
	const r = trimImages(input as any, 3);
	assert.equal(r.messages, input);
	assert.deepEqual(r.messages, snapshot);
	assert.deepEqual([r.total, r.dropped], [0, 0]);
});

test("N=0: no image blocks remain, every one replaced by a placeholder", () => {
	const r = trimImages(sixImageSession() as any, 0);
	assert.equal(images(r.messages).length, 0);
	assert.equal(placeholders(r.messages).length, 6);
	assert.equal(r.sent, 0);
});

test("tool results keep a non-empty content and their toolCallId; other blocks untouched", () => {
	const input = sixImageSession();
	const r = trimImages(input as any, 1);
	const results = r.messages.filter((m: any) => m.role === "toolResult") as any[];
	assert.deepEqual(results.map((m) => m.toolCallId), ["t1", "t2", "t3", "t4"]);
	for (const m of results) {
		assert.ok(Array.isArray(m.content) && m.content.length > 0);
	}
	assert.equal(results[0].content[0].text, "Read image file [image/png]");
	assert.equal(results[2].content[0].text, "2 pages");
});

test("never mutates its input, and is deterministic", () => {
	const input = sixImageSession();
	const snapshot = structuredClone(input);
	const a = trimImages(input as any, 3);
	const b = trimImages(input as any, 3);
	assert.deepEqual(input, snapshot);
	assert.deepEqual(a.messages, b.messages);
});

test("hints: pasted images with no <file> tag get the hint-less placeholder", () => {
	const input = [user(text("pasted"), img("x")), user(text("more"), img("y"))];
	const r = trimImages(input as any, 1);
	assert.deepEqual(placeholders(r.messages).map((b: any) => b.text), [placeholder()]);
});

test("parseWindow: integers ≥ 0 are taken, anything else is the default", () => {
	assert.equal(parseWindow("0"), 0);
	assert.equal(parseWindow(" 5 "), 5);
	assert.equal(parseWindow(undefined), 3);
	assert.equal(parseWindow("-1"), 3);
	assert.equal(parseWindow("two"), 3);
	assert.equal(parseWindow("2.5"), 3);
});

test("extension wiring: context handler trims, status set, /images reports session/sent/dropped", async () => {
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	const tabs: any[] = [];
	const pi = {
		on: (e: string, h: Function) => (handlers[e] = h),
		registerCommand: (n: string, c: any) => (commands[n] = c),
		events: { on: () => {}, emit: (_e: string, d: any) => tabs.push(d) },
	};
	const statuses: (string | undefined)[] = [];
	const notices: string[] = [];
	const session = sixImageSession();
	const ctx = {
		hasUI: true,
		ui: { theme: { fg: (_c: string, t: string) => t }, setStatus: (_k: string, t?: string) => statuses.push(t), notify: (m: string) => notices.push(m) },
		sessionManager: { buildSessionContext: () => ({ messages: session }) },
	};
	delete process.env.PI_IMAGE_WINDOW;
	imageWindow(pi as any);

	const out = await handlers.context({ type: "context", messages: structuredClone(session) }, ctx);
	assert.equal(countImages(out.messages), 3);
	assert.match(String(statuses.at(-1)), /sent newest 3 of 6/);
	assert.deepEqual([tabs.at(-1).id, tabs.at(-1).text, tabs.at(-1).state], ["images", "images 3/6", "warn"]);

	await commands.images.handler("", ctx);
	assert.match(notices.at(-1)!, /6 in session · window 3 \(default\) · last call: 3 sent, 3 dropped/);

	const none = await handlers.context({ type: "context", messages: [user(text("hi"))] }, ctx);
	assert.equal(none, undefined);
	assert.equal(statuses.at(-1), undefined); // status cleared once nothing is dropped

	await commands.images.handler("0", ctx);
	const zero = await handlers.context({ type: "context", messages: structuredClone(session) }, ctx);
	assert.equal(countImages(zero.messages), 0);
});

test("PI_IMAGE_WINDOW sets N at load", async () => {
	const handlers: Record<string, Function> = {};
	process.env.PI_IMAGE_WINDOW = "1";
	imageWindow({ on: (e: string, h: Function) => (handlers[e] = h), registerCommand: () => {}, events: { on: () => {}, emit: () => {} } } as any);
	delete process.env.PI_IMAGE_WINDOW;
	const out = await handlers.context({ type: "context", messages: sixImageSession() }, { hasUI: false });
	assert.deepEqual(images(out.messages).map((b: any) => b.data), ["DATA-d"]);
});
