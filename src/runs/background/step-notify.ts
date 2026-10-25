/** Bounded, interactive-only notifications for newly-published child results. */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AsyncJobState, SubagentState } from "../../shared/types.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_FOREGROUND_COMPLETE_EVENT, SUBAGENT_STEP_RESULT_EVENT } from "../../shared/types.ts";
import { consumedStepResultSet, listStepResultArtifacts, stepResultArtifactPath, stepResultKey, type StepResultArtifact, type StepResultPresentation } from "../shared/step-results.ts";
import { createCompletionBatcher, DEFAULT_COMPLETION_BATCH_CONFIG, type CompletionBatcher, type ResolvedCompletionBatchConfig } from "./completion-batcher.ts";

export const MAX_STEP_NOTIFICATIONS_PER_RUN = 3;
export const STEP_NOTIFY_MESSAGE_MAX_BYTES = 8 * 1024;
const STEP_PREVIEW_MAX_BYTES = 1024;
const STEP_PREVIEW_MAX_LINES = 20;
const STEP_NOTIFY_POLL_MS = 250;

export interface StepNotifyPolicyInput {
	enabled: boolean;
	/** Fail closed: only literal true is interactive. */
	hasUI?: boolean;
	idle: boolean;
	consumed: boolean;
	completionSent: boolean;
	notificationsSent: number;
	hasPendingNotification?: boolean;
}

export function shouldNotifyStepResult(input: StepNotifyPolicyInput): { notify: boolean; reason: string } {
	if (!input.enabled) return { notify: false, reason: "disabled" };
	// Rule 8: headless agent_end auto-drain owns delivery. Never trigger another
	// turn there; missing context is treated the same as hasUI=false.
	if (input.hasUI !== true) return { notify: false, reason: "headless" };
	if (input.completionSent) return { notify: false, reason: "completion-already-sent" };
	if (input.consumed) return { notify: false, reason: "already-consumed" };
	if (input.notificationsSent >= MAX_STEP_NOTIFICATIONS_PER_RUN && !input.hasPendingNotification) {
		return { notify: false, reason: "per-run-cap" };
	}
	if (!input.idle) return { notify: false, reason: "turn-active" };
	return { notify: true, reason: "ready" };
}

export interface StepNotifyDetails {
	runId: string;
	stepIndex: number;
	agent: string;
	state: string;
	durationMs: number;
	artifactPath: string;
	bytes: number;
	lines: number;
	preview: string;
	missing: boolean;
}

export interface StepNotifyEnvelope {
	version: 1;
	/** Exact queue identity used to retire bookkeeping when this message is consumed. */
	queueKey?: string;
	notifications: StepNotifyDetails[];
}

interface StepNotifyItem {
	runId: string;
	details: StepNotifyDetails;
}

