/**
 * `subagent_wait` tool: block the current turn until outstanding async runs
 * or a named remembered detached foreground run finishes.
 *
 * Background subagent runs are detached. In an interactive session the parent
 * can end its turn and Pi will wake it with a completion notification. That
 * does not work when the parent is a skill that must run to completion, and it
 * cannot work at all non-interactively (`pi -p ...`), where the run is a single
 * turn: once the turn ends there is nothing left to receive the notification.
 *
 * `subagent_wait` closes that gap. It keeps the turn alive until a tracked async
 * run for this session reaches a terminal state (complete / failed / paused),
 * the caller-supplied timeout elapses, a supervisor checkpoint returns control,
 * or the turn is aborted. A checkpoint leaves work running and gives the caller
 * handles to inspect or continue waiting.
 *
 * By default `subagent_wait` returns as soon as ONE child of a parallel batch has
 * published a result, so a parent can act on a partial batch instead of blocking
 * for the slowest child: it consumes what is ready and repeating the call drains
 * the children that finish later. `all: true`, `until: "all-terminal"`, and
 * `barrier: "integration"` block until every tracked run is terminal, and
 * `until: "any-change"` returns at the first tracked run's completion for a
 * rolling-replacement loop (launch N workers, wait for the next to finish, spawn
 * its replacement, wait again). Use `id` to block on one specific async or
 * remembered detached foreground run.
 *
 * Returns results, not just status. Terminal children publish an artifact under
 * `<asyncDir>/step-results/step-<index>.json` as each child finishes (see
 * `runs/shared/step-results.ts`), so a wait can hand the caller the child's
 * output instead of a status line that forces a second `subagent({ action:
 * "status" })` round trip. `until: "first-result"` goes further: it returns as
 * soon as one child of the tracked run(s) has published a result, without
 * waiting for the rest of the batch, and consumes that result so repeated calls
 * drain children one at a time instead of re-reporting the same one.
 *
 * `subagent_wait` also returns when a run needs attention — not just on
 * completion. A child that goes idle or blocks for a decision surfaces
 * `needs_attention` (the same signal Pi shows as a control notice and,
 * interactively, wakes the parent with). Since `subagent_wait` is used exactly
 * where there is no next turn to receive that notice, it must break on it too,
 * or a stuck child would stall the loop until the timeout. Attention runs are
 * reported so the caller can inspect / nudge / resume / interrupt them.
 *
 * Wake mechanism: when given Pi's event bus (`deps.events`), `subagent_wait`
 * subscribes to the subagent completion/control channels and wakes the instant
 * any fires, rather than waiting out a fixed poll interval. A poll still runs
 * on the interval as a reconciliation fallback (crashed runners, missed
 * events), and the poll is the source of truth for what actually changed — the
 * event only ends the sleep early. With no bus, `subagent_wait` degrades to pure
 * polling.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	listBackgroundWorkWakeChannels,
	snapshotBackgroundWork,
	type BackgroundWorkSnapshot,
	type RegisteredBackgroundWorkItem,
} from "../../api/background-work.ts";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import {
	consumedStepResultSet,
	listStepResultArtifacts,
	markStepResultConsumed,
	stepResultArtifactPath,
	stepResultKey,
	type StepResultArtifact,
	type StepResultPresentation,
} from "../shared/step-results.ts";
import { truncateOutput } from "../../shared/types.ts";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	SUBAGENT_STEP_RESULT_EVENT,
	type Details,
	type ForegroundResumeRun,
	type SubagentState,
	type SupervisorCheckpoint,
} from "../../shared/types.ts";
import { formatDuration } from "../../shared/formatters.ts";
export { WAIT_TOOL_ENABLED_ENV, resolveWaitToolConfig, type ResolvedWaitToolConfig } from "./wait-config.ts";

/** States that mean a run is still in flight (not yet resolved). */
const ACTIVE_STATES: ReadonlyArray<AsyncRunSummary["state"]> = ["queued", "running"];

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MIN_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface SubagentWaitParams {
	/** Preferred root run ID or prefix to wait for. */
	runId?: string;
	/** Compatibility alias for runId. */
	id?: string;
	/** Why this blocking barrier is required. */
	barrier?: "consume-result" | "integration";
	/** Preferred completion condition. */
	/**
	 * Preferred completion condition. `"next-event"` is the sleep spelling: return on
	 * the first thing that happens - a child publishes a result, a tracked run reaches
	 * a terminal state, a run needs attention, or the configured checkpoint is reached.
	 * It uses
	 * the same consumption and dedupe mechanics as `"first-result"`, so repeated calls
	 * report each child once instead of re-reporting the same one.
	 */
	until?: "any-change" | "all-terminal" | "first-result" | "next-event";
	/**
	 * When true, block until EVERY active run in this session (or matching `id`)
	 * is terminal. Default false, which now means the first-result condition: return
	 * as soon as one finished child publishes a result. Use `until: "any-change"`
	 * when you want to return at the first tracked run's completion instead (a
	 * rolling-replacement loop over several runs).
	 */
	all?: boolean;
	/** Upper bound for this call. Defaults to 30 minutes; an interactive supervisor checkpoint may return earlier. */
	timeoutMs?: number;
}

