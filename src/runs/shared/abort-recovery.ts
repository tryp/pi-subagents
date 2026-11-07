import type { Message } from "@earendil-works/pi-ai";

export const ABORT_RECOVERY_PROMPT = "The prior run ended from a provider/transport abort after useful progress. Continue from the current files and transcript. Do not restart. Fix any validation failure or write the required report. Finish with final output.";

// Across 64 recoverable compaction-abort runs, the largest observed absolute
// gap between the last agent_settled and its nearest compaction_start was
// 1761 ms. 5000 ms leaves ~2.8x headroom while rejecting compactions from an
// earlier turn, which are minutes away. The real ordering includes settle ->
// manual compaction_start 12 ms later (willRetry:false).
export const DEFAULT_COMPACTION_SETTLEMENT_WINDOW_MS = 5000;

export type AbortRecoveryPlan =
	| { action: "resume"; prompt: typeof ABORT_RECOVERY_PROMPT }
	| { action: "settle"; reason: string; diagnostic?: string };

const PROVIDER_ABORT_PATTERN = /(?:provider|transport|connection|stream|socket|request).*(?:abort|closed|reset|ended|terminated|error|fail)|(?:abort|closed|reset|ended|terminated|error|fail).*(?:provider|transport|connection|stream|socket|request)/i;
const ABORT_ERROR_PATTERN = /\b(?:operation|request|response|stream|connection|transport|provider)?\s*(?:was\s+)?aborted\b/i;
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

export interface CompactionSettlementEvent {
	type?: string;
	willRetry?: unknown;
	reason?: unknown;
}

/** Tracks only the latest settlement and nearest compaction within a bounded window. */
export class CompactionSettlementTracker {
	private lastSettlementAt: number | undefined;
	private nearestCompactionAt: number | undefined;
	private verified = false;
	private readonly windowMs: number;

	constructor(windowMs = DEFAULT_COMPACTION_SETTLEMENT_WINDOW_MS) {
		this.windowMs = windowMs;
	}

	record(event: CompactionSettlementEvent, observedAt: number): void {
		if (event.type === "agent_start" || event.type === "auto_retry_start") {
			this.reset();
			return;
		}
		if (event.type === "compaction_end" && event.willRetry === true) {
			this.reset();
			return;
		}
		if (event.type === "agent_settled") {
			this.lastSettlementAt = observedAt;
			this.recompute();
			return;
		}
		if (event.type === "compaction_start") {
			this.nearestCompactionAt = observedAt;
			this.recompute();
		}
	}

	get afterCompactionSettlement(): boolean {
		return this.verified;
	}

	private recompute(): void {
		this.verified = this.lastSettlementAt !== undefined
			&& this.nearestCompactionAt !== undefined
			&& Math.abs(this.lastSettlementAt - this.nearestCompactionAt) <= this.windowMs;
	}

	private reset(): void {
		this.lastSettlementAt = undefined;
		this.nearestCompactionAt = undefined;
		this.verified = false;
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function contentParts(message: Record<string, unknown>): unknown[] {
	return Array.isArray(message.content) ? message.content : [];
}

function terminalAssistant(messages: readonly Message[]): { message?: Record<string, unknown>; index: number } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = record(messages[index]);
		if (message?.role === "assistant") return { message, index };
	}
	return { index: messages.length };
}

function zeroOutputUsage(message: Record<string, unknown>): boolean {
	const usage = record(message.usage);
	return usage !== undefined && (usage.output ?? usage.outputTokens ?? 0) === 0;
}

function isProviderAbortError(error: string): boolean {
	return !TOOL_FAILURE_PREFIX.test(error.trim()) && (PROVIDER_ABORT_PATTERN.test(error) || ABORT_ERROR_PATTERN.test(error));
}

function hasUsefulProgress(messages: readonly Message[], terminalIndex: number): boolean {
	for (let index = 0; index < terminalIndex; index++) {
		const message = record(messages[index]);
		if (!message) continue;
		if (message.role === "assistant" && contentParts(message).length > 0) return true;
		if (message.role === "toolResult" && message.isError !== true) return true;
	}
	return false;
}

