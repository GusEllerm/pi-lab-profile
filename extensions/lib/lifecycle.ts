// The one rule that has bitten this profile twice (20 Sept 2026, both times from a timer):
//
//   anything that can still run after session_shutdown -- a timer, a promise continuation, an
//   event handler -- must not touch the captured `pi` or `ctx` without a guard.
//
// `/reload` replaces the activation; from then on every ctx getter and `pi.events.emit` throw
// ("This extension ctx is stale after session replacement or reload"). A throw inside a slash
// command is caught by the host; a throw from a timer is an uncaughtException that takes Pi
// down. Until 13 Oct 2026 each extension carried its own `let dead`, its own dead-checked
// `emit`, and remembered (or not) to reset the flag in session_start -- six hand copies pinned
// by a test that grepped the source. This is the one copy.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BusEvent, Payloads } from "./bus.ts";

export interface Lifecycle {
	/** True from session_shutdown until the next session_start, or once an emit found the activation gone. */
	dead(): boolean;
	/** Emit on the bus unless the activation is dead; an emit that throws marks it dead. Typed for the profile's own events; any other event carries what it likes. */
	emit<E extends BusEvent>(event: E, payload: Payloads[E]): void;
	emit(event: string, payload: unknown): void;
	/** Whether `ctx` is worth drawing into: not dead, present, its getters answer, and it has a UI. Safe to call from a render. */
	alive(ctx: ExtensionContext | undefined): ctx is ExtensionContext;
	/** Runs on session_shutdown, after the flag is set -- for timers and listeners to clear. */
	onShutdown(fn: () => void): void;
}

/** Call once at the top of the factory, before the extension's own session handlers, so they see the flag already set. */
export function lifecycle(pi: ExtensionAPI): Lifecycle {
	let dead = false;
	const shutdown: (() => void)[] = [];
	pi.on("session_start", () => {
		dead = false;
	});
	pi.on("session_shutdown", () => {
		dead = true;
		for (const fn of shutdown) {
			try {
				fn();
			} catch {
				// one cleanup failing must not stop the others on the way out
			}
		}
	});
	return {
		dead: () => dead,
		emit(event: string, payload: unknown): void {
			if (dead) return;
			try {
				pi.events.emit(event, payload);
			} catch {
				dead = true; // the activation went away between the check and the call
			}
		},
		alive(ctx: ExtensionContext | undefined): ctx is ExtensionContext {
			if (dead || !ctx) return false;
			try {
				return ctx.hasUI === true; // the getter throws once the activation is replaced; false is a headless session
			} catch {
				dead = true;
				return false;
			}
		},
		onShutdown(fn: () => void): void {
			shutdown.push(fn);
		},
	};
}
