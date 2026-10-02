import { open, stat } from "node:fs/promises";
import { countLogLines, firstErrorLine, type LogCounts } from "../shared/log-classify.ts";

export interface RunProgress {
	turnCount?: number;
	toolCount?: number;
	tokens?: number;
}

export interface DeltaScan {
	turns: number | undefined;
	tools: number | undefined;
	tokens: number | undefined;
	logLines: number;
	logErr: number;
	logWarn: number;
	firstError: string | undefined;
	rotated: boolean;
	truncated: boolean;
}

export const MAX_SCAN_BYTES = 512 * 1024;

interface Snapshot {
	progress: RunProgress;
	logOffsetBytes: number;
	countsSoFar: LogCounts;
}

function progressDelta(current: number | undefined, previous: number | undefined): number | undefined {
	return current === undefined || previous === undefined ? undefined : current - previous;
}

function emptyCounts(): LogCounts {
	return { err: 0, warn: 0, total: 0 };
}

function addCounts(left: LogCounts, right: LogCounts): LogCounts {
	return { err: left.err + right.err, warn: left.warn + right.warn, total: left.total + right.total };
}

export class CheckpointDeltaStore {
	private readonly snapshots = new Map<string, Snapshot>();

	baseline(runId: string, progress: RunProgress, logOffsetBytes: number, countsSoFar: LogCounts): void {
		this.snapshots.set(runId, {
			progress: { ...progress },
			logOffsetBytes: Math.max(0, Math.floor(logOffsetBytes)),
			countsSoFar: { ...countsSoFar },
		});
	}

	async delta(runId: string, progress: RunProgress, outputFile: string | undefined): Promise<DeltaScan | undefined> {
		const previous = this.snapshots.get(runId);
		if (!previous) return undefined;

		let offset = previous.logOffsetBytes;
		let countsSoFar = previous.countsSoFar;
		let rotated = false;
		let truncated = false;
		let text = "";
		let nextOffset = offset;

		if (outputFile) {
			const fileInfo = await stat(outputFile);
			if (fileInfo.size < offset) {
				rotated = true;
				offset = 0;
				countsSoFar = emptyCounts();
			}
			const available = Math.max(0, fileInfo.size - offset);
			const scanLength = Math.min(available, MAX_SCAN_BYTES);
			truncated = available > MAX_SCAN_BYTES;
			if (scanLength > 0) {
				const handle = await open(outputFile, "r");
				try {
					const buffer = Buffer.allocUnsafe(scanLength);
					const { bytesRead } = await handle.read(buffer, 0, scanLength, offset);
					text = buffer.subarray(0, bytesRead).toString("utf8");
					nextOffset = offset + bytesRead;
				} finally {
					await handle.close();
				}
			} else {
				nextOffset = offset;
			}
		}

		const counts = countLogLines(text);
		const result: DeltaScan = {
			turns: progressDelta(progress.turnCount, previous.progress.turnCount),
			tools: progressDelta(progress.toolCount, previous.progress.toolCount),
			tokens: progressDelta(progress.tokens, previous.progress.tokens),
			logLines: counts.total,
			logErr: counts.err,
			logWarn: counts.warn,
			firstError: firstErrorLine(text),
			rotated,
			truncated,
		};

		this.snapshots.set(runId, {
			progress: { ...progress },
			logOffsetBytes: nextOffset,
			countsSoFar: addCounts(countsSoFar, counts),
		});
		return result;
	}

	forget(runId: string): void {
		this.snapshots.delete(runId);
	}
}
