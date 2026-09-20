/**
 * image-window — send only the newest N images to the model; older ones become short text placeholders.
 *
 * Pi re-sends the whole conversation on every LLM call. The globus vLLM endpoint runs with
 * --limit-mm-per-prompt '{"image":4,...}' and counts images over the entire request, so once a
 * session holds a fifth image every later call fails with "At most 4 image(s) may be provided in
 * one prompt" — even text-only turns. This trims the outgoing copy of the messages on every call
 * (the `context` event); the session file and the transcript keep every image.
 *
 *  - N: $PI_IMAGE_WINDOW, default 3. 0 = send no images. Negative or non-numeric = the default.
 *  - /images            images in the session, the window, what the last call sent/dropped
 *  - /images <n>        change N for this session; /images default restores it
 *  - footer status      shown while the last call dropped images, cleared when it didn't
 *
 * Deterministic (same history → same trimmed messages), so a trimmed prefix stays byte-identical
 * across calls and the server's prefix cache survives until the window moves.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_WINDOW = 3;
const STATUS_KEY = "image-window";

type Block = { type: string; [key: string]: unknown };
type Message = { role: string; content?: unknown; toolCallId?: string; [key: string]: unknown };

export interface TrimResult {
	messages: Message[];
	total: number;
	sent: number;
	dropped: number;
}

/** Integer ≥ 0, else the default. */
export function parseWindow(raw: unknown): number {
	const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
	return /^\d+$/.test(text) ? Number(text) : DEFAULT_WINDOW;
}

export function placeholder(hint?: string): string {
	return hint
		? `[image removed to fit the provider's per-request image limit — ${hint}; read it again if you need it]`
		: "[image removed to fit the provider's per-request image limit; read it again if you need it]";
}

function blocksOf(message: Message): Block[] | undefined {
	return message.role !== "assistant" && Array.isArray(message.content) ? (message.content as Block[]) : undefined;
}

export function countImages(messages: readonly Message[]): number {
	let n = 0;
	for (const m of messages) for (const b of blocksOf(m) ?? []) if (b?.type === "image") n++;
	return n;
}

/** toolCallId → file path argument of the call that produced the result (read, or any tool with a path). */
function toolCallPaths(messages: readonly Message[]): Map<string, string> {
	const paths = new Map<string, string>();
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content as Block[]) {
			if (b?.type !== "toolCall") continue;
			const args = (b.arguments ?? {}) as Record<string, unknown>;
			const path = [args.path, args.file_path, args.filePath].find((p) => typeof p === "string" && p);
			if (path) paths.set(String(b.id), String(path));
		}
	}
	return paths;
}

/**
 * Image file names for a user/custom message, in image order. `@file` attachments put
 * `<file name="/abs/path">` (empty or hint-only body) in the text for each image, in the same order
 * as the image blocks; text files differ by a newline right after `>`. Only trusted when the counts
 * line up — pasted images carry no tag, and a mismatch would pin the wrong name on an image.
 */
function attachmentNames(blocks: Block[], imageCount: number): (string | undefined)[] {
	const text = blocks.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n");
	const names = [...text.matchAll(/<file name="([^"]+)">(?!\n)/g)].map((m) => m[1]);
	return names.length === imageCount ? names : [];
}

/**
 * Keep the newest `limit` image blocks (counting from the end of the conversation, and from the end
 * of each message), replace each older one in place with a placeholder text block. Returns the input
 * array itself when nothing is dropped; never mutates the input.
 */
export function trimImages(messages: Message[], limit: number): TrimResult {
	const total = countImages(messages);
	if (total <= limit) return { messages, total, sent: total, dropped: 0 };

	const paths = toolCallPaths(messages);
	const out = messages.slice();
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const blocks = blocksOf(message);
		if (!blocks) continue;
		const imageCount = blocks.filter((b) => b?.type === "image").length;
		if (imageCount === 0) continue;

		const names = message.role === "toolResult" ? [] : attachmentNames(blocks, imageCount);
		const toolPath = message.role === "toolResult" ? paths.get(String(message.toolCallId)) : undefined;
		let ordinal = imageCount; // forward index of the image being visited, walking backwards
		let next: Block[] | undefined;
		for (let j = blocks.length - 1; j >= 0; j--) {
			if (blocks[j]?.type !== "image") continue;
			ordinal--;
			if (++seen <= limit) continue;
			next ??= blocks.slice();
			next[j] = { type: "text", text: placeholder(toolPath ?? names[ordinal]) };
		}
		if (next) out[i] = { ...message, content: next };
	}
	const sent = Math.min(total, limit);
	return { messages: out, total, sent, dropped: total - sent };
}

export default function (pi: ExtensionAPI): void {
	const fromEnv = process.env.PI_IMAGE_WINDOW;
	let limit = parseWindow(fromEnv);
	let source = /^\d+$/.test(fromEnv?.trim() ?? "") ? "PI_IMAGE_WINDOW" : "default";
	let last: { total: number; sent: number; dropped: number } | undefined;

	const showStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!last || last.dropped === 0) return ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg("warning", `images: sent newest ${last.sent} of ${last.total}`) +
				ctx.ui.theme.fg("dim", ` (window ${limit}; /images)`),
		);
	};

	// Footer slot for statusbar.ts: always present; "images –" until the context holds any.
	const publishTab = () => {
		const total = last?.total ?? 0;
		pi.events.emit("statusbar:slot", {
			id: "images",
			text: total ? `images ${last?.sent}/${total}` : "images –",
			state: !total ? "idle" : (last?.dropped ?? 0) > 0 ? "warn" : "ok",
			statusKey: STATUS_KEY,
			details: () => [
				total
					? `${last?.sent} of ${total} sent · window ${limit} (${source}) · older ones become a note naming the file`
					: `none in this session · window ${limit} (${source})`,
				"change the window: /images <n> · /images default",
			],
		});
	};
	pi.events.on("statusbar:ready", publishTab);

	// A resumed session already holds images: show what the next call will send before it happens.
	pi.on("session_start", (_event, ctx) => {
		const total = countImages(ctx.sessionManager.buildSessionContext().messages as Message[]);
		const sent = Math.min(total, limit);
		last = { total, sent, dropped: total - sent };
		publishTab();
	});

	pi.on("context", (event, ctx) => {
		const result = trimImages(event.messages as Message[], limit);
		last = { total: result.total, sent: result.sent, dropped: result.dropped };
		showStatus(ctx);
		publishTab();
		return result.dropped > 0 ? { messages: result.messages as typeof event.messages } : undefined;
	});

	pi.registerCommand("images", {
		description: "Images in context: show counts, or /images <n> to send at most n (default restores)",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg) {
				limit = arg === "default" ? parseWindow(fromEnv) : parseWindow(arg);
				source = arg === "default" ? (/^\d+$/.test(fromEnv?.trim() ?? "") ? "PI_IMAGE_WINDOW" : "default") : "/images";
				const note = arg !== "default" && !/^\d+$/.test(arg) ? ` ("${arg}" is not a count ≥ 0 — using the default)` : "";
				ctx.ui.notify(`image window: newest ${limit} image(s) per request from the next call${note}`, "info");
				return;
			}
			const inSession = countImages(ctx.sessionManager.buildSessionContext().messages as Message[]);
			const lastLine = last
				? `last call: ${last.sent} sent, ${last.dropped} dropped`
				: "no model call yet this session";
			ctx.ui.notify(`images: ${inSession} in session · window ${limit} (${source}) · ${lastLine}`, "info");
		},
	});
}