/** Minimal event-bus surface wait subscribes to (matches pi.events). */
export interface WaitEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface SubagentWaitDeps {
	state: SubagentState;
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	pollIntervalMs?: number;
	/** False makes the tool return immediately without blocking active async runs. */
	enabled?: boolean;
	/** Interactive supervisor checkpoint budget; omitted for headless auto-drain. */
	checkpointMs?: number;
	/** Injectable sleep for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Internal auto-drain mode waits through needs-attention states. */
	stopOnAttention?: boolean;
	/** Internal auto-drain mode surfaces failed terminal subagent runs as errors. */
	failOnFailedRuns?: boolean;
	/** Injectable provider protocol surfaces for deterministic tests. */
	backgroundWork?: {
		snapshot(sessionId: string, nowMs: number): BackgroundWorkSnapshot;
		wakeChannels(): readonly string[];
	};
	/**
	 * Optional event bus (pi.events). When provided, wait wakes immediately on a
	 * subagent completion/control event instead of waiting out the poll interval;
	 * the poll then remains as a reconciliation fallback (crashed runners, missed
	 * events). Omit in tests that want pure poll behavior.
	 */
	events?: WaitEventBus;
}

/** Bus channels that indicate a run changed state or needs attention. */
const WAKE_CHANNELS = [
	// A child publishing a result is a state change a sleeper cares about. Without this
	// channel the loop would notice it only on the next poll interval, which is the
	// difference between waking on the event and polling for it.
	SUBAGENT_STEP_RESULT_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
];

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Sleep up to `ms`, but wake early if a subagent event fires on the bus (or the
 * turn aborts). Returns when the first of those happens. With no bus this is a
 * plain sleep, so the poll interval alone drives progress.
 */
function waitForWake(ms: number, signal: AbortSignal | undefined, deps: SubagentWaitDeps): Promise<void> {
	const sleep = deps.sleep ?? defaultSleep;
	const events = deps.events;
	if (!events) return sleep(ms, signal);
	const providerChannels = deps.backgroundWork?.wakeChannels() ?? listBackgroundWorkWakeChannels();
	return new Promise((resolve, reject) => {
		let settled = false;
		const unsubs: Array<() => void> = [];
		const wakeController = new AbortController();
		const done = () => {
			if (settled) return;
			settled = true;
			wakeController.abort();
			signal?.removeEventListener("abort", done);
			for (const u of unsubs) {
				try { u(); } catch { /* best effort */ }
			}
			resolve();
		};
		if (signal?.aborted) {
			done();
			return;
		}
		signal?.addEventListener("abort", done, { once: true });
		try {
			for (const channel of [...new Set([...WAKE_CHANNELS, ...providerChannels])]) {
				unsubs.push(events.on(channel, done));
			}
		} catch (error) {
			signal?.removeEventListener("abort", done);
			for (const unsubscribe of unsubs) {
				try { unsubscribe(); } catch { /* best effort cleanup */ }
			}
			reject(error);
			return;
		}
		// Poll-interval fallback so we still reconcile even if no event arrives.
		// The local signal cancels that fallback timer when an event wakes us first.
		void sleep(ms, wakeController.signal).then(done);
	});
}

function matchesId(run: AsyncRunSummary, id: string): boolean {
	return run.id === id || run.id.startsWith(id);
}

function activeDetachedForegroundRuns(params: SubagentWaitParams, deps: SubagentWaitDeps): ForegroundResumeRun[] {
	if (!params.id || !deps.state.foregroundRuns) return [];
	const sessionId = deps.state.currentSessionId;
	if (!sessionId) return [];
	return [...deps.state.foregroundRuns.values()].filter((run) =>
		(run.runId === params.id || run.runId.startsWith(params.id!))
		&& run.sessionId === sessionId
		&& run.children.some((child) => child.status === "detached")
	);
}

function summarizeForegroundChildren(run: ForegroundResumeRun, indices: Set<number>): string {
	const counts = new Map<string, number>();
	for (const child of run.children) {
		if (!indices.has(child.index) || child.status === "detached") continue;
		counts.set(child.status, (counts.get(child.status) ?? 0) + 1);
	}
	return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
}

/** A running run that has flagged it needs the parent's attention. */
function needsAttention(run: AsyncRunSummary): boolean {
	return run.activityState === "needs_attention";
}

