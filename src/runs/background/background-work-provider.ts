import * as path from "node:path";
import { ASYNC_DIR } from "../../shared/types.ts";
import type { BackgroundWorkItem, BackgroundWorkProvider } from "../../api/background-work.ts";
import { formatDuration } from "../../shared/formatters.ts";
import { formatActivityLabel } from "../../shared/status-format.ts";
import { formatAsyncRunProgressLabel, listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import { readAcknowledged } from "./pending-results-sweep.ts";

const PROVIDER_NAME = "pi-subagents";
const BOUNDED_RUN_LIMIT = 10_000;
const SUMMARY_MAX_CHARS = 400;

type SessionId = string | null | undefined;

function runItem(run: AsyncRunSummary): BackgroundWorkItem | undefined {
	if (!run.sessionId) return undefined;
	return { id: run.id, sessionId: run.sessionId };
}

/**
 * One-line status for a running run, so a heartbeat consumer can list it without
 * reading this extension's status files. The consumer prefixes the provider and
 * item id, so the summary starts at the state and never repeats the id.
 */
export function formatRunWorkSummary(run: AsyncRunSummary, now = Date.now()): string {
	const parts = [run.state, run.mode, formatAsyncRunProgressLabel(run)];
	const activity = formatActivityLabel(
		run.lastActivityAt,
		run.activityState,
		now,
		run.currentTool,
		run.currentToolStartedAt,
	);
	if (activity) parts.push(activity);
	parts.push(`${formatDuration(Math.max(0, now - run.startedAt))} elapsed`);
	const summary = parts.join(" | ");
	return summary.length <= SUMMARY_MAX_CHARS ? summary : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

function activeRunItem(run: AsyncRunSummary, now: number): BackgroundWorkItem | undefined {
	const item = runItem(run);
	if (!item) return undefined;
	return { ...item, summary: formatRunWorkSummary(run, now) };
}

function hasAttention(run: AsyncRunSummary, isAcknowledged: (runId: string) => boolean): boolean {
	// A failed or stopped run needs attention only until its result has been
	// delivered to the parent session. Once `completion-ack.json` exists the
	// parent has already been told, and reporting it again on every heartbeat
	// turned a finished run into a permanent alarm. A terminal run with no ack is
	// still attention: nobody has seen it yet, which is the case this protects.
	if (run.state === "failed" || run.state === "stopped") return !isAcknowledged(run.id);
	if (run.state === "paused") return true;
	if (run.activityState === "needs_attention" || run.timedOut === true || run.toolBudgetBlocked === true || run.turnBudgetExceeded === true) return true;
	if (run.turnBudget?.outcome === "exceeded" || run.toolBudget?.outcome === "hard-blocked") return true;
	return run.steps.some((step) =>
		(run.state === "running" && step.activityState === "needs_attention")
			|| step.timedOut === true
			|| step.stopped === true
			|| step.turnBudgetExceeded === true
			|| step.toolBudgetBlocked === true
	);
}

function listRuns(
	asyncDir: string,
	sessionId: SessionId,
	states?: AsyncRunSummary["state"][],
): AsyncRunSummary[] {
	if (!sessionId) return [];
	return listAsyncRuns(asyncDir, {
		sessionId,
		...(states ? { states } : {}),
		limit: BOUNDED_RUN_LIMIT,
		reconcile: true,
	});
}

/** Provider for this extension's detached async runs. */
export function createSubagentBackgroundWorkProvider(
	options: {
		asyncDir?: string;
		getSessionId?: () => SessionId;
		now?: () => number;
		isAcknowledged?: (runId: string) => boolean;
	} = {},
): BackgroundWorkProvider {
	const asyncDir = options.asyncDir ?? ASYNC_DIR;
	const getSessionId = options.getSessionId ?? (() => null);
	const now = options.now ?? Date.now;
	const isAcknowledged =
		options.isAcknowledged ??
		// The ack file lives beside a run's status.json, so the lookup is the run
		// directory, not the root: `readAcknowledged` is the same call the pending
		// results sweep uses to decide it has nothing left to deliver.
		((runId: string) => readAcknowledged(path.join(asyncDir, runId), runId).acknowledged);
	return {
		name: PROVIDER_NAME,
		listActiveWork: () => listRuns(asyncDir, getSessionId(), ["queued", "running"])
			.map((run) => activeRunItem(run, now()))
			.filter((item): item is BackgroundWorkItem => item !== undefined),
		listAttentionWork: () => listRuns(asyncDir, getSessionId())
			.filter((run) => hasAttention(run, isAcknowledged))
			.map(runItem)
			.filter((item): item is BackgroundWorkItem => item !== undefined),
	};
}

export { PROVIDER_NAME as SUBAGENT_BACKGROUND_WORK_PROVIDER_NAME };
