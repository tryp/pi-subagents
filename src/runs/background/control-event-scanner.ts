import * as fs from "node:fs";

export const CONTROL_EVENT_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_CONTROL_EVENT_LINE_BYTES = 1024 * 1024;
export const CONTROL_EVENT_SCAN_WINDOW_BYTES = 2 * 1024 * 1024;

export interface ControlEventScanInput {
	/** Open file descriptor positioned anywhere; the scanner uses positional reads. */
	fd: number;
	/** Size of the file as observed by the caller (stat size). */
	size: number;
	/** Byte offset to start scanning from. */
	cursor: number;
	/**
	 * True when `cursor` does not sit on a line boundary. The scanner then
	 * discards bytes up to the next newline instead of parsing them, and
	 * returns the same fact so the next poll resumes mid-line safely.
	 */
	midLine?: boolean;
	/** Invoked once per complete, within-budget line. */
	onLine: (line: string) => void;
	readChunkBytes?: number;
	maxLineBytes?: number;
	scanWindowBytes?: number;
}

export interface ControlEventScanResult {
	/** Offset the next scan should start from. */
	cursor: number;
	/** True when the returned cursor is not on a line boundary. */
	midLine: boolean;
	/** Lines discarded because they exceeded `maxLineBytes`. */
	oversizedLines: number;
}

const NEWLINE = 0x0a;

/**
 * Scan a JSONL control-event log forward from `cursor`, delivering complete
 * lines to `onLine`.
 *
 * Cursor contract: the returned cursor is either on a line boundary
 * (`midLine: false`) or explicitly marked as mid-line (`midLine: true`), so a
 * caller can persist it and resume without ever handing the tail of an
 * already-scanned line to `JSON.parse`. A trailing incomplete line is left
 * unconsumed so a writer that is mid-append gets re-read once complete.
 */
export function scanControlEventLines(input: ControlEventScanInput): ControlEventScanResult {
	const readChunkBytes = input.readChunkBytes ?? CONTROL_EVENT_READ_CHUNK_BYTES;
	const maxLineBytes = input.maxLineBytes ?? MAX_CONTROL_EVENT_LINE_BYTES;
	const scanWindowBytes = input.scanWindowBytes ?? CONTROL_EVENT_SCAN_WINDOW_BYTES;
	const { fd, size, onLine } = input;
	let cursor = input.cursor < 0 ? 0 : input.cursor;
	let midLine = input.midLine === true;
	if (size < cursor) {
		// The log was truncated or rotated: restart from the top and forget any
		// mid-line state, or the first genuine line would be discarded as a fragment.
		cursor = 0;
		midLine = false;
	}
	if (size <= cursor) return { cursor, midLine, oversizedLines: 0 };

	const scanEnd = Math.min(size, cursor + scanWindowBytes);
	// True while the scanner is discarding the remainder of a line whose start
	// is before `cursor` (oversized, or resumed mid-line from a previous poll).
	let discarding = midLine;
	let oversizedLines = 0;
	let readCursor = cursor;
	let lastCompleteCursor = cursor;
	let lineParts: Buffer[] = [];
	let lineBytes = 0;
	const appendLineSegment = (segment: Buffer) => {
		if (segment.length === 0 || discarding) return;
		if (lineBytes + segment.length > maxLineBytes) {
			lineParts = [];
			lineBytes = 0;
			discarding = true;
			oversizedLines++;
			return;
		}
		lineParts.push(segment);
		lineBytes += segment.length;
	};
	while (readCursor < scanEnd) {
		const toRead = Math.min(readChunkBytes, scanEnd - readCursor);
		const buffer = Buffer.alloc(toRead);
		const bytesRead = fs.readSync(fd, buffer, 0, toRead, readCursor);
		if (bytesRead <= 0) break;
		const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
		let lineStart = 0;
		for (let index = 0; index < chunk.length; index++) {
			if (chunk[index] !== NEWLINE) continue;
			appendLineSegment(chunk.subarray(lineStart, index));
			if (!discarding && lineBytes > 0) {
				onLine(Buffer.concat(lineParts, lineBytes).toString("utf-8"));
			}
			lineParts = [];
			lineBytes = 0;
			discarding = false;
			lastCompleteCursor = readCursor + index + 1;
			lineStart = index + 1;
		}
		appendLineSegment(chunk.subarray(lineStart));
		readCursor += bytesRead;
	}

	// Bytes actually read this pass. The caller's `size` is a stat() snapshot that a
	// concurrent truncation can invalidate, so the resume point never runs ahead of
	// what was really read.
	const scannedEnd = readCursor;

	if (discarding) {
		// An oversized or previously-started line is still in progress: hand the next
		// poll a mid-line cursor so the remainder is never re-counted or parsed. This
		// branch also owns mid-line-at-EOF, so no later branch needs to handle it.
		return { cursor: scannedEnd, midLine: true, oversizedLines };
	}
	if (lastCompleteCursor > cursor) return { cursor: lastCompleteCursor, midLine: false, oversizedLines };
	if (scanEnd >= size || scannedEnd < scanEnd) {
		// EOF without a complete line (or a stat() size that over-reported the file):
		// leave the cursor at the line start so the writer's whole line is re-read
		// once it finishes, instead of leaving it stranded mid-line.
		return { cursor, midLine: false, oversizedLines };
	}
	// Window exhausted mid-line: resume mid-line on the next poll.
	return { cursor: scanEnd, midLine: true, oversizedLines };
}