function backgroundWorkIdentity(item: RegisteredBackgroundWorkItem): string {
	return `${item.provider}\0${item.sessionId}\0${item.id}`;
}

function backgroundWorkForSession(deps: SubagentWaitDeps, nowMs: number): BackgroundWorkSnapshot {
	const sessionId = deps.state.currentSessionId;
	if (!sessionId) throw new Error("subagent_wait requires an active session identity to scope background work safely.");
	return deps.backgroundWork?.snapshot(sessionId, nowMs) ?? snapshotBackgroundWork(sessionId, nowMs);
}

/** Queued/running runs from this session, including runs that need attention. */
function activeRunsForSession(params: SubagentWaitParams, deps: SubagentWaitDeps): AsyncRunSummary[] {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const runs = listAsyncRuns(asyncDirRoot, {
		states: [...ACTIVE_STATES],
		sessionId: deps.state.currentSessionId ?? undefined,
		resultsDir,
		kill: deps.kill,
		now: deps.now,
	});
	return params.id ? runs.filter((run) => matchesId(run, params.id!)) : runs;
}

/** Runs (from the initial set) currently flagged needs_attention, for reporting. */
function attentionRunsForSession(params: SubagentWaitParams, deps: SubagentWaitDeps, initialIds: Set<string>): AsyncRunSummary[] {
	return activeRunsForSession(params, deps).filter((run) => needsAttention(run) && initialIds.has(run.id));
}

/** All runs (any state) for this session, for the final summary. */
function allRunsForSession(params: SubagentWaitParams, deps: SubagentWaitDeps): AsyncRunSummary[] {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const runs = listAsyncRuns(asyncDirRoot, {
		sessionId: deps.state.currentSessionId ?? undefined,
		resultsDir,
		kill: deps.kill,
		now: deps.now,
	});
	return params.id ? runs.filter((run) => matchesId(run, params.id!)) : runs;
}

function summarizeTerminalRuns(runs: AsyncRunSummary[], providerFinishedCount = 0): string {
	if (runs.length === 0 && providerFinishedCount === 0) return "";
	const counts = { complete: 0, failed: 0, paused: 0 } as Record<string, number>;
	for (const run of runs) {
		if (run.state in counts) counts[run.state] += 1;
	}
	const parts: string[] = [];
	if (counts.complete) parts.push(`${counts.complete} complete`);
	if (counts.failed) parts.push(`${counts.failed} failed`);
	if (counts.paused) parts.push(`${counts.paused} paused`);
	if (providerFinishedCount > 0) parts.push(`${providerFinishedCount} provider item(s) finished`);
	return parts.join(", ");
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

/** One child's result as the parent receives it in a wait result. */
export interface WaitStepResultView {
	runId: string;
	stepIndex: number;
	agent: string;
	state: StepResultArtifact["state"];
	success: boolean;
	endedAt: number;
	output: string;
	error?: string;
	artifactPath: string;
}

/** Wait results stay small: a batch of children may each carry a large output. */
const WAIT_STEP_RESULT_MAX = { bytes: 8 * 1024, lines: 120 };

/**
 * Total budget for all children in one wait result.
 *
 * Per-child truncation alone does not bound the result: a 40-child batch at 8 KiB
 * each would inline 320 KiB into the tool content and `details.stepResults`.
 * Children past the budget are reported by name, state, and artifact path only.
 */
const WAIT_STEP_RESULTS_TOTAL_MAX = { bytes: 32 * 1024, lines: 480 };

/** Below this remaining budget a child's output is not worth inlining at all. */
const WAIT_STEP_RESULT_MIN_INLINE_BYTES = 512;

function stepResultView(run: AsyncRunSummary, artifact: StepResultArtifact): WaitStepResultView {
	const payload = artifact.result as unknown as StepResultPresentation;
	return {
		runId: run.id,
		stepIndex: artifact.stepIndex,
		agent: artifact.agent,
		state: artifact.state,
		success: artifact.state === "complete",
		endedAt: artifact.endedAt,
		output: typeof payload.output === "string" ? payload.output : "",
		error: typeof payload.error === "string" ? payload.error : undefined,
		artifactPath: stepResultArtifactPath(run.asyncDir, artifact.stepIndex),
	};
}

/**
 * Render the per-child results a wait is about to return.
 *
 * Bounded on purpose: the whole point is to save a follow-up status call, not to
 * inline several unbounded child transcripts. Each child is truncated, and the
 * children together share WAIT_STEP_RESULTS_TOTAL_MAX; anything past the shared
 * budget is reported by state and artifact path so the parent still knows it has
 * a result to read. Truncated outputs point at the artifact holding the full text.
 */
function formatStepResultViews(views: WaitStepResultView[], header: string): string {
	if (views.length === 0) return "";
	let remainingBytes = WAIT_STEP_RESULTS_TOTAL_MAX.bytes;
	let remainingLines = WAIT_STEP_RESULTS_TOTAL_MAX.lines;
	const blocks = views.map((view) => {
		const status = view.success
			? "complete"
			: `${view.state}${view.error ? `: ${view.error.split("\n")[0]}` : ""}`;
		const prefix = `--- step ${view.stepIndex} (${view.agent}) [${status}] ---`;

		if (remainingBytes < WAIT_STEP_RESULT_MIN_INLINE_BYTES || remainingLines < 1) {
			return `${prefix}\n(output omitted: wait result budget reached; read ${view.artifactPath})`;
		}

		const truncated = truncateOutput(
			view.output || "(no output)",
			{
				bytes: Math.min(WAIT_STEP_RESULT_MAX.bytes, remainingBytes),
				lines: Math.min(WAIT_STEP_RESULT_MAX.lines, remainingLines),
			},
			view.artifactPath,
		);
		remainingBytes -= Buffer.byteLength(truncated.text, "utf-8");
		remainingLines -= truncated.text.split("\n").length + 1;
		return `${prefix}\n${truncated.text}`;
	});
	return `${header}\n${blocks.join("\n")}`;
}

/**
 * Collect this session's unconsumed per-child results.
 *
 * Reads the artifacts children publish at their own completion, so a result is
 * visible here while the rest of its batch is still running.
 */
function availableStepResults(
	runs: AsyncRunSummary[],
	consumed: Set<string>,
): Array<{ run: AsyncRunSummary; view: WaitStepResultView }> {
	const available: Array<{ run: AsyncRunSummary; view: WaitStepResultView }> = [];
	for (const run of runs) {
		for (const artifact of listStepResultArtifacts(run.asyncDir, { runId: run.id })) {
			if (consumed.has(stepResultKey(run.id, artifact.stepIndex))) continue;
			available.push({ run, view: stepResultView(run, artifact) });
		}
	}
	return available;
}

/**
 * Read this session's not-yet-reported per-child results and mark them consumed,
 * so a later `until: "first-result"` call reports the NEXT child instead of
 * repeating one the parent has already seen.
 */
function consumeStepResultViews(runs: AsyncRunSummary[], deps: SubagentWaitDeps): WaitStepResultView[] {
	const consumed = consumedStepResultSet(deps.state);
	const available = availableStepResults(runs, consumed);
	for (const entry of available) {
		markStepResultConsumed(deps.state, entry.run.id, entry.view.stepIndex);
	}
	return available.map((entry) => entry.view);
}

/** Wait result that carries the child results it is reporting. */
function resultWithStepResults(
	text: string,
	views: WaitStepResultView[],
	isError = false,
): AgentToolResult<Details> {
	if (views.length === 0) return result(text, isError);
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [], stepResults: views },
	};
}

