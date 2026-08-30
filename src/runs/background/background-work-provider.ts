import { ASYNC_DIR } from "../../shared/types.ts";
import type { BackgroundWorkItem, BackgroundWorkProvider } from "../../api/background-work.ts";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";

const PROVIDER_NAME = "pi-subagents";
const BOUNDED_RUN_LIMIT = 10_000;

type SessionId = string | null | undefined;

function runItem(run: AsyncRunSummary): BackgroundWorkItem | undefined {
	if (!run.sessionId) return undefined;
	return { id: run.id, sessionId: run.sessionId };
}

function hasAttention(run: AsyncRunSummary): boolean {
	if (run.state === "failed" || run.state === "paused" || run.state === "stopped") return true;
	if (run.activityState === "needs_attention" || run.timedOut === true || run.toolBudgetBlocked === true || run.turnBudgetExceeded === true) return true;
	if (run.turnBudget?.outcome === "exceeded" || run.toolBudget?.outcome === "hard-blocked") return true;
	return run.steps.some((step) =>
		step.timedOut === true
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
	options: { asyncDir?: string; getSessionId?: () => SessionId } = {},
): BackgroundWorkProvider {
	const asyncDir = options.asyncDir ?? ASYNC_DIR;
	const getSessionId = options.getSessionId ?? (() => null);
	return {
		name: PROVIDER_NAME,
		listActiveWork: () => listRuns(asyncDir, getSessionId(), ["queued", "running"])
			.map(runItem)
			.filter((item): item is BackgroundWorkItem => item !== undefined),
		listAttentionWork: () => listRuns(asyncDir, getSessionId())
			.filter(hasAttention)
			.map(runItem)
			.filter((item): item is BackgroundWorkItem => item !== undefined),
	};
}

export { PROVIDER_NAME as SUBAGENT_BACKGROUND_WORK_PROVIDER_NAME };
