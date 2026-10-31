import {
	type ActivityState,
	type ControlConfig,
	type ControlEvent,
	type ControlEventType,
	type ControlNotificationChannel,
	type ResolvedControlConfig,
} from "../../shared/types.ts";

const CONTROL_EVENT_TYPES: ControlEventType[] = ["active_long_running", "needs_attention"];
const CONTROL_NOTIFICATION_CHANNELS: ControlNotificationChannel[] = ["event", "async", "intercom"];
const DEFAULT_NOTIFY_ON: ControlEventType[] = ["active_long_running", "needs_attention"];

// Three-day paired-call measurement: bash p99=87.8s (n=262,978), subagent p99=122.0s (n=50,005),
// jobs p99=284.8s (n=51,470), subagent_wait p99=256.7s (n=9,847). Soft means "slow but alive"; hard means "probably wedged".
// jobs/subagent_wait use progress-silence (output/status activity), since they intentionally wait for minutes.
// Other tool names use global p99=130.7s (n=588,956); event telemetry records this fallback.
export const TOOL_DURATION_BASELINES = {
	bash: { p99Ms: 87_800, n: 262_978, proxy: false },
	subagent: { p99Ms: 122_000, n: 50_005, proxy: false },
	jobs: { p99Ms: 284_800, n: 51_470, proxy: false },
	subagent_wait: { p99Ms: 256_700, n: 9_847, proxy: false },
	other: { p99Ms: 130_700, n: 588_956, proxy: true },
} as const;
const SOFT_TOOL_DURATION_MULTIPLE = 2;
const HARD_TOOL_DURATION_MULTIPLE = 4;

export function toolDurationThresholds(toolName: string, fallbackHardMs = 0): { softMs: number; hardMs: number; p99Ms: number; kind: string; baselineN: number; proxy: boolean; progressBased: boolean } {
	const kind = toolName === "bash" || toolName === "bash_bg" ? "bash" : toolName === "subagent" ? "subagent" : toolName === "subagent_wait" ? "subagent_wait" : toolName === "jobs" ? "jobs" : "other";
	const baseline = TOOL_DURATION_BASELINES[kind];
	const progressBased = kind === "jobs" || kind === "subagent_wait";
	const softMultiple = progressBased ? 1 : SOFT_TOOL_DURATION_MULTIPLE;
	const hardMultiple = progressBased ? 2 : HARD_TOOL_DURATION_MULTIPLE;
	const hardMs = kind === "other" && fallbackHardMs > 0 ? fallbackHardMs : baseline.p99Ms * hardMultiple;
	return { softMs: baseline.p99Ms * softMultiple, hardMs, p99Ms: baseline.p99Ms, kind, baselineN: baseline.n, proxy: baseline.proxy, progressBased };
}

export function recordToolStallTelemetry(
	appendEntry: (customType: string, data?: unknown) => void,
	event: ControlEvent,
): void {
	if (event.reason !== "tool_slow" && event.reason !== "tool_wedged") return;
	const baseline = toolDurationThresholds(event.currentTool ?? "unknown");
	try {
		appendEntry("subagent_tool_stall_telemetry", {
			version: 1,
			event: event.reason === "tool_slow" ? "long_running_alive" : "probably_wedged",
			runId: event.runId,
			tool: event.currentTool,
			kind: baseline.kind,
			count: 1,
			proxy: baseline.proxy,
			baselineN: baseline.baselineN,
			p99Ms: baseline.p99Ms,
		});
	} catch {
		// Telemetry must never interfere with control notices.
	}
}

export function toolDurationTier(toolName: string, elapsedMs: number, fallbackHardMs = 0): "long_running" | "probably_wedged" | undefined {
	const thresholds = toolDurationThresholds(toolName, fallbackHardMs);
	if (elapsedMs > thresholds.hardMs) return "probably_wedged";
	if (elapsedMs > thresholds.softMs) return "long_running";
	return undefined;
}

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
	enabled: true,
	needsAttentionAfterMs: 60_000,
	// Legacy override/fallback for tool names without a measured kind-specific baseline.
	toolInFlightGraceMs: TOOL_DURATION_BASELINES.other.p99Ms * HARD_TOOL_DURATION_MULTIPLE,
	activeNoticeAfterMs: 240_000,
	failedToolAttemptsBeforeAttention: 3,
	notifyOn: DEFAULT_NOTIFY_ON,
	notifyChannels: CONTROL_NOTIFICATION_CHANNELS,
};

function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

function parseControlList<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (value.length === 0) return [];
	const allowedSet = new Set(allowed);
	const parsed = value.filter((entry): entry is T => typeof entry === "string" && allowedSet.has(entry as T));
	return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
}

