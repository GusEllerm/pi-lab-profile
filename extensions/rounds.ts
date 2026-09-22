/**
 * rounds — dev → review → critique, run as subagents in sequence.
 *
 *   /round <task>              implement it, review the diff, then verify the review
 *   /round --rounds 2 <task>   hand the surviving findings back to dev and go again
 *   /round --reviewers 1 <task>  one reviewer instead of the panel
 *   /review [what]             review the working tree as it stands (no dev phase)
 *   /round status              what the current run is doing
 *
 * Roles are agent files in ~/.pi/agent/agents: dev (implements and verifies), reviewer (finds real
 * defects, each with a failure scenario), critic (adversarially checks the review and throws out
 * what does not hold). Review is a *panel*: the same reviewer role is run on two different
 * endpoints at once, and the critic sees both. A change is never graded only by the model that
 * wrote it, and one endpoint's blind spot does not become the review's blind spot.
 *
 * Sequencing uses pi-subagents' documented cross-extension RPC — `subagents:rpc:spawn` plus the
 * `subagents:completed` / `subagents:failed` events — so each phase sees the previous phase's output
 * and nothing depends on the main model remembering to chain them. Each run is written to
 * .pi/rounds/<timestamp>.md and its verdict is posted into the session, so the main model can act on
 * it without re-reading the whole transcript.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type SpawnReply = { id?: string; error?: string };
type AgentOutcome = { status?: string; result?: string; error?: string; durationMs?: number; tokens?: { total?: number } };
type Phase = { role: string; title: string; outcome: AgentOutcome };

const DEFAULT_TIMEOUT_MINUTES = 20; // a phase that never reports back should not hang the run forever; rounds.json can change it
const SPAWN_REPLY_MS = 30_000;

type Seat = { model?: string; label: string };
type RoundsConfig = { dev?: string; panel?: Seat[]; critic?: string; timeoutMinutes?: number };

/**
 * Which endpoint each role runs on. Read from rounds.json — project `.pi/rounds.json` first, then
 * `~/.pi/agent/rounds.json` — so the roles themselves stay portable: the agent files carry no
 * `model:` pin, and one config decides where everything runs. That works because a spawn-time
 * model option outranks an agent file's frontmatter (pi-subagents agent-runner.ts: "explicit
 * option > config.model > parent model").
 *
 * With no config, every seat inherits the session's model and a round still works — it is just one
 * model reviewing itself. The value of the panel is *different weights*: two copies of one model
 * share their blind spots, and a seat that differs only by endpoint mostly buys redundancy against
 * a flaky gateway, which the retry below already handles.
 *
 * A model the registry cannot resolve is dropped and that seat falls back to the inherited model,
 * so a config naming endpoints this machine does not have degrades instead of failing.
 */
const DEFAULTS: Required<Pick<RoundsConfig, "panel" | "timeoutMinutes">> = {
	panel: [{ label: "reviewer A" }, { label: "reviewer B" }],
	timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
};

function readConfig(cwd: string): RoundsConfig {
	for (const file of [join(cwd, ".pi", "rounds.json"), join(homedir(), ".pi", "agent", "rounds.json")]) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as RoundsConfig;
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			// missing is normal; malformed should not take the command down with it
		}
	}
	return {};
}

/**
 * The critic's verdict words are the machine-readable part of its output: they build the verdict
 * line and decide whether another dev round runs. `agents/critic.md` asks for a closing
 * `TALLY: confirmed=N plausible=N rejected=N` line, and that is the authority when present. Without
 * one, a verdict is counted only where a line *starts* with the capitalised word -- optionally
 * after a list marker or bold -- and never inside prose. The first version matched the words
 * anywhere, case-insensitively, so "nothing was confirmed" and the critic's own bottom-line
 * paragraph inflated the tally and could start a dev round with nothing to fix.
 */
