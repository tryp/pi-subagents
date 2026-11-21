export type PendingResultState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped";

export interface PendingResultStep {
	agent: string;
	status: string;
}

export interface PendingResultRun {
	id: string;
	asyncDir: string;
	state: PendingResultState;
	outputFile?: string;
	steps?: PendingResultStep[];
}

export interface PendingResultLine {
	runId: string;
	agent: string;
	state: PendingResultState;
	resultPath: string;
	recoveredFromHistory: boolean;
}

export interface PendingResultSelection {
	lines: PendingResultLine[];
	acknowledgeRunIds: string[];
	runChildCounts: Map<string, number>;
	totalChildren: number;
	skippedRuns: number;
}

export interface PendingResultMessage {
	content: string;
	shownRunIds: string[];
	omittedChildren: number;
}

const TERMINAL_STATES = new Set<PendingResultState>(["complete", "failed", "paused", "stopped"]);
const MAX_HISTORY_ENTRIES = 2_000;
const MAX_PENDING_LINES = 24;
const MAX_MESSAGE_CHARS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addRunId(value: unknown, ids: Set<string>): void {
	if (typeof value === "string" && value.trim()) ids.add(value.trim());
}

export function completionNoticeRunIds(message: unknown): string[] {
	if (!isRecord(message) || message.customType !== "subagent-notify") return [];
	const details = message.details;
	const ids: string[] = [];
	if (Array.isArray(details)) {
		for (const item of details) {
			if (isRecord(item) && item.source !== "foreground" && typeof item.runId === "string" && item.runId.trim()) ids.push(item.runId.trim());
		}
		return ids;
	}
	if (!isRecord(details) || !Array.isArray(details.completions)) return [];
	for (const item of details.completions) {
		if (isRecord(item) && item.source !== "foreground" && typeof item.runId === "string" && item.runId.trim()) ids.push(item.runId.trim());
	}
	return ids;
}

/** Extract run ids already represented by completion notices in the retained session tail. */
export function findCompletionNoticeRunIds(entries: unknown[]): { runIds: Set<string>; skippedEntries: number } {
	const runIds = new Set<string>();
	let skippedEntries = Math.max(0, entries.length - MAX_HISTORY_ENTRIES);
	for (const entry of entries.slice(-MAX_HISTORY_ENTRIES)) {
		if (!isRecord(entry)) {
			skippedEntries++;
			continue;
		}
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message || message.customType !== "subagent-notify") continue;
		const ids = completionNoticeRunIds(message);
		if (ids.length === 0) skippedEntries++;
		for (const id of ids) addRunId(id, runIds);
	}
	return { runIds, skippedEntries };
}

/** Select only terminal, unacknowledged runs; history ids annotate notices recovered after compaction. */
export function selectPendingResults(
	runs: PendingResultRun[],
	acknowledgedRunIds: ReadonlySet<string>,
	historyRunIds: ReadonlySet<string>,
	maxLines = MAX_PENDING_LINES,
): PendingResultSelection {
	const lines: PendingResultLine[] = [];
	const acknowledgeRunIds: string[] = [];
	const runChildCounts = new Map<string, number>();
	let totalChildren = 0;
	let skippedRuns = 0;
	for (const run of runs) {
		if (!run || typeof run.id !== "string" || !run.id || !TERMINAL_STATES.has(run.state)) continue;
		if (acknowledgedRunIds.has(run.id)) continue;
		const children = Array.isArray(run.steps) && run.steps.length > 0
			? run.steps.filter((step) => step && typeof step.agent === "string" && step.agent.trim())
			: [{ agent: "subagent", status: run.state }];
		if (children.length === 0) {
			skippedRuns++;
			continue;
		}
		const recoveredFromHistory = historyRunIds.has(run.id);
		totalChildren += children.length;
		const beforeRunLines = lines.length;
		for (const child of children) {
			if (lines.length >= maxLines) break;
			lines.push({
				runId: run.id,
				agent: child.agent.trim(),
				state: TERMINAL_STATES.has(child.status as PendingResultState) ? child.status as PendingResultState : run.state,
				resultPath: run.outputFile || run.asyncDir,
				recoveredFromHistory,
			});
		}
		const included = lines.length - beforeRunLines;
		runChildCounts.set(run.id, children.length);
		if (included === children.length) acknowledgeRunIds.push(run.id);
	}
	return { lines, acknowledgeRunIds, runChildCounts, totalChildren, skippedRuns };
}

function oneLine(value: string, max: number): string {
	const flattened = value.replace(/[\r\n\t]+/g, " ").trim();
	return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
}

/** Render a bounded, user-visible summary and identify which runs it actually includes. */
export function formatPendingResultsMessage(selection: PendingResultSelection, maxChars = MAX_MESSAGE_CHARS): PendingResultMessage | undefined {
	if (selection.lines.length === 0) return undefined;
	const content = [`Pending results: ${selection.totalChildren} unacknowledged child result(s).`];
	const visibleLines: PendingResultLine[] = [];
	for (const line of selection.lines) {
		const recovered = line.recoveredFromHistory ? " (recovered from session history)" : "";
		const text = `- ${oneLine(line.agent, 80)} — ${line.state}${recovered}; result: ${oneLine(line.resultPath, 180)}`;
		if (content.join("\n").length + text.length + 1 > maxChars) break;
		content.push(text);
		visibleLines.push(line);
	}
	const omittedChildren = Math.max(0, selection.totalChildren - visibleLines.length);
	if (omittedChildren > 0) {
		const suffix = `- ${omittedChildren} additional child result(s) omitted; inspect the listed run directories.`;
		while (content.join("\n").length + suffix.length + 1 > maxChars && visibleLines.length > 0) {
			visibleLines.pop();
			content.pop();
		}
		if (content.join("\n").length + suffix.length + 1 <= maxChars) content.push(suffix);
	}
	const visibleCountByRun = new Map<string, number>();
	for (const line of visibleLines) visibleCountByRun.set(line.runId, (visibleCountByRun.get(line.runId) ?? 0) + 1);
	const acknowledge = new Set(selection.acknowledgeRunIds);
	const shownRunIds = [...selection.runChildCounts]
		.filter(([runId, count]) => acknowledge.has(runId) && visibleCountByRun.get(runId) === count)
		.map(([runId]) => runId);
	return { content: content.join("\n"), shownRunIds, omittedChildren };
}

export const PENDING_RESULTS_LIMITS = {
	historyEntries: MAX_HISTORY_ENTRIES,
	lines: MAX_PENDING_LINES,
	messageChars: MAX_MESSAGE_CHARS,
} as const;
