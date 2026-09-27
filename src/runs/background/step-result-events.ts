/**
 * Bridge a run's durable event log onto the parent's event bus.
 *
 * A run's orchestrator is a separate process (`async-execution.ts` spawns it), so the
 * `subagent.step.result.completed` line it appends to `<asyncDir>/events.jsonl` can
 * never be emitted on the parent's `pi.events` bus directly. Without this bridge a
 * parent sleeping in `subagent_wait` learns about a finished child only when its own
 * poll interval elapses, which is why the wake guarantee needs a reader in the parent:
 * the durable log stays the source of truth, and this makes delivery prompt.
 *
 * Consumers dedupe, by design:
 *   * `subagent_wait` reports each child once through the shared consumed-result set;
 *   * the step notifier tracks the keys it already queued.
 * So re-emitting a line a consumer has already seen is safe, and a missed emission is
 * not a lost result - the artifact scan and the wait's own state check still find it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SUBAGENT_STEP_RESULT_EVENT, type SubagentState } from "../../shared/types.ts";

const DEFAULT_POLL_INTERVAL_MS = 250;
const EVENTS_FILE_NAME = "events.jsonl";
const STEP_RESULT_EVENT_TYPE = "subagent.step.result.completed";

export interface StepResultEventSource {
	asyncId: string;
	asyncDir: string;
	status: string;
}

export interface TimerApi {
	setInterval(handler: () => void, delayMs: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface StepResultEventBridgeDeps {
	/** Active runs to watch. Only queued/running runs publish new results. */
	runs: () => Iterable<StepResultEventSource>;
	events: { emit(channel: string, payload: unknown): void };
	fs?: {
		readFileSync(file: string, encoding: "utf8"): string;
		existsSync(file: string): boolean;
	};
	timers?: TimerApi;
	pollIntervalMs?: number;
	logError?: (message: string, error: unknown) => void;
}

export interface StepResultEventBridge {
	/** Read new lines now. Exposed so tests need no timers. */
	tick(): void;
	dispose(): void;
}

interface Cursor {
	offset: number;
}

/** Unref an interval so a bridge never keeps the process alive on its own. */
function unref(handle: unknown): void {
	try {
		(handle as { unref?: () => void }).unref?.();
	} catch {
		/* not fatal: a ref'd timer would only delay process exit */
	}
}

export function createStepResultEventBridge(deps: StepResultEventBridgeDeps): StepResultEventBridge {
	const fsApi = deps.fs ?? fs;
	const cursors = new Map<string, Cursor>();
	let disposed = false;

	const emitLine = (run: StepResultEventSource, line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// A partially written line is re-read on the next tick from the same offset,
			// so this is only reachable for genuinely malformed content.
			return;
		}
		if (!parsed || typeof parsed !== "object") return;
		const event = parsed as Record<string, unknown>;
		if (event.type !== STEP_RESULT_EVENT_TYPE) return;
		if (typeof event.stepIndex !== "number") return;
		deps.events.emit(SUBAGENT_STEP_RESULT_EVENT, {
			runId: typeof event.runId === "string" ? event.runId : run.asyncId,
			stepIndex: event.stepIndex,
			agent: typeof event.agent === "string" ? event.agent : undefined,
			state: typeof event.state === "string" ? event.state : undefined,
			resultPath: typeof event.resultPath === "string" ? event.resultPath : undefined,
			ts: typeof event.ts === "number" ? event.ts : undefined,
		});
	};

	const tick = () => {
		if (disposed) return;
		const seen = new Set<string>();
		for (const run of deps.runs()) {
			if (run.status !== "queued" && run.status !== "running") continue;
			seen.add(run.asyncId);
			const file = path.join(run.asyncDir, EVENTS_FILE_NAME);
			let content: string;
			try {
				if (!fsApi.existsSync(file)) continue;
				content = fsApi.readFileSync(file, "utf8");
			} catch (error) {
				deps.logError?.(`Failed to read ${file}`, error);
				continue;
			}
			// Reading the whole file and slicing keeps the common case (a small, actively
			// appended log) simple; the cursor bounds repeated work to what is new. Safety
			// does not depend on the cursor: consumers dedupe, and the artifact scan
			// remains the reconciliation path if this ever misses a line.
			let cursor = cursors.get(run.asyncId);
			if (!cursor) {
				cursor = { offset: 0 };
				cursors.set(run.asyncId, cursor);
			}
			if (content.length < cursor.offset) {
				// The file was truncated or replaced; re-read from the start.
				cursor.offset = 0;
			}
			if (content.length === cursor.offset) continue;
			const fresh = content.slice(cursor.offset);
			const lastNewline = fresh.lastIndexOf("\n");
			if (lastNewline === -1) continue; // no complete line yet
			cursor.offset += lastNewline + 1;
			for (const line of fresh.slice(0, lastNewline).split("\n")) {
				emitLine(run, line);
			}
		}
		for (const asyncId of [...cursors.keys()]) {
			if (!seen.has(asyncId)) cursors.delete(asyncId);
		}
	};

	const timers = deps.timers ?? {
		setInterval: (handler: () => void, delayMs: number) => setInterval(handler, delayMs),
		clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
	};
	const interval = timers.setInterval(tick, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	unref(interval);

	return {
		tick,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			timers.clearInterval(interval);
			cursors.clear();
		},
	};
}

/**
 * Register the bridge for the extension's own lifecycle.
 *
 * Returns a disposer; the caller registers the timer and clears it on shutdown, the
 * same shape as the other background registrations in `extension/index.ts`.
 */
export function registerStepResultEvents(
	pi: { events: { emit(channel: string, payload: unknown): void } },
	state: SubagentState,
	options: Pick<StepResultEventBridgeDeps, "fs" | "timers" | "pollIntervalMs" | "logError"> = {},
): () => void {
	const bridge = createStepResultEventBridge({
		runs: () => state.asyncJobs.values(),
		events: pi.events,
		...options,
	});
	return () => bridge.dispose();
}
