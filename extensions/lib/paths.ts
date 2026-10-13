// Where Pi's agent directory is, and the one way the extensions read a JSON file from it.
//
// Pi honours PI_CODING_AGENT_DIR (the newcomer test in docs/development.md relies on it:
// PI_CODING_AGENT_DIR=/tmp/pi-clean). Until 13 Oct 2026 two extensions resolved ~/.pi/agent on
// their own and silently read the author's real rounds.json and subagents.json inside that
// "clean" test -- the sixth hand-copy of this one line was the one that drifted.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Pi's agent directory: $PI_CODING_AGENT_DIR, else ~/.pi/agent. Read at call time, not import time, so a test can set the variable. */
export const agentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** A JSON object from a file, or undefined when the file is missing, unreadable or not an object -- missing is normal, malformed must not take a feature down. */
export function readJson<T extends object = Record<string, unknown>>(file: string): T | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
	} catch {
		return undefined;
	}
}
