import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listAsyncRuns } from "./async-status.ts";
import {
	completionNoticeRunIds,
	findCompletionNoticeRunIds,
	formatPendingResultsMessage,
	selectPendingResults,
	type PendingResultRun,
} from "./pending-results.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "../../shared/types.ts";

const ACK_FILE = "completion-ack.json";
const PENDING_MESSAGE_TYPE = "subagent-pending-results";

interface AckRecord {
	version: 1;
	runId: string;
	acknowledgedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAckRecord(value: unknown, runId: string): value is AckRecord {
	return isRecord(value) && value.version === 1 && value.runId === runId && typeof value.acknowledgedAt === "number";
}

/**
 * Whether a run's completion has already been delivered to the parent session.
 *
 * Exported because the background-work provider has to ask the same question: a
 * terminal run that the parent has already been told about is finished work,
 * not work awaiting attention.
 */
export function readAcknowledged(asyncDir: string, runId: string): { acknowledged: boolean; unreadable: boolean } {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(asyncDir, ACK_FILE), "utf8"));
		return { acknowledged: isAckRecord(parsed, runId), unreadable: !isAckRecord(parsed, runId) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { acknowledged: false, unreadable: false };
		return { acknowledged: false, unreadable: true };
	}
}

function markAcknowledged(asyncDir: string, runId: string): boolean {
	if (!runId || path.basename(runId) !== runId || runId === "." || runId === "..") return false;
	const record: AckRecord = { version: 1, runId, acknowledgedAt: Date.now() };
	try {
		fs.writeFileSync(path.join(asyncDir, ACK_FILE), `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
		return false;
	}
}

function runIdsFromMessage(message: unknown): string[] {
	if (!isRecord(message)) return [];
	if (message.customType === "subagent-notify") return completionNoticeRunIds(message);
	if (message.customType !== PENDING_MESSAGE_TYPE || !isRecord(message.details)) return [];
	const runIds = message.details.runIds;
	return Array.isArray(runIds) ? runIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

function bestEffortTelemetry(pi: Pick<ExtensionAPI, "appendEntry">, counters: { skipped: number; unreadable: number }): void {
	if (counters.skipped === 0 && counters.unreadable === 0) return;
	try {
		pi.appendEntry("subagent_pending_results_sweep", {
			version: 1,
			skipped: counters.skipped,
			unreadable: counters.unreadable,
		});
	} catch {
		// The sweep must not interfere with the parent turn.
	}
}

export function registerPendingResultsSweep(
	pi: ExtensionAPI,
	state: Pick<SubagentState, "consumedCompletionRuns" | "asyncJobs">,
	asyncDirRoot: string,
): () => void {
	let sweepNeeded = true;
	const unsubscribeCompletion = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, () => { sweepNeeded = true; });
	pi.on("session_start", () => { sweepNeeded = true; });
	pi.on("session_compact", () => { sweepNeeded = true; });
	pi.on("message_start", (event) => {
		const message = (event as { message?: unknown }).message;
		const counters = { skipped: 0, unreadable: 0 };
		const runIds = runIdsFromMessage(message);
		for (const runId of runIds) {
			const asyncDir = state.asyncJobs.get(runId)?.asyncDir ?? path.join(asyncDirRoot, runId);
			if (markAcknowledged(asyncDir, runId)) state.consumedCompletionRuns?.add(runId);
			else counters.unreadable++;
		}
		if (runIds.length > 0) sweepNeeded = true;
		bestEffortTelemetry(pi, counters);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!sweepNeeded) return;
		sweepNeeded = sweepPendingResults(pi, state, asyncDirRoot, ctx);
	});
	return () => unsubscribeCompletion?.();
}

export function sweepPendingResults(
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">,
	state: Pick<SubagentState, "consumedCompletionRuns" | "asyncJobs">,
	asyncDirRoot: string,
	ctx: ExtensionContext,
): boolean {
	const counters = { skipped: 0, unreadable: 0 };
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return false;
		let runs;
		try {
			runs = listAsyncRuns(asyncDirRoot, { sessionId, reconcile: false });
		} catch {
			bestEffortTelemetry(pi, { skipped: 0, unreadable: 1 });
			return true;
		}
		let historyEntries: unknown[] = [];
		try {
			historyEntries = ctx.sessionManager.getEntries();
		} catch {
			counters.unreadable++;
		}
		const history = findCompletionNoticeRunIds(historyEntries);
		counters.skipped += history.skippedEntries;
		const runIds = new Set(runs.map((run) => run.id));
		for (const runId of history.runIds) if (!runIds.has(runId)) counters.skipped++;
		const acknowledged = new Set(state.consumedCompletionRuns ?? []);
		for (const run of runs) {
			const ack = readAcknowledged(run.asyncDir, run.id);
			if (ack.acknowledged) acknowledged.add(run.id);
			if (ack.unreadable) counters.unreadable++;
		}
		const candidates: PendingResultRun[] = runs.map((run) => ({
			id: run.id,
			asyncDir: run.asyncDir,
			state: run.state,
			...(run.outputFile ? { outputFile: run.outputFile } : {}),
			steps: run.steps.map((step) => ({ agent: step.agent, status: step.status })),
		}));
		const selection = selectPendingResults(candidates, acknowledged, history.runIds);
		counters.skipped += selection.skippedRuns;
		const rendered = formatPendingResultsMessage(selection);
		if (!rendered) {
			bestEffortTelemetry(pi, counters);
			return false;
		}
		pi.sendMessage(
			{
				customType: PENDING_MESSAGE_TYPE,
				content: rendered.content,
				display: true,
				details: { version: 1, runIds: rendered.shownRunIds },
			},
			{ triggerTurn: true },
		);
		bestEffortTelemetry(pi, counters);
		return true;
	} catch {
		bestEffortTelemetry(pi, { skipped: counters.skipped, unreadable: counters.unreadable + 1 });
		return true;
	}
}
