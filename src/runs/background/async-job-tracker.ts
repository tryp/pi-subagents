import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget, widgetRenderKey } from "../../tui/render.ts";
import { formatControlNoticeMessage, recordToolStallTelemetry } from "../shared/subagent-control.ts";
import {
	type AsyncJobState,
	type AsyncStartedEvent,
	type ControlEvent,
	type SteeringNotice,
	type SubagentState,
	POLL_INTERVAL_MS,
	RESULTS_DIR,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_STEERING_NOTICE_EVENT,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { hasLiveNestedDescendants, updateAsyncJobNestedProjection } from "../shared/nested-events.ts";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import {
	CONTROL_EVENT_READ_CHUNK_BYTES,
	CONTROL_EVENT_SCAN_WINDOW_BYTES,
	MAX_CONTROL_EVENT_LINE_BYTES,
	scanControlEventLines,
} from "./control-event-scanner.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
	resultsDir?: string;
	widgetEnabled?: boolean;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

const MAX_RECENT_FLEET_JOBS = 20;

function rememberFleetJob(state: SubagentState, job: AsyncJobState): void {
	state.fleetJobs ??= new Map();
	state.fleetJobs.set(job.asyncId, job);
	const terminal = [...state.fleetJobs.values()]
		.filter((candidate) => candidate.status === "complete" || candidate.status === "failed" || candidate.status === "paused" || candidate.status === "stopped")
		.sort((left, right) => (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0));
	for (const stale of terminal.slice(MAX_RECENT_FLEET_JOBS)) state.fleetJobs.delete(stale.asyncId);
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events" | "appendEntry">, state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	refreshWidget: (ctx: ExtensionContext) => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
	restoreActiveJobs: (ctx?: ExtensionContext) => void;
	restoreActiveJobsYielding: (ctx: ExtensionContext | undefined, shouldContinue: () => boolean) => Promise<void>;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const resultsDir = options.resultsDir ?? RESULTS_DIR;
	const steeringNoticeSeen = new Map<string, number>();
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		renderWidget(ctx, options.widgetEnabled === false ? [] : jobs);
		ctx.ui.requestRender?.();
	};
	const refreshWidget = (ctx: ExtensionContext) => rerenderWidget(ctx);
	/**
	 * Start restored jobs at the trailing unterminated line without replaying any
	 * completed line, so a writer that is mid-append cannot leave the scanner
	 * parsing the tail of a partial line. Walks back at most
	 * MAX_CONTROL_EVENT_LINE_BYTES: a trailing line that exceeds the per-line
	 * budget can never be a control event, so it is reported as oversized instead.
	 */
	const restoredControlEventCursor = (asyncDir: string): { cursor: number; midLine: boolean; discardedOversizedLine: boolean } => {
		let fd: number;
		try {
			fd = fs.openSync(path.join(asyncDir, "events.jsonl"), "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cursor: 0, midLine: false, discardedOversizedLine: false };
			throw error;
		}
		try {
			const size = fs.fstatSync(fd).size;
			if (size === 0) return { cursor: 0, midLine: false, discardedOversizedLine: false };
			for (let scanned = 0; scanned < MAX_CONTROL_EVENT_LINE_BYTES; scanned += CONTROL_EVENT_READ_CHUNK_BYTES) {
				const probeBytes = Math.min(size - scanned, CONTROL_EVENT_READ_CHUNK_BYTES);
				if (probeBytes <= 0) return { cursor: 0, midLine: false, discardedOversizedLine: false };
				const buffer = Buffer.alloc(probeBytes);
				const bytesRead = fs.readSync(fd, buffer, 0, probeBytes, size - scanned - probeBytes);
				if (bytesRead <= 0) return { cursor: 0, midLine: false, discardedOversizedLine: false };
				const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
				if (lastNewline >= 0) {
					return { cursor: size - scanned - probeBytes + lastNewline + 1, midLine: false, discardedOversizedLine: false };
				}
				if (scanned + probeBytes >= size) return { cursor: 0, midLine: false, discardedOversizedLine: false };
			}
			// No newline within the per-line budget: the trailing line is over
			// budget, so skip it instead of holding a cursor inside it.
			return { cursor: size - MAX_CONTROL_EVENT_LINE_BYTES, midLine: true, discardedOversizedLine: true };
		} finally {
			fs.closeSync(fd);
		}
	};
	const summaryToJob = (run: AsyncRunSummary): AsyncJobState => {
		const restoredCursor = restoredControlEventCursor(run.asyncDir);
		const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, run.chainStepCount ?? run.steps.length);
		const activeGroup = run.currentStep !== undefined
			? groups.find((group) => run.currentStep! >= group.start && run.currentStep! < group.start + group.count)
			: undefined;
		const visibleSteps = activeGroup
			? run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
			: run.steps.map((step, index) => ({ ...step, index }));
		return {
			asyncId: run.id,
			asyncDir: run.asyncDir,
			status: run.state,
			sessionId: run.sessionId,
			activityState: run.activityState,
			lastActivityAt: run.lastActivityAt,
			currentTool: run.currentTool,
			currentToolStartedAt: run.currentToolStartedAt,
			currentPath: run.currentPath,
			turnCount: run.turnCount,
			toolCount: run.toolCount,
			steering: run.steering,
			mode: run.mode,
			agents: visibleSteps.map((step) => step.agent),
			currentStep: run.currentStep,
			chainStepCount: run.chainStepCount,
			parallelGroups: groups,
			steps: visibleSteps,
			stepsTotal: visibleSteps.length,
			runningSteps: visibleSteps.filter((step) => step.status === "running").length,
			completedSteps: visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length,
			hasParallelGroups: groups.length > 0,
			activeParallelGroup: Boolean(activeGroup),
			startedAt: run.startedAt,
			updatedAt: run.lastUpdate ?? run.startedAt,
			timeoutMs: run.timeoutMs,
			deadlineAt: run.deadlineAt,
			timedOut: run.timedOut,
			stopped: run.stopped,
			turnBudget: run.turnBudget,
			turnBudgetExceeded: run.turnBudgetExceeded,
			wrapUpRequested: run.wrapUpRequested,
			sessionDir: run.sessionDir,
			outputFile: run.outputFile,
			totalTokens: run.totalTokens,
			sessionFile: run.sessionFile,
			controlEventCursor: restoredCursor.cursor,
			controlEventMidLine: restoredCursor.midLine,
			controlEventOversizedLines: restoredCursor.discardedOversizedLine ? 1 : 0,
			controlEventMalformedLines: 0,
			nestedChildren: run.nestedChildren,
		};
	};
	const cancelCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (!existingTimer) return;
		clearTimeout(existingTimer);
		state.cleanupTimers.delete(asyncId);
	};
	const scheduleCleanup = (asyncId: string) => {
		cancelCleanup(asyncId);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			state.asyncJobs.delete(asyncId);
			if (state.lastUiContext) {
				rerenderWidget(state.lastUiContext);
			}
		}, completionRetentionMs);
		state.cleanupTimers.set(asyncId, timer);
	};
	const emitNewControlEvents = (job: AsyncJobState) => {
		const eventsPath = path.join(job.asyncDir, "events.jsonl");
		let fd: number;
		try {
			fd = fs.openSync(eventsPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
			return;
		}
		try {
			const stat = fs.fstatSync(fd);
			const savedCursor = job.controlEventCursor;
			// Truncation or rotation invalidates the stored position; reset it and the
			// mid-line flag together so the next poll restarts from a real boundary.
			const truncated = stat.size < (savedCursor ?? 0);
			let cursor = truncated ? 0 : (savedCursor ?? 0);
			if (truncated) {
				job.controlEventCursor = 0;
				job.controlEventMidLine = false;
			}
			const startedFromTail = !truncated && savedCursor === undefined && stat.size > CONTROL_EVENT_SCAN_WINDOW_BYTES;
			if (startedFromTail) cursor = stat.size - CONTROL_EVENT_SCAN_WINDOW_BYTES;
			if (stat.size <= cursor) return;
			const handleLine = (line: string) => {
				if (!line.trim()) return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (error) {
					job.controlEventMalformedLines = (job.controlEventMalformedLines ?? 0) + 1;
					console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
					return;
				}
				if (!parsed || typeof parsed !== "object") return;
				if ((parsed as { type?: unknown }).type === "subagent.steering.notice") {
					const notice = parsed as Partial<SteeringNotice>;
					if (typeof notice.requestId !== "string" || typeof notice.runId !== "string" || (notice.state !== "failed" && notice.state !== "partial" && notice.state !== "recovered") || typeof notice.message !== "string") return;
					if (typeof state.currentSessionId === "string" && notice.currentSessionId !== state.currentSessionId) return;
					const key = `${notice.runId}:${notice.requestId}:${notice.state}`;
					if (steeringNoticeSeen.has(key)) return;
					const now = Date.now();
					steeringNoticeSeen.set(key, now);
					if (steeringNoticeSeen.size > 200) {
						for (const [seenKey, seenAt] of steeringNoticeSeen) {
							if (now - seenAt > 10 * 60 * 1000 || steeringNoticeSeen.size > 200) steeringNoticeSeen.delete(seenKey);
						}
					}
					pi.events.emit(SUBAGENT_STEERING_NOTICE_EVENT, { ...notice, source: "async", asyncDir: job.asyncDir, noticeText: notice.message });
					return;
				}
				if ((parsed as { type?: unknown }).type !== "subagent.control") return;
				const record = parsed as { event?: ControlEvent; channels?: string[]; childIntercomTarget?: string; noticeText?: string; intercom?: { to?: string; message?: string } };
				if (!record.event || !Array.isArray(record.channels)) return;
				recordToolStallTelemetry(pi.appendEntry.bind(pi), record.event);
				const payload = {
					event: record.event,
					source: "async" as const,
					asyncDir: job.asyncDir,
					childIntercomTarget: record.childIntercomTarget,
					noticeText: record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
				};
				if (record.channels.includes("event")) {
					pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
				}
				if (record.event.type !== "active_long_running" && record.channels.includes("intercom") && record.intercom?.to && record.intercom.message) {
					pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
						...payload,
						to: record.intercom.to,
						message: record.intercom.message,
					});
				}
			};
			const scan = scanControlEventLines({
				fd,
				size: stat.size,
				cursor,
				midLine: startedFromTail || job.controlEventMidLine === true,
				onLine: handleLine,
			});
			job.controlEventCursor = scan.cursor;
			job.controlEventMidLine = scan.midLine;
			job.controlEventOversizedLines = (job.controlEventOversizedLines ?? 0) + scan.oversizedLines;
		} catch (error) {
			console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
		} finally {
			fs.closeSync(fd);
		}
	};

	const ensurePoller = () => {
		if (state.poller) return;
		state.poller = setInterval(() => {
			if (state.asyncJobs.size === 0) {
				if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext, []);
				if (state.poller) {
					clearInterval(state.poller);
					state.poller = null;
				}
				return;
			}

			let widgetChanged = false;
			for (const job of state.asyncJobs.values()) {
				const widgetStateBefore = widgetRenderKey(job);
				let nestedRefreshFailed = false;
				const refreshNestedProjection = () => {
					try {
						updateAsyncJobNestedProjection(job);
					} catch (error) {
						nestedRefreshFailed = true;
						console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
					}
				};
				const reconcileNestedDescendants = () => {
					try {
						if (job.nestedRoute) reconcileNestedAsyncDescendants(job.nestedRoute, { resultsDir, kill: options.kill, now: options.now });
					} catch (error) {
						nestedRefreshFailed = true;
						console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
					}
					refreshNestedProjection();
				};
				try {
					emitNewControlEvents(job);
					reconcileNestedDescendants();
					const reconciliation = reconcileAsyncRun(job.asyncDir, {
						resultsDir,
						kill: options.kill,
						now: options.now,
						startedRun: {
							runId: job.asyncId,
							pid: job.pid,
							sessionId: job.sessionId,
							mode: job.mode,
							agents: job.agents,
							chainStepCount: job.chainStepCount,
							parallelGroups: job.parallelGroups,
							startedAt: job.startedAt,
							sessionFile: job.sessionFile,
						},
					});
					const status = reconciliation.status ?? readStatus(job.asyncDir);
					if (status) {
						const previousStatus = job.status;
						job.status = status.state;
						if (job.status !== "complete" && job.status !== "failed" && job.status !== "paused" && job.status !== "stopped") cancelCleanup(job.asyncId);
						job.sessionId = status.sessionId ?? job.sessionId;
						job.activityState = status.activityState;
						job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
						job.currentTool = status.currentTool;
						job.currentToolStartedAt = status.currentToolStartedAt;
						job.currentPath = status.currentPath;
						job.turnCount = status.turnCount ?? job.turnCount;
						job.toolCount = status.toolCount ?? job.toolCount;
						job.steering = status.steering ?? job.steering;
						job.mode = status.mode;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.chainStepCount = status.chainStepCount ?? job.chainStepCount;
						job.startedAt = status.startedAt ?? job.startedAt;
						if (status.lastUpdate !== undefined) job.updatedAt = status.lastUpdate;
						if (status.steps?.length) {
							const groups = normalizeParallelGroups(status.parallelGroups, status.steps.length, status.chainStepCount ?? status.steps.length);
							job.parallelGroups = groups.length ? groups : job.parallelGroups;
							job.hasParallelGroups = groups.length > 0 || job.hasParallelGroups;
							const activeGroup = status.currentStep !== undefined
								? groups.find((group) => status.currentStep! >= group.start && status.currentStep! < group.start + group.count)
								: undefined;
							const visibleSteps = activeGroup
								? status.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
								: status.steps.map((step, index) => ({ ...step, index }));
							job.activeParallelGroup = Boolean(activeGroup);
							job.agents = visibleSteps.map((step) => step.agent);
							job.steps = visibleSteps;
							refreshNestedProjection();
							job.stepsTotal = visibleSteps.length;
							job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
							job.completedSteps = visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length;
							if (status.state === "complete") job.completedSteps = visibleSteps.length;
						}
						job.sessionDir = status.sessionDir ?? job.sessionDir;
						job.outputFile = status.outputFile ?? job.outputFile;
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.timeoutMs = status.timeoutMs ?? job.timeoutMs;
						job.deadlineAt = status.deadlineAt ?? job.deadlineAt;
						job.timedOut = status.timedOut ?? job.timedOut;
						job.stopped = status.stopped ?? job.stopped;
						job.turnBudget = status.turnBudget ?? job.turnBudget;
						job.turnBudgetExceeded = status.turnBudgetExceeded ?? job.turnBudgetExceeded;
						job.wrapUpRequested = status.wrapUpRequested ?? job.wrapUpRequested;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
						if (job.status === "complete" || job.status === "failed" || job.status === "paused" || job.status === "stopped") {
							rememberFleetJob(state, job);
							if (!nestedRefreshFailed && !hasLiveNestedDescendants(job.nestedChildren) && (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))) {
								scheduleCleanup(job.asyncId);
							}
						}
						if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
						continue;
					}
					if (job.status === "queued") {
						job.status = "running";
						job.updatedAt = Date.now();
					}
				} catch (error) {
					if (job.status !== "failed") {
						console.error(`Failed to read async status for '${job.asyncDir}':`, error);
						job.status = "failed";
						job.updatedAt = Date.now();
					}
					rememberFleetJob(state, job);
					if (!hasLiveNestedDescendants(job.nestedChildren) && !state.cleanupTimers.has(job.asyncId)) {
						scheduleCleanup(job.asyncId);
					}
				}
				if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
			}

			if (widgetChanged && state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
		}, pollIntervalMs);
		state.poller.unref?.();
	};

	const handleStarted = (data: unknown) => {
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		if (typeof state.currentSessionId === "string" && info.sessionId !== state.currentSessionId) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		const rawAgents = info.agents?.length ? info.agents : info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		const validParallelGroups = normalizeParallelGroups(info.parallelGroups, Number.MAX_SAFE_INTEGER, info.chainStepCount ?? Number.MAX_SAFE_INTEGER);
		const firstGroup = validParallelGroups.find((group) => group.start === 0);
		const firstGroupCount = firstGroup?.count;
		const agents = firstGroupCount && firstGroupCount > 0
			? rawAgents?.slice(0, firstGroupCount)
			: rawAgents;
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			pid: typeof info.pid === "number" ? info.pid : undefined,
			...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
			mode: info.mode ?? (info.chain ? "chain" : "single"),
			agents,
			chainStepCount: info.chainStepCount,
			parallelGroups: validParallelGroups,
			nestedRoute: info.nestedRoute,
			stepsTotal: firstGroupCount ?? agents?.length,
			hasParallelGroups: validParallelGroups.length > 0,
			activeParallelGroup: Boolean(firstGroupCount && firstGroupCount > 0),
			startedAt: now,
			updatedAt: now,
			timeoutMs: info.timeoutMs,
			deadlineAt: info.deadlineAt,
			turnBudget: info.turnBudget,
			controlEventCursor: 0,
			controlEventMidLine: false,
			controlEventOversizedLines: 0,
			controlEventMalformedLines: 0,
		});
		rememberFleetJob(state, state.asyncJobs.get(info.id)!);
		ensurePoller();
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; state?: AsyncJobState["status"]; asyncDir?: string; sessionId?: string; stopped?: boolean };
		if (typeof state.currentSessionId === "string" && result.sessionId !== state.currentSessionId) return;
		const asyncId = result.id;
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		let nestedRefreshFailed = false;
		if (job) {
			job.status = result.state ?? (result.success ? "complete" : "failed");
			job.stopped = result.stopped ?? job.stopped;
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
			try {
				updateAsyncJobNestedProjection(job);
			} catch (error) {
				nestedRefreshFailed = true;
				console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
			}
		}
		if (job) rememberFleetJob(state, job);
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
		if (!nestedRefreshFailed && !hasLiveNestedDescendants(job?.nestedChildren)) scheduleCleanup(asyncId);
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		state.fleetJobs?.clear();
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	const applyRestoredRuns = (runs: AsyncRunSummary[]) => {
		for (const run of runs) {
			const job = summaryToJob(run);
			state.asyncJobs.set(run.id, job);
			rememberFleetJob(state, job);
		}
		if (runs.length === 0) return;
		ensurePoller();
		if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
	};

	const restoreActiveJobs = (ctx?: ExtensionContext) => {
		if (ctx?.hasUI) state.lastUiContext = ctx;
		if (!state.currentSessionId) return;
		try {
			applyRestoredRuns(listAsyncRuns(asyncDirRoot, { states: ["queued", "running"], sessionId: state.currentSessionId, resultsDir, kill: options.kill, now: options.now }));
		} catch (error) {
			console.error(`Failed to restore active async jobs from '${asyncDirRoot}':`, error);
		}
	};

	const restoreActiveJobsYielding = async (ctx: ExtensionContext | undefined, shouldContinue: () => boolean) => {
		if (ctx?.hasUI) state.lastUiContext = ctx;
		if (!state.currentSessionId || !shouldContinue()) return;
		// This is the deferred reconcile phase: each entry is reconciled by the
		// yielding scanner, which returns to the event loop before the next entry.
		const runs = await listAsyncRuns(asyncDirRoot, {
			states: ["queued", "running"], sessionId: state.currentSessionId, resultsDir, kill: options.kill, now: options.now,
			reconcile: "yielding", shouldContinue,
		});
		if (shouldContinue()) applyRestoredRuns(runs);
	};

	return { ensurePoller, refreshWidget, handleStarted, handleComplete, resetJobs, restoreActiveJobs, restoreActiveJobsYielding };
}