export function resolveControlConfig(
	globalConfig?: ControlConfig,
	override?: ControlConfig,
): ResolvedControlConfig {
	const enabled = override?.enabled ?? globalConfig?.enabled ?? DEFAULT_CONTROL_CONFIG.enabled;
	const needsAttentionAfterMs = parsePositiveInt(override?.needsAttentionAfterMs)
		?? parsePositiveInt(globalConfig?.needsAttentionAfterMs)
		?? DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs;
	const toolInFlightGraceMs = parsePositiveInt(override?.toolInFlightGraceMs)
		?? parsePositiveInt(globalConfig?.toolInFlightGraceMs)
		?? DEFAULT_CONTROL_CONFIG.toolInFlightGraceMs;
	const activeNoticeAfterMs = parsePositiveInt(override?.activeNoticeAfterMs)
		?? parsePositiveInt(globalConfig?.activeNoticeAfterMs)
		?? DEFAULT_CONTROL_CONFIG.activeNoticeAfterMs;
	const activeNoticeAfterTurns = parsePositiveInt(override?.activeNoticeAfterTurns)
		?? parsePositiveInt(globalConfig?.activeNoticeAfterTurns);
	const activeNoticeAfterTokens = parsePositiveInt(override?.activeNoticeAfterTokens)
		?? parsePositiveInt(globalConfig?.activeNoticeAfterTokens);
	const failedToolAttemptsBeforeAttention = parsePositiveInt(override?.failedToolAttemptsBeforeAttention)
		?? parsePositiveInt(globalConfig?.failedToolAttemptsBeforeAttention)
		?? DEFAULT_CONTROL_CONFIG.failedToolAttemptsBeforeAttention;
	const notifyOn = parseControlList(override?.notifyOn, CONTROL_EVENT_TYPES)
		?? parseControlList(globalConfig?.notifyOn, CONTROL_EVENT_TYPES)
		?? DEFAULT_CONTROL_CONFIG.notifyOn;
	const notifyChannels = parseControlList(override?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS)
		?? parseControlList(globalConfig?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS)
		?? DEFAULT_CONTROL_CONFIG.notifyChannels;
	return {
		enabled,
		needsAttentionAfterMs,
		toolInFlightGraceMs,
		activeNoticeAfterMs,
		activeNoticeAfterTurns,
		activeNoticeAfterTokens,
		failedToolAttemptsBeforeAttention,
		notifyOn: [...notifyOn],
		notifyChannels: [...notifyChannels],
	};
}

export function deriveActivityState(input: {
	config: ResolvedControlConfig;
	startedAt: number;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	now?: number;
}): ActivityState | undefined {
	if (!input.config.enabled) return undefined;
	const now = input.now ?? Date.now();
	if (input.currentTool) {
		const thresholds = toolDurationThresholds(input.currentTool, input.config.toolInFlightGraceMs);
		const baselineAt = thresholds.progressBased
			? (input.lastActivityAt ?? input.currentToolStartedAt ?? input.startedAt)
			: (input.currentToolStartedAt ?? input.lastActivityAt ?? input.startedAt);
		const inFlightMs = Math.max(0, now - baselineAt);
		return inFlightMs > thresholds.hardMs ? "needs_attention" : "active_long_running";
	}
	const lastActivity = input.lastActivityAt ?? input.startedAt;
	const ageMs = Math.max(0, now - lastActivity);
	return ageMs > input.config.needsAttentionAfterMs ? "needs_attention" : undefined;
}

export function buildControlEvent(input: {
	type?: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	runId: string;
	agent: string;
	index?: number;
	ts?: number;
	lastActivityAt?: number;
	message?: string;
	reason?: ControlEvent["reason"];
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
}): ControlEvent {
	const ts = input.ts ?? Date.now();
	const type = input.type ?? (input.to === "active_long_running" ? "active_long_running" : "needs_attention");
	const elapsedMs = input.elapsedMs ?? (input.lastActivityAt ? Math.max(0, ts - input.lastActivityAt) : undefined);
	const elapsedSeconds = elapsedMs !== undefined ? Math.floor(elapsedMs / 1000) : undefined;
	const message = input.message ?? (type === "active_long_running"
		? `${input.agent} is still active but long-running`
		: elapsedSeconds !== undefined
			? `${input.agent} needs attention (no observed activity for ${elapsedSeconds}s)`
			: `${input.agent} needs attention`);
	return {
		type,
		...(input.from ? { from: input.from } : {}),
		to: input.to,
		ts,
		runId: input.runId,
		agent: input.agent,
		...(input.index !== undefined ? { index: input.index } : {}),
		message,
		reason: input.reason ?? (type === "active_long_running" ? "active_long_running" : "idle"),
		...(input.turns !== undefined ? { turns: input.turns } : {}),
		...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
		...(input.toolCount !== undefined ? { toolCount: input.toolCount } : {}),
		...(input.currentTool ? { currentTool: input.currentTool } : {}),
		...(input.currentToolDurationMs !== undefined ? { currentToolDurationMs: input.currentToolDurationMs } : {}),
		...(input.currentPath ? { currentPath: input.currentPath } : {}),
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(input.recentFailureSummary ? { recentFailureSummary: input.recentFailureSummary } : {}),
	};
}

export function shouldNotifyControlEvent(config: ResolvedControlConfig, event: ControlEvent): boolean {
	return config.enabled && config.notifyOn.includes(event.type);
}