interface TimerApi {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(handler: () => void, delayMs: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface RegisterStepNotifyOptions {
	pollIntervalMs?: number;
	batchConfig?: ResolvedCompletionBatchConfig;
	timers?: TimerApi;
	fileExists?: (file: string) => boolean;
	now?: () => number;
	logSuppression?: (runId: string, stepIndex: number, reason: string) => void;
}

function recordStepNotificationTelemetry(
	pi: { appendEntry?: (customType: string, data?: unknown) => void },
	event: string,
	runId: string,
	count = 1,
): void {
	try {
		pi.appendEntry?.("subagent_notification_telemetry", { version: 1, channel: "step", event, runId, count });
	} catch {
		// Telemetry must never interfere with notification delivery.
	}
}

function artifactOutput(artifact: StepResultArtifact<StepResultPresentation>): string {
	const output = typeof artifact.result.output === "string" ? artifact.result.output : "";
	if (output) return output;
	return typeof artifact.result.error === "string" ? artifact.result.error : "(no output)";
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let output = "";
	for (const char of text) {
		if (Buffer.byteLength(output + char, "utf8") > Math.max(0, maxBytes - 3)) break;
		output += char;
	}
	return `${output}...`;
}

function buildDetails(run: AsyncJobState, artifact: StepResultArtifact<StepResultPresentation>): StepNotifyDetails {
	const output = artifactOutput(artifact);
	const lines = output.split(/\r?\n/);
	const preview = truncateUtf8(lines.slice(0, STEP_PREVIEW_MAX_LINES).join("\n"), STEP_PREVIEW_MAX_BYTES);
	const artifactPath = stepResultArtifactPath(run.asyncDir, artifact.stepIndex);
	// Size/line counts describe the child output, not JSON wrapper overhead.
	const bytes = Buffer.byteLength(output, "utf8");
	return {
		runId: run.asyncId,
		stepIndex: artifact.stepIndex,
		agent: artifact.agent,
		state: artifact.state,
		durationMs: artifact.durationMs,
		artifactPath,
		bytes,
		lines: lines.length,
		preview,
		missing: false,
	};
}

function detailsAtDelivery(item: StepNotifyItem, fileExists: (file: string) => boolean): StepNotifyDetails {
	const missing = !fileExists(item.details.artifactPath);
	return missing
		? { ...item.details, missing, preview: "(artifact file is gone; the path is retained for diagnosis)" }
		: item.details;
}

function renderReceipt(items: StepNotifyItem[], fileExists: (file: string) => boolean): { content: string; details: StepNotifyDetails[] } {
	const details = items.map((item) => detailsAtDelivery(item, fileExists));
	let previewBudget = Math.min(STEP_PREVIEW_MAX_BYTES, Math.floor(5000 / Math.max(1, details.length)));
	const makeContent = (budget: number) => [
		`Subagent child result notification for run ${details[0]?.runId ?? "unknown"} (${details.length} result${details.length === 1 ? "" : "s"}).`,
		...details.map((detail) => [
			`- ${detail.agent} [${detail.state}], step ${detail.stepIndex}, ${Math.max(0, detail.durationMs)}ms; ${detail.bytes} bytes, ${detail.lines} lines${detail.missing ? "; FILE GONE" : ""}`,
			`  artifact: ${detail.artifactPath}`,
			`  preview: ${truncateUtf8(detail.preview, budget)}`,
			`  retrieve: read ${detail.artifactPath}; search: rg -n "<pattern>" ${detail.artifactPath}`,
		]).flat(),
	].join("\n");
	let content = makeContent(previewBudget);
	while (Buffer.byteLength(content, "utf8") > STEP_NOTIFY_MESSAGE_MAX_BYTES && previewBudget > 0) {
		previewBudget = Math.max(0, Math.floor(previewBudget / 2));
		content = makeContent(previewBudget);
	}
	// Paths are required for every child. If unusually long paths alone exceed
	// the ceiling, retain them and report a diagnostic rather than silently drop.
	if (Buffer.byteLength(content, "utf8") > STEP_NOTIFY_MESSAGE_MAX_BYTES) {
		content = `${content.slice(0, STEP_NOTIFY_MESSAGE_MAX_BYTES - 64)}\n[receipt exceeds byte ceiling due to required artifact paths]`;
	}
	const boundedDetails = details.map((detail) => ({ ...detail, preview: truncateUtf8(detail.preview, previewBudget) }));
	return { content, details: boundedDetails };
}

function runIdFromCompletion(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const data = payload as { runId?: unknown; id?: unknown };
	if (typeof data.runId === "string") return data.runId;
	return typeof data.id === "string" ? data.id : undefined;
}

function unref(handle: unknown): void {
	if (handle && typeof handle === "object" && "unref" in handle && typeof (handle as { unref?: unknown }).unref === "function") {
		(handle as { unref: () => void }).unref();
	}
}

/**
 * Pure policy function above is the contract; this registration owns artifact
 * discovery, hold-until-idle, per-run coalescing, and bounded delivery.
 */
export function registerStepNotifications(
	pi: Pick<ExtensionAPI, "sendMessage" | "events" | "on" | "appendEntry">,
	state: SubagentState,
	enabled: boolean,
	options: RegisterStepNotifyOptions = {},
): () => void {
	if (!enabled) return () => {};
	const timers = options.timers ?? {
		setTimeout: (handler: () => void, delayMs: number) => setTimeout(handler, delayMs),
		clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		setInterval: (handler: () => void, delayMs: number) => setInterval(handler, delayMs),
		clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
	};
	const fileExists = options.fileExists ?? fs.existsSync;
	const now = options.now ?? Date.now;
	const batchConfig = options.batchConfig ?? DEFAULT_COMPLETION_BATCH_CONFIG;
	const completionRuns = new Set<string>();
	const notified = state.stepNotifiedResults ?? new Set<string>();
	state.stepNotifiedResults = notified;
	const sentCount = new Map<string, number>();
	const pendingRuns = new Set<string>();
	const deferredItems = new Map<string, StepNotifyItem[]>();
	const suppressed = new Set<string>();
	const batchers = new Map<string, CompletionBatcher<StepNotifyItem>>();
	const queuedMessages = new Map<string, StepNotifyItem[]>();
	const globalStore = globalThis as Record<string, unknown>;
	const queuedMessagesStoreKey = "__pi_subagents_step_queued_messages__";
	const messageStartHandlerStoreKey = "__pi_subagents_step_message_start_handler__";
	globalStore[queuedMessagesStoreKey] = queuedMessages;
	const queueGeneration = randomUUID();
	let nextQueueKey = 0;
	let disposed = false;

	const sendQueuedReceipt = (runId: string, items: StepNotifyItem[]) => {
		if (items.length === 0 || disposed) return;
		const receipt = renderReceipt(items, fileExists);
		const queueKey = `subagent-step:${state.currentSessionId ?? "unknown"}:${runId}:${queueGeneration}:${++nextQueueKey}`;
		const sendMessage = pi.sendMessage as unknown as (
			message: Parameters<ExtensionAPI["sendMessage"]>[0],
			options: { triggerTurn: boolean; queueKey: string },
		) => void;
		sendMessage({
			customType: "subagent-step-notify",
			content: receipt.content,
			display: true,
			details: { version: 1, queueKey, notifications: receipt.details } satisfies StepNotifyEnvelope,
		}, { triggerTurn: true, queueKey });
		queuedMessages.set(queueKey, items);
	};

	const cancelPendingStepNotifications = (runId: string, stepIndexes: number[]) => {
		const cancelQueuedMessage = (pi as unknown as { cancelQueuedMessage?: (queueKey: string) => boolean }).cancelQueuedMessage;
		const fullyDelivered = state.fullyDeliveredStepResults ?? new Set<string>();
		const consumedIndexes = new Set(stepIndexes);
		for (const [queueKey, items] of queuedMessages) {
			if (!items.some((item) => item.runId === runId && consumedIndexes.has(item.details.stepIndex))) continue;
			if (typeof cancelQueuedMessage !== "function") {
				queuedMessages.delete(queueKey);
				recordStepNotificationTelemetry(pi, "cancel-unavailable", runId);
				continue;
			}
			if (!cancelQueuedMessage.call(pi, queueKey)) {
				queuedMessages.delete(queueKey);
				recordStepNotificationTelemetry(pi, "cancel-miss", runId);
				continue;
			}
			queuedMessages.delete(queueKey);
			recordStepNotificationTelemetry(pi, "cancelled", runId);
			const remaining = items.filter((item) => !fullyDelivered.has(stepResultKey(item.runId, item.details.stepIndex)) && !(item.runId === runId && consumedIndexes.has(item.details.stepIndex)));
			if (remaining.length > 0) {
				recordStepNotificationTelemetry(pi, "rebuilt", runId, remaining.length);
				sendQueuedReceipt(runId, remaining);
			}
		}
	};
	state.cancelPendingStepNotifications = cancelPendingStepNotifications;
	if (typeof globalStore[messageStartHandlerStoreKey] !== "function" && typeof pi.on === "function") {
		pi.on("message_start", (event) => {
			if (event.message.role !== "custom" || event.message.customType !== "subagent-step-notify") return;
			const envelope = event.message.details as StepNotifyEnvelope | undefined;
			const pending = globalStore[queuedMessagesStoreKey] as Map<string, StepNotifyItem[]> | undefined;
			if (envelope?.queueKey) pending?.delete(envelope.queueKey);
		});
		globalStore[messageStartHandlerStoreKey] = true;
	}

	const emit = (runId: string, items: StepNotifyItem[]) => {
		pendingRuns.delete(runId);
		if (disposed || items.length === 0 || completionRuns.has(runId)) return;
		const context = state.lastUiContext;
		if (context?.hasUI !== true) return;
		let idle = false;
		try { idle = context.isIdle() === true; } catch { idle = false; }
		if (!idle) {
			// A turn may start during the batcher's debounce window. Preserve the
			// complete items and retry after the turn ends instead of injecting mid-turn.
			const deferred = deferredItems.get(runId) ?? [];
			deferred.push(...items);
			deferredItems.set(runId, deferred);
			pendingRuns.add(runId);
			return;
		}
		sendQueuedReceipt(runId, items);
		sentCount.set(runId, (sentCount.get(runId) ?? 0) + 1);
	};

	const getBatcher = (runId: string) => {
		let batcher = batchers.get(runId);
		if (!batcher) {
			batcher = createCompletionBatcher({
				config: batchConfig,
				emit: (items) => emit(runId, items),
				timers,
				now,
			});
			batchers.set(runId, batcher);
		}
		return batcher;
	};

	const completionHandler = (payload: unknown) => {
		const runId = runIdFromCompletion(payload);
		if (!runId) return;
		completionRuns.add(runId);
		// Run completion already carries joined output; cancel any queued step
		// receipt so it cannot arrive afterward and duplicate that content.
		for (const [queueKey, items] of queuedMessages) {
			if (!items.some((item) => item.runId === runId)) continue;
			const cancel = (pi as unknown as { cancelQueuedMessage?: (queueKey: string) => boolean }).cancelQueuedMessage;
			const cancelled = typeof cancel === "function" && cancel.call(pi, queueKey);
			queuedMessages.delete(queueKey);
			recordStepNotificationTelemetry(pi, cancelled ? "cancelled-by-completion" : "cancel-miss-by-completion", runId);
		}
		batchers.get(runId)?.dispose();
		batchers.delete(runId);
		deferredItems.delete(runId);
		pendingRuns.delete(runId);
	};
	const unsubscribers = [
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, completionHandler),
		pi.events.on(SUBAGENT_FOREGROUND_COMPLETE_EVENT, completionHandler),
	].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");

	// Delivery is event-driven; the interval below is reconciliation for missed or
	// pre-existing lines (a publication that landed before this session subscribed).
	const stepResultUnsubscribe = pi.events.on(SUBAGENT_STEP_RESULT_EVENT, () => tick());
	if (typeof stepResultUnsubscribe === "function") unsubscribers.push(stepResultUnsubscribe);

	const tick = () => {
		if (disposed || state.asyncJobs.size === 0) return;
		const context = state.lastUiContext;
		// ExtensionContext can be missing during startup/headless operation. Never
		// guess that an absent hasUI means interactive.
		const hasUI = context?.hasUI === true;
		let idle = false;
		try {
			idle = hasUI && context?.isIdle() === true;
		} catch {
			idle = false;
		}
		if (idle) {
			for (const [runId, items] of deferredItems) {
				deferredItems.delete(runId);
				const batcher = getBatcher(runId);
				pendingRuns.add(runId);
				for (const item of items) batcher.push(item);
			}
		}
		for (const run of state.asyncJobs.values()) {
			if (run.status !== "queued" && run.status !== "running") continue;
			let artifacts: Array<StepResultArtifact<StepResultPresentation>>;
			try {
				artifacts = listStepResultArtifacts<StepResultPresentation>(run.asyncDir, { runId: run.asyncId });
			} catch {
				continue;
			}
			for (const artifact of artifacts) {
				const key = stepResultKey(run.asyncId, artifact.stepIndex);
				if (notified.has(key)) continue;
				const pending = pendingRuns.has(run.asyncId);
				const decision = shouldNotifyStepResult({
					enabled,
					hasUI,
					idle,
					consumed: consumedStepResultSet(state).has(key),
					completionSent: completionRuns.has(run.asyncId),
					notificationsSent: sentCount.get(run.asyncId) ?? 0,
					hasPendingNotification: pending,
				});
				if (!decision.notify) {
					if ((decision.reason === "already-consumed" || decision.reason === "completion-already-sent" || decision.reason === "per-run-cap") && !suppressed.has(key)) {
						suppressed.add(key);
						recordStepNotificationTelemetry(pi, `suppressed-${decision.reason}`, run.asyncId);
						if (decision.reason === "per-run-cap") {
							(options.logSuppression ?? ((id, index, reason) => console.info(`Suppressed step notification ${id}:${index}: ${reason}`)))(run.asyncId, artifact.stepIndex, decision.reason);
						}
					}
					continue;
				}
				notified.add(key);
				const item = { runId: run.asyncId, details: buildDetails(run, artifact) };
				const batcher = getBatcher(run.asyncId);
				if (artifact.state !== "complete") {
					batcher.flush();
					pendingRuns.delete(run.asyncId);
					emit(run.asyncId, [item]);
				} else {
					pendingRuns.add(run.asyncId);
					batcher.push(item);
				}
			}
		}
	};

	const interval = timers.setInterval(tick, options.pollIntervalMs ?? STEP_NOTIFY_POLL_MS);
	unref(interval);
	return () => {
		if (disposed) return;
		disposed = true;
		timers.clearInterval(interval);
		for (const batcher of batchers.values()) batcher.dispose();
		batchers.clear();
		deferredItems.clear();
		pendingRuns.clear();
		queuedMessages.clear();
		if (globalStore[queuedMessagesStoreKey] === queuedMessages) delete globalStore[queuedMessagesStoreKey];
		for (const unsubscribe of unsubscribers) unsubscribe();
		if (state.cancelPendingStepNotifications === cancelPendingStepNotifications) {
			delete state.cancelPendingStepNotifications;
		}
	};
}
