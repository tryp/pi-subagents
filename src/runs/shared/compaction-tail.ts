import * as fs from "node:fs";
import type { AsyncStepFailureKind, StepCompactionDiagnosis } from "../../shared/types.ts";

/**
 * How many transcript entries after the compaction still count as "the child
 * died because of the compaction" rather than "the child died much later".
 */
export const DEFAULT_MAX_TAIL_ENTRIES_AFTER_COMPACTION = 3;

/** Enough trailing entries to find a compaction and count what follows it. */
export const DEFAULT_TAIL_ENTRY_BUDGET = 16;

const READ_BLOCK_BYTES = 64 * 1024;

/**
 * Upper bound on how much of the transcript tail is read. A session file can be
 * hundreds of megabytes; the answer only ever comes from the last few entries,
 * so reading stops as soon as enough entries parse.
 */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * A child that dies while compacting its context exits nonzero with an abort
 * message even though the compaction itself succeeded. The message comes from
 * the aborted in-flight request, not from the harness, so it is matched by text
 * and kept narrow on purpose: a genuine "stopped by user" or timeout must not
 * land here.
 */
const ABORT_FAILURE_PATTERN = /this operation was aborted|aborterror|operation was aborted/i;

export interface SessionTailEntry {
	type?: string;
	customType?: string;
	tokensBefore?: number;
	firstKeptEntryId?: string;
	summary?: unknown;
}

export function isAbortFailure(error: string | undefined | null): boolean {
	return typeof error === "string" && ABORT_FAILURE_PATTERN.test(error);
}

/**
 * Parse the last `minEntries` JSONL entries of a session file, reading backwards
 * in blocks. Never throws: an unreadable or truncated file yields fewer entries.
 */
export function readSessionTailEntries(sessionFile: string, minEntries = DEFAULT_TAIL_ENTRY_BUDGET): SessionTailEntry[] {
	let fd: number;
	try {
		fd = fs.openSync(sessionFile, "r");
	} catch {
		return [];
	}
	try {
		const size = fs.fstatSync(fd).size;
		let offset = size;
		let buffer = "";
		while (offset > 0) {
			const block = Math.min(READ_BLOCK_BYTES, offset);
			offset -= block;
			const chunk = Buffer.alloc(block);
			const read = fs.readSync(fd, chunk, 0, block, offset);
			if (read <= 0) break;
			buffer = chunk.subarray(0, read).toString("utf-8") + buffer;
			const parsed = parseTail(buffer, offset === 0);
			if (parsed.length >= minEntries || buffer.length >= MAX_TAIL_BYTES) return parsed;
		}
		return parseTail(buffer, true);
	} catch {
		return [];
	} finally {
		fs.closeSync(fd);
	}
}

function parseTail(buffer: string, complete: boolean): SessionTailEntry[] {
	const lines = buffer.split("\n");
	// A block boundary cuts the first line of the buffer, so it is dropped
	// unless the read reached the start of the file.
	if (!complete) lines.shift();
	const entries: SessionTailEntry[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object") entries.push(parsed as SessionTailEntry);
		} catch {
			// A truncated or non-JSON line is not evidence either way; skip it.
		}
	}
	return entries;
}

function compactionCompleted(entry: SessionTailEntry): boolean {
	// pi only appends a `compaction` entry once the summary landed, so the entry
	// existing is the completion signal; the fields are checked to stay honest
	// about a half-written record.
	return typeof entry.firstKeptEntryId === "string" || (typeof entry.summary === "string" && entry.summary.length > 0);
}

/**
 * Describe the compaction at the end of a child transcript, if any.
 *
 * `occurred` is true when the tail contains a `compaction` entry, `completed`
 * when that entry looks fully written, and `tailEntriesAfter` counts the entries
 * after it (0 means the compaction is the last thing the child wrote).
 */
export function diagnoseCompactionTail(
	sessionFile: string | undefined,
	options: { tailEntryBudget?: number } = {},
): StepCompactionDiagnosis {
	if (!sessionFile) return { occurred: false, completed: false, tailEntriesAfter: 0 };
	const entries = readSessionTailEntries(sessionFile, options.tailEntryBudget ?? DEFAULT_TAIL_ENTRY_BUDGET);
	let index = -1;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		if (entries[i].type === "compaction") {
			index = i;
			break;
		}
	}
	if (index === -1) return { occurred: false, completed: false, tailEntriesAfter: 0 };
	const entry = entries[index];
	return {
		occurred: true,
		completed: compactionCompleted(entry),
		...(typeof entry.tokensBefore === "number" ? { tokensBefore: entry.tokensBefore } : {}),
		tailEntriesAfter: entries.length - 1 - index,
	};
}

export interface CompactedThenAbortedInput {
	sessionFile?: string;
	error?: string;
	exitCode?: number | null;
	stopped?: boolean;
	timedOut?: boolean;
	interrupted?: boolean;
	tailEntryBudget?: number;
	maxTailEntriesAfter?: number;
}

export interface CompactionFailureDiagnosis {
	failureKind?: AsyncStepFailureKind;
	retryable?: boolean;
	compaction?: StepCompactionDiagnosis;
}

/**
 * Decide whether a failed child died *because of* a compaction it completed.
 *
 * The transcript is only read when the failure already looks like an abort, so a
 * successful step pays nothing. A stopped, timed-out or interrupted child is
 * never classified: those are deliberate ends with their own messages.
 */
export function classifyCompactedThenAborted(input: CompactedThenAbortedInput): CompactionFailureDiagnosis {
	if (input.exitCode === 0 || input.exitCode === null || input.exitCode === undefined) return {};
	if (input.stopped || input.timedOut || input.interrupted) return {};
	if (!isAbortFailure(input.error)) return {};
	const compaction = diagnoseCompactionTail(input.sessionFile, { tailEntryBudget: input.tailEntryBudget });
	const maxTailEntriesAfter = input.maxTailEntriesAfter ?? DEFAULT_MAX_TAIL_ENTRIES_AFTER_COMPACTION;
	const failureKind =
		compaction.occurred && compaction.completed && compaction.tailEntriesAfter <= maxTailEntriesAfter
			? "compacted_then_aborted"
			: undefined;
	return { compaction, ...(failureKind ? { failureKind, retryable: true } : {}) };
}
