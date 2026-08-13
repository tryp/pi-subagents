/**
 * Shared timeout resolution for subagent runs.
 *
 * `timeoutMs` is the canonical timeout field for the top-level invocation,
 * individual parallel task items, and individual chain steps. This helper
 * validates it consistently, then resolves a per-child deadline from the
 * run-level timeout (if any) and the per-item timeout (if any).
 */

export interface TimeoutInput {
	timeoutMs?: unknown;
}

export interface ResolvedTimeout {
	timeoutMs?: number;
	error?: string;
}

/** Validate a timeout value for one scope (for example, `tasks[0]`). */
export function resolveTimeout(input: TimeoutInput, label = ""): ResolvedTimeout {
	if (input.timeoutMs === undefined) return {};
	if (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
		return { error: `${label ? `${label}.` : ""}timeoutMs must be a positive integer.` };
	}
	return { timeoutMs: input.timeoutMs };
}

/**
 * Resolve the effective timeout for one child run given the run-level timeout
 * (its `timeoutMs` plus a pre-computed `deadlineAt`) and the per-item timeout.
 *
 * The run-level timeout keeps whole-invocation semantics: it bounds every
 * child (and, for async runs, aborts the whole run). A per-item timeout
 * additionally bounds that single child without affecting siblings. When both
 * exist, whichever deadline is sooner is authoritative and its `timeoutMs` is
 * used for the reported message.
 */
export function resolveChildDeadline(
	runTimeoutMs: number | undefined,
	runDeadlineAt: number | undefined,
	itemTimeoutMs: number | undefined,
): { timeoutMs?: number; deadlineAt?: number } {
	if (itemTimeoutMs === undefined) {
		if (runDeadlineAt === undefined) return {};
		return { timeoutMs: runTimeoutMs, deadlineAt: runDeadlineAt };
	}
	const itemDeadlineAt = Date.now() + itemTimeoutMs;
	if (runDeadlineAt === undefined) {
		return { timeoutMs: itemTimeoutMs, deadlineAt: itemDeadlineAt };
	}
	if (itemDeadlineAt <= runDeadlineAt) {
		return { timeoutMs: itemTimeoutMs, deadlineAt: itemDeadlineAt };
	}
	return { timeoutMs: runTimeoutMs, deadlineAt: runDeadlineAt };
}
