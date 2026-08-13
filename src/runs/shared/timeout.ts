/**
 * Shared timeout resolution for subagent runs.
 *
 * `timeoutMs` and `maxRuntimeMs` are aliases wherever a timeout can be
 * configured: the top-level invocation, individual parallel task items
 * (top-level `tasks[...]` and chain `parallel[...]` items), and individual
 * chain steps. These helpers validate the alias pair consistently and collapse
 * it to a single effective `timeoutMs`, then resolve a per-child deadline from
 * the run-level timeout (if any) and the per-item timeout (if any).
 */

export interface TimeoutAliasInput {
	timeoutMs?: unknown;
	maxRuntimeMs?: unknown;
}

export interface ResolvedTimeoutAlias {
	timeoutMs?: number;
	error?: string;
}

/**
 * Validate and collapse the `timeoutMs`/`maxRuntimeMs` alias pair for one
 * scope (e.g. `tasks[0]`, `chain[2]`, or the top-level invocation).
 *
 * - Neither present: no timeout.
 * - Either present: must be a positive integer.
 * - Both present: must be equal (they are aliases).
 *
 * `label` names the scope in error messages ("" for the top-level invocation).
 */
export function resolveTimeoutAlias(input: TimeoutAliasInput, label = ""): ResolvedTimeoutAlias {
	const rawTimeout = input.timeoutMs;
	const rawMaxRuntime = input.maxRuntimeMs;
	if (rawTimeout === undefined && rawMaxRuntime === undefined) return {};
	const prefix = label ? `${label}.` : "";
	for (const [name, value] of [["timeoutMs", rawTimeout], ["maxRuntimeMs", rawMaxRuntime]] as const) {
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			return { error: `${prefix}${name} must be a positive integer.` };
		}
	}
	if (rawTimeout !== undefined && rawMaxRuntime !== undefined && rawTimeout !== rawMaxRuntime) {
		return { error: `${label ? `${label}: ` : ""}timeoutMs and maxRuntimeMs are aliases; provide only one value or use the same value for both.` };
	}
	return { timeoutMs: (rawTimeout ?? rawMaxRuntime) as number };
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
