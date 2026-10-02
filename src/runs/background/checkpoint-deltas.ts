import { open, stat } from "node:fs/promises";
import { countLogLines, firstErrorLine } from "../shared/log-classify.ts";

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
}

function progressDelta(current: number | undefined, previous: number | undefined): number | undefined {
	return current === undefined || previous === undefined ? undefined : current - previous;
}

export class CheckpointDeltaStore {
	private readonly snapshots = new Map<string, Snapshot>();
	private nextRunId: string | undefined;

	baseline(runId: string, progress: RunProgress, logOffsetBytes: number): void {
		if (this.snapshots.has(runId)) return;
		this.snapshots.set(runId, {
			progress: { ...progress },
			logOffsetBytes: Math.max(0, Math.floor(logOffsetBytes)),
		});
	}

	getNextRunId(): string | undefined {
		return this.nextRunId;
	}

	setNextRunId(runId: string | undefined): void {
		this.nextRunId = runId;
	}

	retain(runIds: ReadonlySet<string>): void {
		for (const runId of this.snapshots.keys()) {
			if (!runIds.has(runId)) this.forget(runId);
		}
	}

	async delta(runId: string, progress: RunProgress, outputFile: string | undefined): Promise<DeltaScan | undefined> {
		const previous = this.snapshots.get(runId);
		if (!previous) return undefined;

		let offset = previous.logOffsetBytes;
		let rotated = false;
		let truncated = false;
		let text = "";
		let nextOffset = offset;

		if (outputFile) {
			const fileInfo = await stat(outputFile);
			if (fileInfo.size < offset) {
				rotated = true;
				offset = 0;
			}
			const available = Math.max(0, fileInfo.size - offset);
			const scanLength = Math.min(available, MAX_SCAN_BYTES);
			truncated = available > MAX_SCAN_BYTES;
			if (scanLength > 0) {
				const handle = await open(outputFile, "r");
				try {
					const buffer = Buffer.allocUnsafe(scanLength);
					const { bytesRead } = await handle.read(buffer, 0, scanLength, offset);
					const scanned = buffer.subarray(0, bytesRead);
					const lastNewline = scanned.lastIndexOf(0x0a);
					// Leave an incomplete trailing line for the next scan so it is counted/classified whole.
					// A newline-free oversized line must still advance to avoid rescanning it forever.
					const consumedBytes = lastNewline >= 0 ? lastNewline + 1 : bytesRead >= MAX_SCAN_BYTES ? bytesRead : 0;
					text = scanned.subarray(0, consumedBytes).toString("utf8");
					nextOffset = offset + consumedBytes;
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
		});
		return result;
	}

	forget(runId: string): void {
		this.snapshots.delete(runId);
		if (this.nextRunId === runId) this.nextRunId = undefined;
	}
}