export function controlNotificationKey(event: ControlEvent, childIntercomTarget?: string): string {
	const childKey = childIntercomTarget ?? (event.index !== undefined ? `${event.runId}:${event.index}` : event.runId);
	return `${childKey}:${event.type}:${event.reason ?? "idle"}`;
}

export function claimControlNotification(config: ResolvedControlConfig, event: ControlEvent, seenKeys: Set<string>, childIntercomTarget?: string): boolean {
	if (!shouldNotifyControlEvent(config, event)) return false;
	const key = controlNotificationKey(event, childIntercomTarget);
	if (seenKeys.has(key)) return false;
	seenKeys.add(key);
	return true;
}

function formatLongRunningFacts(event: ControlEvent): string | undefined {
	const facts: string[] = [];
	if (event.elapsedMs !== undefined) facts.push(`elapsed ${Math.floor(Math.max(0, event.elapsedMs) / 1000)}s`);
	if (event.turns !== undefined) facts.push(`${event.turns} turns`);
	if (event.tokens !== undefined) facts.push(`${event.tokens} tokens`);
	if (event.toolCount !== undefined) facts.push(`${event.toolCount} tools`);
	if (event.currentTool) facts.push(`tool ${event.currentTool}${event.currentToolDurationMs !== undefined ? ` ${Math.floor(Math.max(0, event.currentToolDurationMs) / 1000)}s` : ""}`);
	if (event.currentPath) facts.push(`path ${event.currentPath}`);
	return facts.length > 0 ? facts.join(" | ") : undefined;
}

export function formatControlNoticeMessage(event: ControlEvent, childIntercomTarget?: string): string {
	const runTarget = event.runId;
	if (event.reason === "completion_guard") {
		return [
			`Subagent failed: ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			"Next: read the output artifact or session from the subagent result, then retry with a more explicit implementation prompt or handle the fix directly.",
			childIntercomTarget ? `Run intercom target (may be inactive): ${childIntercomTarget}` : undefined,
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	const nudgeMessage = "What are you blocked on? Reply with the smallest next step or ask for a decision.";
	const steerCommand = `subagent({ action: "steer", id: "${runTarget}", ${event.index !== undefined ? `index: ${event.index}, ` : ""}message: "${nudgeMessage}" })`;
	const nestedResumeCommand = `subagent({ action: "resume", id: "${runTarget}", message: "${nudgeMessage}" })`;
	if (event.type === "active_long_running") {
		const facts = formatLongRunningFacts(event);
		return [
			`${event.reason === "tool_slow" ? "Tool slow but still active" : "Subagent active but long-running"}: ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			facts ? `Facts: ${facts}` : undefined,
			"Hint: Inspect status first. Use steer for a top-level live async child, routed resume for a live nested child, or resume to revive a paused/completed/failed child.",
			`Top-level live async nudge: ${steerCommand}`,
			`Routed live nested nudge: ${nestedResumeCommand}`,
			childIntercomTarget ? `Direct intercom target: ${childIntercomTarget}` : undefined,
			`Status: subagent({ action: "status", id: "${runTarget}" })`,
			`Interrupt: subagent({ action: "interrupt", id: "${runTarget}" })`,
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	return [
		`${event.reason === "tool_wedged" ? "Tool probably wedged" : "Subagent needs attention"}: ${event.agent}`,
		`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
		`Signal: ${event.message}`,
		event.recentFailureSummary ? `Recent failures: ${event.recentFailureSummary}` : undefined,
		"Hint: Inspect status first unless the run is clearly blocked. Use steer for a top-level live async child, routed resume for a live nested child, or resume to revive a paused/completed/failed child.",
		`Top-level live async nudge: ${steerCommand}`,
		`Routed live nested nudge: ${nestedResumeCommand}`,
		childIntercomTarget ? `Direct intercom target: ${childIntercomTarget}` : undefined,
		`Status: subagent({ action: "status", id: "${runTarget}" })`,
		`Interrupt: subagent({ action: "interrupt", id: "${runTarget}" })`,
	].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatControlIntercomMessage(event: ControlEvent, childIntercomTarget?: string): string {
	const statusLabel = event.reason === "completion_guard"
		? "subagent failed"
		: event.reason === "tool_slow"
			? "tool slow but still active"
			: event.reason === "tool_wedged"
				? "tool probably wedged"
				: event.type === "active_long_running"
					? "subagent active but long-running"
					: "subagent needs attention";
	return [
		statusLabel,
		"",
		event.reason === "completion_guard"
			? `${event.agent} failed in run ${event.runId}.`
			: event.reason === "tool_slow"
				? `${event.agent} has a slow but still-active tool call in run ${event.runId}.`
				: event.reason === "tool_wedged"
					? `${event.agent} has a tool call that is probably wedged in run ${event.runId}.`
					: event.type === "active_long_running"
						? `${event.agent} is still active but long-running in run ${event.runId}.`
						: `${event.agent} needs attention in run ${event.runId}.`,
		"",
		formatControlNoticeMessage(event, childIntercomTarget),
	].join("\n");
}