export const VERDICTS = ["CONFIRMED", "PLAUSIBLE", "REJECTED"] as const;
export type Verdict = (typeof VERDICTS)[number];
const VERDICT_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?(CONFIRMED|PLAUSIBLE|REJECTED)\b/;
const TALLY_LINE = /^\s*TALLY:\s*confirmed\s*=\s*(\d+)\D+plausible\s*=\s*(\d+)\D+rejected\s*=\s*(\d+)/im;
export function tally(critique: string): Record<Verdict, number> {
	const t = TALLY_LINE.exec(critique);
	if (t) return { CONFIRMED: Number(t[1]), PLAUSIBLE: Number(t[2]), REJECTED: Number(t[3]) };
	const out: Record<Verdict, number> = { CONFIRMED: 0, PLAUSIBLE: 0, REJECTED: 0 };
	for (const line of critique.split("\n")) {
		const m = VERDICT_LINE.exec(line);
		if (m) out[m[1] as Verdict]++;
	}
	return out;
}

/**
 * What the next dev round is handed: the critique with its REJECTED findings removed. A finding
 * runs from its verdict line to the next verdict line, heading, or the TALLY line; the preamble
 * before the first verdict and the bottom line after a heading are kept. A critique with no verdict
 * lines at all is passed whole -- there is nothing to filter on, and dropping it would drop the
 * only feedback there is.
 */