function resultWithSupervisorCheckpoint(
	text: string,
	views: WaitStepResultView[],
	checkpoint: SupervisorCheckpoint,
): AgentToolResult<Details> {
	const value = resultWithStepResults(text, views);
	return {
		...value,
		details: { ...value.details!, supervisorCheckpoint: checkpoint },
	};
}

function checkpointActions(
	runId: string | undefined,
	elapsedMs: number,
	children: SupervisorCheckpoint["activeChildSummary"]["children"],
): SupervisorCheckpoint {
	return {
		...(runId === undefined ? {} : { runId }),
		elapsedMs,
		activeChildSummary: { total: children.length, children },
		reason: "supervisor_checkpoint",
		// Without a run id there is nothing to target: only the wait itself can
		// continue the same (untargeted) scope.
		suggestedActions: runId === undefined
			? { wait: { tool: "subagent_wait", barrier: "consume-result" } }
			: {
				status: { tool: "subagent", action: "status", runId },
				steer: { tool: "subagent", action: "steer", runId, childIndex: children[0]?.index ?? 0, message: "Provide the smallest next step or ask for a decision." },
				wait: { tool: "subagent_wait", runId, barrier: "consume-result" },
			},
	};
}

async function waitForDetachedForegroundRun(
	run: ForegroundResumeRun,
	signal: AbortSignal | undefined,
	deps: SubagentWaitDeps,
	startedAt: number,
	now: () => number,
	pollIntervalMs: number,
	timeoutMs: number,
	checkpointMs?: number,
): Promise<AgentToolResult<Details>> {
	const initialDetachedIndices = new Set(run.children.filter((child) => child.status === "detached").map((child) => child.index));
	while (true) {
		if (deps.state.currentSessionId !== run.sessionId) {
			return result(`Wait stopped because the active session changed while remembered foreground run "${run.runId}" was still detached. Return to the originating session to inspect or wait for it.`, true);
		}
		const current = deps.state.foregroundRuns?.get(run.runId);
		if (!current || current.sessionId !== run.sessionId) {
			return result(`Remembered foreground run "${run.runId}" disappeared before a terminal child result was recorded. Completion cannot be confirmed; do not launch a replacement without checking the originating child session.`, true);
		}
		const pending = current.children.filter((child) => initialDetachedIndices.has(child.index) && child.status === "detached");
		if (pending.length === 0) {
			const outcome = summarizeForegroundChildren(current, initialDetachedIndices);
			return result(
				`Waited ${formatDuration(now() - startedAt)} for remembered detached foreground run "${run.runId}"; done. Outcome: ${outcome || "no recovered child status"}. Completion event observed; inspect with subagent({ action: "status", runId: "${run.runId}" }) for recovered output.`,
			);
		}
		if (signal?.aborted) {
			return result(`Wait aborted after ${formatDuration(now() - startedAt)}. Remembered foreground run "${run.runId}" remains detached.`, true);
		}
		const elapsedMs = now() - startedAt;
		if (elapsedMs >= timeoutMs) {
			const syncWakeDetached = current.children.some((child) => initialDetachedIndices.has(child.index) && child.status === "detached" && child.detachedReason === "sync runtime wake");
			const guidance = syncWakeDetached
				? `The child is still running after the sync wake supervisor checkpoint; call subagent_wait({ runId: "${run.runId}", barrier: "consume-result" }) only when its result is needed, or inspect status.`
				: `Reply to any pending supervisor request, then call subagent_wait({ runId: "${run.runId}", barrier: "consume-result" }) only when its result is needed, or inspect status.`;
			return result(
				`Wait timed out after ${formatDuration(timeoutMs)} with remembered foreground run "${run.runId}" still detached. ${guidance} Do not resume or launch a replacement while it remains detached.`,
				true,
			);
		}
		if (checkpointMs !== undefined && checkpointMs > 0 && elapsedMs >= checkpointMs) {
			const children = current.children
				.filter((child) => initialDetachedIndices.has(child.index) && child.status === "detached")
				.map((child) => ({ agent: child.agent, index: child.index, status: "detached" as const }));
			const checkpoint = checkpointActions(run.runId, elapsedMs, children);
			return resultWithSupervisorCheckpoint(
				`Supervisor checkpoint after ${formatDuration(elapsedMs)}: remembered foreground run "${run.runId}" is NOT complete and continues in the background; ${children.length} child(ren) remain detached. Check with subagent({ action: "status", runId: "${run.runId}" }) or continue waiting with subagent_wait({ runId: "${run.runId}", barrier: "consume-result" }).`,
				[],
				checkpoint,
			);
		}
		await waitForWake(pollIntervalMs, signal, deps);
	}
}