function hasUnresolvedToolCall(messages: readonly Message[]): boolean {
	const pending = new Set<string>();
	for (const rawMessage of messages) {
		const message = record(rawMessage);
		if (!message) continue;
		if (message.role === "assistant") {
			for (const rawPart of contentParts(message)) {
				const part = record(rawPart);
				if (part?.type === "toolCall" && typeof part.id === "string" && part.id) pending.add(part.id);
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			pending.delete(message.toolCallId);
		}
	}
	return pending.size > 0;
}

export interface PlanAbortRecoveryInput {
	messages: readonly Message[];
	error?: string;
	processSignal?: string | null;
	sessionAvailable: boolean;
	alreadyResumed: boolean;
	stopped?: boolean;
	interrupted?: boolean;
	timedOut?: boolean;
	toolBudgetExhausted?: boolean;
	usageBudgetExhausted?: boolean;
	structuredOutputFailed?: boolean;
	acceptanceFailed?: boolean;
	currentTool?: string;
	afterCompactionSettlement?: boolean;
}

export function planAbortRecovery(input: PlanAbortRecoveryInput): AbortRecoveryPlan {
	const terminal = terminalAssistant(input.messages);
	const message = terminal.message;
	const terminalError = typeof message?.errorMessage === "string" ? message.errorMessage : undefined;
	const terminalAssistantAbort = message?.stopReason === "aborted"
		|| (message?.stopReason === "error" && terminalError !== undefined && isProviderAbortError(terminalError));
	const abortCandidate = message !== undefined
		&& contentParts(message).length === 0
		&& zeroOutputUsage(message)
		&& terminalAssistantAbort;
	const compactionAbortCandidate = input.afterCompactionSettlement === true && abortCandidate;
	const settle = (reason: string): AbortRecoveryPlan => ({
		action: "settle",
		reason,
		...(compactionAbortCandidate
			? { diagnostic: `Compaction-induced child abort could not be resumed safely: ${reason}.` }
			: {}),
	});

	if (input.alreadyResumed) return settle("resume already attempted");
	if (!input.sessionAvailable) return settle("retained session unavailable");
	if (input.stopped || input.interrupted) return settle("explicit stop or interrupt");
	// The process runner's terminal drain sends SIGTERM after settlement. That
	// cleanup signal is non-authoritative only for a verified abort candidate.
	if (input.processSignal && !compactionAbortCandidate) return settle("process terminated by signal");
	if (input.timedOut) return settle("elapsed timeout");
	if (input.toolBudgetExhausted || input.usageBudgetExhausted) return settle("budget exhausted");
	if (input.structuredOutputFailed) return settle("structured output failure");
	if (input.acceptanceFailed) return settle("acceptance failure");
	if (input.currentTool) return settle(`active tool '${input.currentTool.slice(0, 128)}' remains in flight`);
	if (hasUnresolvedToolCall(input.messages)) return settle("unresolved tool call remains in transcript");
	if (!input.afterCompactionSettlement) return settle("compaction settlement not verified");
	if (!abortCandidate) return settle("terminal assistant abort evidence not verified");
	if (!hasUsefulProgress(input.messages, terminal.index)) return settle("no useful prior progress");
	return { action: "resume", prompt: ABORT_RECOVERY_PROMPT };
}

export interface AbortRecoveryAttempt {
	exitCode: number | null;
	messages?: readonly Message[];
	error?: string;
	processSignal?: string | null;
	stopped?: boolean;
	interrupted?: boolean;
	timedOut?: boolean;
	afterCompactionSettlement?: boolean;
}

export async function recoverAbortOnce<T extends AbortRecoveryAttempt>(input: {
	initial: T;
	planInput: (attempt: T, alreadyResumed: boolean) => PlanAbortRecoveryInput;
	runContinuation: (prompt: string) => Promise<T>;
	mergeAttempts: (initial: T, resumed: T) => T;
}): Promise<{ result: T; resumed: boolean; plan?: AbortRecoveryPlan }> {
	const failed = (attempt: T): boolean => attempt.exitCode !== 0 || Boolean(attempt.error);
	if (!failed(input.initial)) return { result: input.initial, resumed: false };

	const firstPlan = planAbortRecovery(input.planInput(input.initial, false));
	if (firstPlan.action === "settle") {
		return {
			result: firstPlan.diagnostic
				? { ...input.initial, error: appendDiagnostic(input.initial.error, firstPlan.diagnostic) } as T
				: input.initial,
			resumed: false,
			plan: firstPlan,
		};
	}

	const resumedAttempt = await input.runContinuation(firstPlan.prompt);
	const merged = input.mergeAttempts(input.initial, resumedAttempt);
	if (!failed(resumedAttempt)) return { result: merged, resumed: true, plan: firstPlan };

	const secondInput = input.planInput(merged, true);
	secondInput.afterCompactionSettlement = input.initial.afterCompactionSettlement === true
		|| resumedAttempt.afterCompactionSettlement === true;
	const secondPlan = planAbortRecovery(secondInput);
	return {
		result: secondPlan.action === "settle" && secondPlan.diagnostic
			? { ...merged, error: appendDiagnostic(merged.error, secondPlan.diagnostic) } as T
			: merged,
		resumed: true,
		plan: secondPlan,
	};
}

function appendDiagnostic(error: string | undefined, diagnostic: string): string {
	return error?.includes(diagnostic) ? error : error ? `${error}\n${diagnostic}` : diagnostic;
}