export function surviving(critique: string): string {
	const lines = critique.split("\n");
	if (!lines.some((l) => VERDICT_LINE.test(l))) return critique;
	const kept: string[] = [];
	let dropping = false;
	for (const line of lines) {
		const verdict = VERDICT_LINE.exec(line)?.[1];
		if (verdict) dropping = verdict === "REJECTED";
		else if (/^\s*#|^\s*TALLY:/i.test(line)) dropping = false; // a heading or the tally ends any block
		if (!dropping) kept.push(line);
	}
	return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export default function (pi: ExtensionAPI): void {
	/**
	 * A round outlives a `/reload`: its phases are promises, and pi-subagents keeps running the
	 * agents. But the activation that started it is gone, and emitting on a dead `pi` throws — from
	 * an async continuation that is an uncaughtException, which kills the session. So every emit is
	 * dead-checked, and a reload quietly orphans the round rather than taking pi with it.
	 */
	let dead = false;
	/**
	 * Every phase currently waiting on pi-subagents, as a function that settles it. A `/reload` takes
	 * the completion listeners with it -- the host unsubscribes the old activation's `pi.events.on`
	 * -- so a phase in flight would otherwise sit until its 20-minute timer, then retry on a dead
	 * activation and throw from a continuation nothing catches. Shutdown settles them all at once.
	 */
	const pending = new Set<() => void>();
	pi.on("session_shutdown", () => {
		dead = true;
		for (const settle of pending) settle();
		pending.clear();
	});
	const RELOADED: AgentOutcome = { status: "error", error: "session reloaded before this phase finished" };

	function emit(event: string, payload: unknown): void {
		if (dead) return;
		try {
			pi.events.emit(event, payload);
		} catch {
			dead = true;
		}
	}

	let running: { task: string; phase: string; since: number } | undefined;
	let lastSummary: string | undefined;
	let cancelled = false;
	const live = new Set<string>(); // agents this round started and has not yet seen finish

	function publish(text: string, state: "busy" | "idle" | "ok" | "warn", details?: () => string[]): void {
		emit("statusbar:slot", { id: "round", text, state, statusKey: "rounds", details });
	}
	const idleSlot = () =>
		publish(lastSummary ? `round ${lastSummary}` : "round –", lastSummary ? "ok" : "idle", () =>
			lastSummary ? [lastSummary, "/round <task> · /review"] : ["no round yet", "/round <task> · /review"],
		);

	/** Spawn one role through pi-subagents' RPC and wait for its result. */
	async function runPhase(role: string, description: string, prompt: string, model?: string, timeoutMs = DEFAULT_TIMEOUT_MINUTES * 60_000): Promise<AgentOutcome> {
		if (dead) return RELOADED;
		const spawn = (withModel?: string) =>
			new Promise<SpawnReply>((resolve) => {
				if (dead) return resolve({ error: RELOADED.error });
				const requestId = `rounds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				let done = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let unsub = () => {};
				const finish = (reply: SpawnReply) => {
					if (done) return;
					done = true;
					if (timer) clearTimeout(timer);
					unsub();
					pending.delete(abort);
					resolve(reply);
				};
				const abort = () => finish({ error: RELOADED.error });
				// subscribe *before* arming the timer: a throw here (dead activation) must not leave a
				// timer that later reaches for an unsubscriber that was never assigned
				try {
					unsub = pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, (reply: any) =>
						finish(reply?.success ? { id: (reply.data as { id?: string })?.id } : { error: String(reply?.error ?? "spawn refused") }),
					);
				} catch {
					return abort();
				}
				timer = setTimeout(() => finish({ error: "pi-subagents did not answer the spawn request" }), SPAWN_REPLY_MS);
				pending.add(abort);
				emit("subagents:rpc:spawn", {
					requestId,
					type: role,
					prompt,
					options: { description, isBackground: true, bypassQueue: true, ...(withModel ? { model: withModel } : {}) },
				});
			});

		let reply = await spawn(model);
		// an endpoint that is not configured on this machine should cost us the override, not the phase
		if (!reply.id && model && /model (not found|not in scope)/i.test(reply.error ?? "")) reply = await spawn(undefined);
		if (!reply.id) return { status: "error", error: `could not start ${role}: ${reply.error ?? "unknown reason"}` };
		const id = reply.id;
		live.add(id);
		if (cancelled) stopAgent(id); // /round stop landed while this one was still starting up

		const outcome = await new Promise<AgentOutcome>((resolve) => {
			if (dead) return resolve(RELOADED);
			let done = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let unsubscribe = () => {};
			const finish = (result: AgentOutcome) => {
				if (done) return;
				done = true;
				if (timer) clearTimeout(timer);
				unsubscribe();
				pending.delete(abort);
				resolve(result);
			};
			const abort = () => finish(RELOADED);
			const onDone = (data: any) => {
				if (data?.id === id) finish(data as AgentOutcome);
			};
			try {
				const unsubDone = pi.events.on("subagents:completed", onDone);
				const unsubFail = pi.events.on("subagents:failed", onDone);
				unsubscribe = () => {
					unsubDone();
					unsubFail();
				};
			} catch {
				return abort();
			}
			timer = setTimeout(() => {
				// The agent is still running; forgetting it would leave it unreachable by /round stop,
				// its eventual completion nudged into the main model, and a retry running beside it.
				stopAgent(id);
				finish({ status: "error", error: `${role} did not finish within ${Math.round(timeoutMs / 60000)} minutes` });
			}, timeoutMs);
			pending.add(abort);
		});
		// we report the result ourselves; stop pi-subagents notifying about it as well (must be
		// inside the 200ms nudge hold, so no awaits between the event and this emit)
		emit("subagents:rpc:consume", { requestId: `rounds-consume-${id}`, agentId: id });
		live.delete(id);
		return outcome;
	}

	function stopAgent(id: string): void {
		emit("subagents:rpc:stop", { requestId: `rounds-stop-${id}`, agentId: id });
	}

	const text = (o: AgentOutcome) => o.result?.trim() || o.error?.trim() || "(no output)";
	/**
	 * A phase is unusable if it errored, was stopped, or said nothing. The last case is real: a
	 * gpt-oss model occasionally ends a turn having produced only reasoning, and an empty review
	 * handed to the critic is worse than one reviewer fewer.
	 */
	const failed = (o: AgentOutcome) =>
		Boolean(o.error) || (o.status !== undefined && o.status !== "completed") || !o.result?.trim();
	/** One line a human can act on: how many findings survived the critic. */
	function verdictLine(critique: string | undefined): string {
		if (!critique) return "no critique";
		const { CONFIRMED: confirmed, PLAUSIBLE: plausible, REJECTED: rejected } = tally(critique);
		if (!confirmed && !plausible && !rejected) return "no findings";
		return [
			confirmed ? `${confirmed} confirmed` : "",
			plausible ? `${plausible} plausible` : "",
			rejected ? `${rejected} rejected` : "",
		]
			.filter(Boolean)
			.join(" · ");
	}

	/** "(1m12s · 38k tok)" for a heading, from the fields pi-subagents puts on every outcome. */
	function phaseCost(o: AgentOutcome): string {
		const bits = [
			o.durationMs ? (o.durationMs >= 60_000 ? `${Math.floor(o.durationMs / 60_000)}m${String(Math.round((o.durationMs % 60_000) / 1000)).padStart(2, "0")}s` : `${Math.round(o.durationMs / 1000)}s`) : "",
			o.tokens?.total ? `${o.tokens.total >= 1000 ? `${(o.tokens.total / 1000).toFixed(o.tokens.total >= 10_000 ? 0 : 1)}k` : o.tokens.total} tok` : "",
		].filter(Boolean);
		return bits.length ? ` (${bits.join(" · ")})` : "";
	}

	/** Returns the path written, or the reason it was not -- a silent undefined hid failures from the final notify. */
	function writeReport(ctx: ExtensionContext, task: string, phases: Phase[], verdict: string): { file?: string; error?: string } {
		try {
			const dir = join(ctx.cwd, ".pi", "rounds");
			mkdirSync(dir, { recursive: true });
			// second-granular stamps collide (two rounds a second apart used to overwrite); the suffix
			// and the exclusive flag make a collision a visible error rather than a lost report
			const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const file = join(dir, `${stamp}-${Math.random().toString(36).slice(2, 6)}.md`);
			const body = [
				`# ${task}`,
				`\n_${new Date().toISOString()} — ${verdict}_\n`,
				...phases.map((p) => `\n## ${p.title}${phaseCost(p.outcome)}\n\n${text(p.outcome)}\n`),
			].join("\n");
			writeFileSync(file, body, { flag: "wx" });
			return { file };
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		}
	}

	/**
	 * pi-subagents answers `subagents:rpc:ping` once it has bound a session. A session that does not
	 * have it is indistinguishable from it not being installed, so ask before starting a run —
	 * otherwise the first spawn just sits there for the full reply timeout and then blames itself.
	 */
	function subagentsReady(): Promise<boolean> {
		return new Promise((resolve) => {
			const requestId = `rounds-ping-${Date.now()}`;
			const timer = setTimeout(() => {
				unsub();
				resolve(false);
			}, 1000);
			const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, () => {
				clearTimeout(timer);
				unsub();
				resolve(true);
			});
			emit("subagents:rpc:ping", { requestId });
		});
	}

	async function round(ctx: ExtensionContext, task: string, rounds: number, skipDev: boolean, seats: number): Promise<void> {
		if (running) return ctx.ui.notify(`A round is already running (${running.phase}). /round stop ends it.`, "warning");
		// Claimed before the await below: a second /round or /review issued during the readiness ping
		// used to pass this guard too, and the two then shared `live`, `cancelled` and `running`.
		running = { task, phase: "starting", since: Date.now() };
		if (!(await subagentsReady())) {
			running = undefined;
			return ctx.ui.notify(
				"/round needs @tintinweb/pi-subagents, which is not answering in this session.\n" +
					"Install it with:  pi install npm:@tintinweb/pi-subagents",
				"error",
			);
		}
		cancelled = false;
		live.clear();
		const phases: Phase[] = [];
		const cfg = readConfig(ctx.cwd);
		const configured = cfg.panel?.length ? cfg.panel : DEFAULTS.panel;
		const panel = configured.slice(0, Math.max(1, Math.min(configured.length, seats)));
		const timeoutMs = Math.max(1, cfg.timeoutMinutes ?? DEFAULTS.timeoutMinutes) * 60_000;
		const announce = (phase: string) => {
			if (dead) return; // ctx throws now; the slot emit below is dead-checked on its own
			if (running) running.phase = phase;
			if (ctx.hasUI) ctx.ui.setStatus("rounds", undefined); // the sidebar slot is the one place this shows
			publish(`round ${phase}`, "busy", () => [phase, task.slice(0, 60), `${Math.round((Date.now() - (running?.since ?? 0)) / 1000)}s · /round stop`]);
		};

		try {
			let carry = ""; // what the previous phase produced, handed to the next one
			for (let i = 1; i <= rounds; i++) {
				const suffix = rounds > 1 ? ` (round ${i}/${rounds})` : "";
				if (!skipDev) {
					announce(`dev${suffix}`);
					const dev = await runPhase(
						"dev",
						`dev${suffix}: ${task.slice(0, 40)}`,
						carry ? `${task}\n\nA previous round's critic confirmed these findings; address them:\n${carry}` : task,
						cfg.dev,
						timeoutMs,
					);
					phases.push({ role: "dev", title: `Dev${suffix}`, outcome: dev });
					if (dead) return;
					if (failed(dev) || cancelled) break;
					carry = text(dev);
				}

				announce(`review${suffix}`);
				const brief =
					`Review the current change in this repository.\n\nThe task was:\n${task}\n` +
					`${carry ? `\nWhat the implementer reported:\n${carry}\n` : ""}\nRead the diff yourself and judge the code, not the description.`;
				const seatName = (n: number) => `review${suffix}${panel.length > 1 ? ` ${String.fromCharCode(65 + n)}` : ""}`;
				let seated = await Promise.all(
					panel.map((seat, n) => runPhase("reviewer", seatName(n), brief, seat.model, timeoutMs).then((outcome) => ({ seat, n, outcome }))),
				);
				// One retry per seat. These endpoints drop a turn now and then, and a seat that says
				// nothing costs the panel a whole viewpoint for a failure that usually does not repeat.
				if (dead) return;
				seated = await Promise.all(
					seated.map(async (s) =>
						failed(s.outcome) && !cancelled && !dead ? { ...s, outcome: await runPhase("reviewer", `${seatName(s.n)} retry`, brief, s.seat.model, timeoutMs) } : s,
					),
				);
				if (dead) return;
				seated.forEach(({ seat, outcome }) =>
					phases.push({ role: "reviewer", title: `Review${suffix}${panel.length > 1 ? ` — ${seat.label}` : ""}`, outcome }),
				);
				const usable = seated.filter((s) => !failed(s.outcome));
				if (!usable.length || cancelled) break;

				announce(`critique${suffix}`);
				const merged = usable.map(({ seat, outcome }) => `--- ${seat.label} ---\n${text(outcome)}`).join("\n\n");
				const critique = await runPhase(
					"critic",
					`critique${suffix}`,
					`Verify these reviews against the code in this repository.\n\nThe task was:\n${task}\n\n` +
						`${usable.length > 1 ? `${usable.length} reviewers looked at this change independently. Merge findings that are the same defect, and judge each distinct finding once.\n\n` : ""}` +
						`The reviews to verify:\n${merged}`,
					cfg.critic,
					timeoutMs,
				);
				phases.push({ role: "critic", title: `Critique${suffix}`, outcome: critique });
				if (dead) return;
				if (failed(critique) || cancelled) break;

				if (!tally(text(critique)).CONFIRMED) break; // nothing survived: another dev pass has nothing to fix
				carry = surviving(text(critique)); // the next round works from what survived scrutiny -- not from what was thrown out
			}

			if (dead) return; // writeReport reads ctx.cwd, which throws on a replaced activation
			const critique = [...phases].reverse().find((p) => p.role === "critic" && !failed(p.outcome));
			const verdict = cancelled ? `stopped after ${phases.length} phase${phases.length === 1 ? "" : "s"}` : verdictLine(critique ? text(critique.outcome) : undefined);
			const report = writeReport(ctx, task, phases, verdict);
			const file = report.file;
			lastSummary = verdict;
			// What goes into the session is what the main model can act on: the critique in full, the
			// other phases trimmed. The whole thing is on disk, and a round that pastes three agent
			// transcripts into the context window has spent the budget it was meant to save.
			const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).trimEnd()}\n… (${s.length - n} more characters in the report)`);
			pi.sendMessage(
				{
					customType: "rounds",
					content: [
						`Round ${cancelled ? "stopped" : "finished"}: ${task}`,
						`Verdict: ${verdict}`,
						...phases.map((p) => `\n### ${p.title}\n${clip(text(p.outcome), p.role === "critic" ? 6000 : 1200)}`),
						file ? `\n(report: ${file})` : "",
					].join("\n"),
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
			const broken = cancelled ? 0 : phases.filter((p) => failed(p.outcome)).length; // a stopped phase is not a broken one
			ctx.ui.notify(
				`Round ${cancelled ? "stopped" : "finished"} — ${verdict}${broken ? ` · ${broken} phase${broken === 1 ? "" : "s"} failed` : ""}` +
					(file ? ` · ${file}` : report.error ? ` · report not written: ${report.error}` : ""),
				broken || cancelled || report.error ? "warning" : "info",
			);
		} finally {
			running = undefined;
			idleSlot();
		}
	}

	/**
	 * A round runs for minutes after the command that started it has returned, so the host's catch
	 * around command handlers does not cover it: a rejection here is an unhandled one, and pi has no
	 * unhandledRejection handler -- on Node 22 that exits the process. This is the only catch it has.
	 */
	function launch(ctx: ExtensionContext, work: Promise<void>): void {
		work.catch((error) => {
			if (dead) return; // nothing left to tell, and nothing to tell it with
			try {
				ctx.ui.notify(`Round failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} catch {
				// the activation went away between the rejection and this line
			}
		});
	}

	/** `--rounds N` and `--reviewers N` in any order, before the task text. */
	function parse(arg: string, cwd: string): { rounds: number; seats: number; task: string } {
		let rounds = 1;
		const configured = readConfig(cwd).panel;
		let seats = (configured?.length ? configured : DEFAULTS.panel).length; // the same rule round() applies
		let rest = arg;
		for (;;) {
			const m = /^--(rounds|reviewers)[\s=]+(\d+)\s*([\s\S]*)$/.exec(rest);
			if (!m) break;
			const n = Math.min(5, Math.max(1, Number(m[2])));
			if (m[1] === "rounds") rounds = n;
			else seats = n;
			rest = m[3];
		}
		return { rounds, seats, task: rest.trim() };
	}

	pi.registerCommand("round", {
		description: "dev → review → critique: /round <task> · --rounds N · --reviewers N · /round status · /round stop",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "stop") {
				if (!running) return ctx.ui.notify("No round is running.", "info");
				cancelled = true;
				const n = live.size;
				for (const id of live) stopAgent(id);
				return ctx.ui.notify(`Stopping the round — ${n} agent${n === 1 ? "" : "s"} asked to stop.`, "warning");
			}
			if (!arg || arg === "status") {
				return ctx.ui.notify(
					running
						? `round: ${running.phase} · ${Math.round((Date.now() - running.since) / 1000)}s · ${running.task}`
						: `No round is running.${lastSummary ? ` Last: ${lastSummary}.` : ""} /round <task>`,
					"info",
				);
			}
			const { rounds, seats, task } = parse(arg, ctx.cwd);
			if (!task) return ctx.ui.notify("Nothing to do: /round <task>", "warning");
			launch(ctx, round(ctx, task, rounds, false, seats));
		},
	});

	pi.registerCommand("rounds", {
		description: "Past rounds in this repo: pick one to bring its report back into the conversation",
		handler: async (_args, ctx) => {
			const dir = join(ctx.cwd, ".pi", "rounds");
			let files: string[];
			try {
				files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
			} catch {
				files = [];
			}
			if (!files.length) return ctx.ui.notify("No rounds have run in this repository yet. /round <task>", "info");
			const entries = files.slice(0, 20).map((f) => {
				const head = readFileSync(join(dir, f), "utf8").split("\n").slice(0, 4);
				const task = (head.find((l) => l.startsWith("# ")) ?? "# ?").slice(2);
				const meta = head.find((l) => l.startsWith("_")) ?? "";
				const verdict = meta.includes("—") ? meta.split("—").pop()!.replace(/_/g, "").trim() : "";
				return { file: f, label: `${f.slice(0, 16).replace("T", " ")}  ${verdict ? `${verdict} · ` : ""}${task}` };
			});
			// ui.select takes plain strings and gives one back, so map the label to its file
			const labels = entries.map((e) => e.label);
			const picked = await ctx.ui.select("Rounds in this repository", labels);
			const chosen = entries[labels.indexOf(picked)]; // by position: two rounds with one task and verdict share a label
			if (!chosen) return;
			const body = readFileSync(join(dir, chosen.file), "utf8");
			pi.sendMessage(
				{ customType: "rounds", content: `Round report ${chosen.file}:\n\n${body.slice(0, 12000)}`, display: true },
				{ deliverAs: "followUp", triggerTurn: false },
			);
		},
	});

	pi.registerCommand("review", {
		description: "Review the working tree as it stands, then verify the review: /review [what to focus on]",
		handler: async (args, ctx) => {
			const { seats, task } = parse(args.trim(), ctx.cwd);
			launch(ctx, round(ctx, task || "the current uncommitted change", 1, true, seats));
		},
	});

	// the bar re-emits this at session start, so the slot appears whatever order extensions load in
	pi.events.on("statusbar:ready", () => idleSlot());
	pi.on("session_start", () => idleSlot());
}