/**
 * Block until the targeted async or remembered detached foreground run finishes,
 * the timeout elapses, or the turn is aborted. Resolves with a short
 * human-readable summary either way.
 */
export async function waitForSubagents(
	params: SubagentWaitParams,
	signal: AbortSignal | undefined,
	deps: SubagentWaitDeps,
): Promise<AgentToolResult<Details>> {
	if (deps.enabled === false) {
		return result("subagent_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED; returning immediately without blocking background work. Active work keeps going, and you can inspect subagents with subagent({ action: \"status\" }) or rely on completion notifications.");
	}
	if (!deps.state.currentSessionId) {
		return result("subagent_wait requires an active session identity to scope background work safely.", true);
	}

	if (params.runId && params.id && params.runId !== params.id) {
		return result("runId and id target different runs; provide one target or matching values.", true);
	}
	if (params.until && params.all !== undefined && (params.until === "all-terminal") !== params.all) {
		return result("until and all specify different completion conditions; provide one or matching values.", true);
	}
	if (params.until && params.barrier === "integration" && params.until !== "all-terminal") {
		return result(
			`barrier: integration means the whole batch must be finished, which contradicts until: "${params.until}"; use until: "all-terminal" or drop until.`,
			true,
		);
	}
	const runId = params.runId ?? params.id;
	const untilMode = params.until ?? (params.all === true || params.barrier === "integration" ? "all-terminal" : "first-result");
	// `next-event` shares the first-change machinery: consume published results as they
	// are reported (that consumption is what stops a second sleep from re-reporting the
	// same child), return on the first of result/terminal/attention.
	const firstResultMode = untilMode === "first-result" || untilMode === "next-event";
	const now = deps.now ?? Date.now;
	const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	const timeoutMs = params.timeoutMs !== undefined && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
	const startedAt = now();
	const waitForAll = params.all === true || untilMode === "all-terminal";

	let active: AsyncRunSummary[];
	let foreground: ForegroundResumeRun[];
	let providerSnapshot: BackgroundWorkSnapshot;
	try {
		active = activeRunsForSession({ ...params, id: runId }, deps);
		foreground = activeDetachedForegroundRuns({ ...params, id: runId }, deps);
		providerSnapshot = runId ? { providers: [], items: [] } : backgroundWorkForSession(deps, startedAt);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}

	if (runId) {
		const candidates = [
			...active.map((run) => ({ kind: "async" as const, id: run.id, run })),
			...foreground.map((run) => ({ kind: "foreground" as const, id: run.runId, run })),
		];
		const exact = candidates.filter((candidate) => candidate.id === runId);
		const matches = exact.length > 0 ? exact : candidates.filter((candidate) => candidate.id.startsWith(runId));
		if (matches.length > 1) {
			return result(`Ambiguous subagent run id prefix "${runId}" matched ${matches.length} active runs: ${matches.map((candidate) => candidate.id).join(", ")}. Pass a longer runId.`, true);
		}
		const selected = matches[0];
		if (selected?.kind === "foreground") {
			return waitForDetachedForegroundRun(selected.run, signal, deps, startedAt, now, pollIntervalMs, timeoutMs, deps.checkpointMs);
		}
		active = selected?.kind === "async" ? [selected.run] : [];
		if (!selected) {
			// The requested run may have completed before this wait took its initial
			// active-run snapshot. Its unconsumed child artifacts are still the
			// requested outcome, regardless of the selected completion mode. Ids are
			// resolved with the same prefix rule the active selection uses.
			const terminalMatches = allRunsForSession({ ...params, id: runId }, deps)
				.filter((run) => !ACTIVE_STATES.includes(run.state));
			const exactTerminal = terminalMatches.filter((run) => run.id === runId);
			const terminalCandidates = exactTerminal.length > 0 ? exactTerminal : terminalMatches;
			if (terminalCandidates.length > 1) {
				return result(`Ambiguous subagent run id prefix "${runId}" matched ${terminalCandidates.length} terminal runs: ${terminalCandidates.map((run) => run.id).join(", ")}. Pass a longer runId.`, true);
			}
			const terminal = terminalCandidates[0];
			const recovered = terminal ? consumeStepResultViews([terminal], deps) : [];
			if (recovered.length > 0) {
				return resultWithStepResults(
					`Run "${runId}" is no longer active, but ${recovered.length} finished child result(s) had not been consumed yet.\n${formatStepResultViews(recovered, "")}`,
					recovered,
				);
			}
			if (terminal) {
				return result(`Run "${runId}" is ${terminal.state} and has no unconsumed per-child results. Use subagent({ action: "status", runId: "${runId}" }) for its joined output.`);
			}
			return result(`No active run matched "${runId}". Nothing to wait for.`);
		}
	}

	let providerActive = providerSnapshot.items;
	if (active.length === 0 && providerActive.length === 0) {
		return result(runId
			? `No active run matched "${runId}". Nothing to wait for.`
			: "No active async runs or registered provider work in this session. Nothing to wait for.");
	}
	const waitParams = runId ? { ...params, id: active[0]!.id, runId: active[0]!.id } : params;
	const initialAsyncIds = new Set(active.map((run) => run.id));
	const initialProviderIds = new Set(providerActive.map(backgroundWorkIdentity));
	const initialProviderNames = new Set(providerActive.map((item) => item.provider));
	const initialCount = initialAsyncIds.size + initialProviderIds.size;
	const stopOnAttention = deps.stopOnAttention !== false;
	let attention = active.filter((run) => needsAttention(run));

	const isDone = (): boolean => {
		if (stopOnAttention && attention.some((run) => initialAsyncIds.has(run.id))) return true;
		const activeAsyncIds = new Set(active.map((run) => run.id));
		const activeProviderIds = new Set(providerActive.map(backgroundWorkIdentity));
		if (waitForAll) {
			return [...initialAsyncIds].every((id) => !activeAsyncIds.has(id))
				&& [...initialProviderIds].every((id) => !activeProviderIds.has(id));
		}
		return [...initialAsyncIds].some((id) => !activeAsyncIds.has(id))
			|| [...initialProviderIds].some((id) => !activeProviderIds.has(id));
	};

	/**
	 * Runs this wait is tracking, with a lookup that survives completion.
	 *
	 * A run that reaches a terminal state leaves the active listing, but its
	 * children's artifacts are still on disk and are exactly what a terminal
	 * return must report. Only pay for the all-states listing when a tracked run
	 * is no longer active.
	 */
	const trackedRuns = (): AsyncRunSummary[] => {
		const byId = new Map(active.map((run) => [run.id, run]));
		const found: AsyncRunSummary[] = [];
		const missing: string[] = [];
		for (const id of initialAsyncIds) {
			const run = byId.get(id);
			if (run) found.push(run);
			else missing.push(id);
		}
		if (missing.length === 0) return found;
		for (const run of allRunsForSession(waitParams, deps)) {
			if (missing.includes(run.id) && !byId.has(run.id)) found.push(run);
		}
		return found;
	};
	// `until: "first-result"` consumes as it reports, so repeated calls drain the
	// children of a batch one report at a time. Every other mode only consumes on
	// a terminal return, where reporting the results is the point of the call.
	const resultsForTerminalReturn = (alreadyConsumed: WaitStepResultView[]): WaitStepResultView[] =>
		firstResultMode ? alreadyConsumed : consumeStepResultViews(trackedRuns(), deps);

	while (true) {
		// Check for finished children before the completion check: a result is
		// consumable while the rest of its batch is still running, and a run that
		// finished with unconsumed results must still report them.
		const earlyResults = firstResultMode ? consumeStepResultViews(trackedRuns(), deps) : [];
		if (earlyResults.length > 0) {
			// An early result must not hide a sibling that needs attention: the
			// attention check lives in isDone(), which this branch returns before.
			const earlyAttention = attention.filter((run) => initialAsyncIds.has(run.id));
			const attentionNote = earlyAttention.length > 0
				? ` ${earlyAttention.length} run(s) need attention: ${earlyAttention.map((run) => run.id).join(", ")} — inspect with subagent({ action: "status" }).`
				: "";
			const stillRunning = active.filter((run) => initialAsyncIds.has(run.id)).length;
			const remainingNote = stillRunning > 0
				? ` ${stillRunning} run(s) still in flight — call subagent_wait again to catch the next one.`
				: "";
			return resultWithStepResults(
				`Waited ${formatDuration(now() - startedAt)}; ${earlyResults.length} child result(s) finished before the rest of the batch.${attentionNote}${remainingNote}\n${formatStepResultViews(earlyResults, "")}`,
				earlyResults,
				deps.failOnFailedRuns === true && earlyResults.some((view) => !view.success),
			);
		}
		if (isDone()) break;

		const activeInitialRuns = active.filter((run) => initialAsyncIds.has(run.id));
		const activeInitialProviderItems = providerActive.filter((item) => initialProviderIds.has(backgroundWorkIdentity(item)));
		const stillActive = [
			...activeInitialRuns.map((run) => `${run.id} (${run.state})`),
			...activeInitialProviderItems.map((item) => `${item.provider}/${item.id}`),
		].join(", ");
		if (signal?.aborted) {
			const views = resultsForTerminalReturn(earlyResults);
			return resultWithStepResults(
				`Wait aborted after ${formatDuration(now() - startedAt)}. Still active: ${stillActive}.${formatStepResultViews(views, "\n")}`,
				views,
				true,
			);
		}
		const elapsedMs = now() - startedAt;
		if (elapsedMs >= timeoutMs) {
			const views = resultsForTerminalReturn(earlyResults);
			return resultWithStepResults(
				`Wait timed out after ${formatDuration(timeoutMs)} with ${activeInitialRuns.length} async run(s) and ${activeInitialProviderItems.length} provider item(s) still active: ${stillActive}. The work keeps going; call subagent_wait again or inspect subagent status.${formatStepResultViews(views, "\n")}`,
				views,
				true,
			);
		}
		if (deps.checkpointMs !== undefined && deps.checkpointMs > 0 && elapsedMs >= deps.checkpointMs) {
			// Only name a run the caller can re-target: the requested run, or the single
			// active one. An untargeted wait over several runs (or over provider work with
			// no async run at all) has no single id, and inventing one would send the next
			// status/steer call somewhere this wait was never tracking.
			const runIdForActions = runId ?? (activeInitialRuns.length === 1 ? activeInitialRuns[0].id : undefined);
			const activeChildren: SupervisorCheckpoint["activeChildSummary"]["children"] = [];
			for (const run of activeInitialRuns) {
				// Step status never includes "queued" (that is a run state); only pending
				// and running steps are still working.
				const runningSteps = run.steps.filter((step) => step.status === "running" || step.status === "pending");
				if (runningSteps.length === 0) {
					// A run can be active with no working step (between chain steps, or before
					// the runner writes steps). Its mode is a launch shape, not an agent name,
					// so report the run without an agent rather than naming the wrong one.
					activeChildren.push({
						index: activeChildren.length,
						status: "running",
						...(run.currentTool ? { currentTool: run.currentTool } : {}),
					});
					continue;
				}
				for (const step of runningSteps) {
					activeChildren.push({
						agent: step.agent,
						index: step.index,
						status: "running",
						...(step.currentTool ? { currentTool: step.currentTool } : {}),
					});
				}
			}
			for (const item of activeInitialProviderItems) {
				activeChildren.push({
					agent: item.provider,
					index: activeChildren.length,
					status: "running",
				});
			}
			const checkpoint = checkpointActions(runIdForActions, elapsedMs, activeChildren);
			const views = resultsForTerminalReturn(earlyResults);
			const actionHint = runIdForActions === undefined
				? " Continue waiting with subagent_wait({ barrier: \"consume-result\" }) or inspect the active runs with subagent status."
				: ` Check with subagent({ action: "status", runId: "${runIdForActions}" }) or continue waiting with subagent_wait({ runId: "${runIdForActions}", barrier: "consume-result" }).`;
			return resultWithSupervisorCheckpoint(
				`Supervisor checkpoint after ${formatDuration(elapsedMs)}: this wait is NOT a completion; the work continues. Still active: ${stillActive}.${actionHint}${formatStepResultViews(views, "\n")}`,
				views,
				checkpoint,
			);
		}
		try {
			await waitForWake(pollIntervalMs, signal, deps);
			active = activeRunsForSession(waitParams, deps);
			attention = attentionRunsForSession(waitParams, deps, initialAsyncIds);
			providerSnapshot = runId ? providerSnapshot : backgroundWorkForSession(deps, now());
			for (const provider of initialProviderNames) {
				if (!providerSnapshot.providers.includes(provider)) {
					return result(`Background-work provider '${provider}' disappeared while subagent_wait was tracking its active work; completion cannot be confirmed.`, true);
				}
			}
			providerActive = providerSnapshot.items;
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), true);
		}
	}

	let terminalSummary: string;
	let finishedAsyncCount: number;
	let failedAsyncCount: number;
	const activeProviderIds = new Set(providerActive.map(backgroundWorkIdentity));
	const providerFinishedCount = [...initialProviderIds].filter((id) => !activeProviderIds.has(id)).length;
	try {
		const allNow = allRunsForSession(waitParams, deps);
		const terminal = allNow.filter((run) => !ACTIVE_STATES.includes(run.state) && initialAsyncIds.has(run.id));
		finishedAsyncCount = terminal.length;
		failedAsyncCount = terminal.filter((run) => run.state === "failed").length;
		terminalSummary = summarizeTerminalRuns(terminal, providerFinishedCount);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}

	const relevantAttention = attention.filter((run) => initialAsyncIds.has(run.id));
	const attentionNote = relevantAttention.length > 0
		? ` ${relevantAttention.length} run(s) need attention: ${relevantAttention.map((run) => run.id).join(", ")} — inspect with subagent({ action: "status" }) then steer a top-level live async child, resume a paused/completed/failed child, or interrupt explicitly.`
		: "";
	const stillRunning = active.filter((run) => initialAsyncIds.has(run.id)).length
		+ providerActive.filter((item) => initialProviderIds.has(backgroundWorkIdentity(item))).length;
	const elapsed = formatDuration(now() - startedAt);
	const outcome = terminalSummary ? ` Outcome: ${terminalSummary}.` : "";

	// Read once more before the final summary: a child can publish its artifact
	// between the last consume and the completion check above.
	const terminalStepResults = consumeStepResultViews(trackedRuns(), deps);
	const stepResultBlock = formatStepResultViews(terminalStepResults, "\n");

	if (waitForAll) {
		const scope = runId
			? `run "${runId}"`
			: initialProviderIds.size === 0
				? `${initialAsyncIds.size} async run(s)`
				: `${initialAsyncIds.size} async run(s) and ${initialProviderIds.size} provider item(s)`;
		const status = relevantAttention.length > 0 ? "attention required" : "done";
		return resultWithStepResults(
			`Waited ${elapsed} for ${scope}; ${status}.${outcome}${attentionNote}${stepResultBlock} Completion/control events have been observed; inspect status if a notification is not visible yet.`,
			terminalStepResults,
			deps.failOnFailedRuns === true && failedAsyncCount > 0,
		);
	}

	const finishedCount = finishedAsyncCount + providerFinishedCount;
	const subject = initialProviderIds.size === 0 ? "run(s)" : "item(s)";
	const remainder = stillRunning > 0
		? ` ${stillRunning} ${subject} still in flight — call subagent_wait again to catch the next one.`
		: relevantAttention.length > 0
			? " No other work is waitable until attention is handled."
			: initialProviderIds.size === 0 ? " No runs remain in flight." : " No work remains in flight.";
	const progress = relevantAttention.length > 0 && finishedCount === 0
		? `${relevantAttention.length} of ${initialCount} ${subject} need attention`
		: `${finishedCount} of ${initialCount} ${subject} finished`;
	return resultWithStepResults(
		`Waited ${elapsed}; ${progress}.${outcome}${attentionNote}${remainder}${stepResultBlock} Relevant completion/control events have been observed; inspect status if a notification is not visible yet.`,
		terminalStepResults,
		deps.failOnFailedRuns === true && failedAsyncCount > 0,
	);
}
