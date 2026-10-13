// The protocol between the extensions, in one place.
//
// They talk over Pi's event bus and nowhere else (one direct import: argo borrows outputs' pager).
// statusbar.ts owns the column and is the hub: anything with something to show publishes a Slot,
// and replays it when statusbar says it is ready, so load order never matters. Until 13 Oct 2026
// the event names were string literals in eight files and the payload types were exported from
// statusbar.ts and imported by nobody -- hpc-bridge had its own SlotState without "plain", fleet
// published a field nothing read, and a listener survived its only emitter by three weeks.
// A payload type here is the contract; an emit or an `on` that does not match it is a type error.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export type SlotState = "ok" | "warn" | "error" | "busy" | "idle" | "plain";

/** One line of the column and footer, published by whichever extension knows the fact. */
export interface Slot {
	id: string;
	text: string;
	state?: SlotState;
	/** setStatus() key this slot stands in for; its raw text is not repeated under OTHER. */
	statusKey?: string;
	/** Tokens attributable to this slot's work -- fleet publishes the subagent total here. */
	tokens?: number;
	/** The expanded rows (dashboard, column section); runs on demand, so keep it cheap. */
	details?: () => string[];
}

/** What the column shows instead of the session's own numbers while attached to a subagent. */
export interface AttachedStats {
	status: string;
	modelId?: string;
	contextPercent: number | null;
	tokens: number;
	output: number;
	turns: number;
	rate?: number;
	elapsedMs: number;
}

/** fleet → statusbar and outputs: the agent whose transcript the pane shows; `{}` detaches. */
export interface Attached {
	name: string;
	/** The agent's session branch, read at call time: it keeps growing under /open. */
	branch: () => readonly unknown[];
	stats: () => AttachedStats;
}

/** liveness → fleet: the latest verdict per agent id, for the ⏳/⚠ marks on the list. */
export interface LivenessMark {
	level: string;
	summary: string;
}

/** Every event, with what rides on it. `Record<string, never>` is the empty object. */
export interface Payloads {
	"statusbar:slot": Slot;
	/** statusbar's activation is listening: publishers resend their slot. */
	"statusbar:ready": Record<string, never>;
	"statusbar:attached": Attached | Record<string, never>;
	/** fleet → statusbar: the component to put where the transcript is; `{}` restores it. */
	"statusbar:transcript": { component?: Component };
	/** endpoints → everyone: provider id → the short name the column uses ("globus3"). */
	"statusbar:endpoint-labels": Record<string, string>;
	"liveness:agents": Record<string, LivenessMark>;
	/** argo → endpoints: whether the tunnel answers and how many models it registered. */
	"argo:health": { up: boolean; port?: number; models: number };
}
export type BusEvent = keyof Payloads;

/** Subscribe with the payload typed; the host hands `unknown`, and an emitter may send nothing. */
export function on<E extends BusEvent>(pi: ExtensionAPI, event: E, handler: (payload: Payloads[E] | undefined) => void): () => void {
	return pi.events.on(event, handler as (data: unknown) => void);
}

/**
 * The endpoint-label map an extension keeps: provider id → short name, filled from
 * `statusbar:endpoint-labels` as endpoints publishes it. Three extensions kept this map with
 * three identical handlers; `onChange` is for the one that must redraw when it moves.
 */
export function endpointLabels(pi: ExtensionAPI, onChange?: () => void): Map<string, string> {
	const labels = new Map<string, string>();
	on(pi, "statusbar:endpoint-labels", (data) => {
		for (const [provider, label] of Object.entries(data ?? {})) labels.set(provider, label);
		onChange?.();
	});
	return labels;
}
