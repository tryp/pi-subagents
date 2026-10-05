import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { scanControlEventLines } from "../../src/runs/background/control-event-scanner.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

const SMALL_MAX_LINE = 4096;
const SMALL_CHUNK = 512;
const SMALL_WINDOW = 2048;

function controlLine(runId: string, message: string): string {
	return JSON.stringify({
		type: "subagent.control",
		channels: ["event"],
		event: { type: "needs_attention", to: "needs_attention", ts: 1, runId, agent: "worker", message },
	});
}

function bulkyLine(text: string): string {
	return JSON.stringify({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text }] }] });
}

function withScanFile<T>(contents: string, run: (fd: number, size: number) => T): T {
	const dir = createTempDir("pi-control-event-scanner-");
	const file = path.join(dir, "events.jsonl");
	try {
		fs.writeFileSync(file, contents, "utf-8");
		const fd = fs.openSync(file, "r");
		try {
			return run(fd, fs.fstatSync(fd).size);
		} finally {
			fs.closeSync(fd);
		}
	} finally {
		removeTempDir(dir);
	}
}

/** Poll until the cursor stops advancing, collecting delivered lines. */
function drain(fd: number, size: number, start = 0, startMidLine = false, options: { maxLineBytes?: number; readChunkBytes?: number; scanWindowBytes?: number } = {}) {
	const delivered: string[] = [];
	let cursor = start;
	let midLine = startMidLine;
	let oversizedLines = 0;
	let polls = 0;
	for (;;) {
		const scan = scanControlEventLines({
			fd,
			size,
			cursor,
			midLine,
			onLine: (line) => delivered.push(line),
			...options,
		});
		oversizedLines += scan.oversizedLines;
		const advanced = scan.cursor !== cursor;
		cursor = scan.cursor;
		midLine = scan.midLine;
		polls++;
		assert.ok(polls < 10_000, "drain should terminate");
		if (!advanced) break;
	}
	return { delivered, cursor, midLine, oversizedLines, polls };
}

describe("scanControlEventLines", () => {
	it("delivers complete lines and stops on a line boundary", () => {
		const contents = [controlLine("run-1", "one"), controlLine("run-1", "two"), controlLine("run-1", "three"), ""].join("\n");
		withScanFile(contents, (fd, size) => {
			const scan = scanControlEventLines({ fd, size, cursor: 0, onLine: () => {} });
			assert.equal(scan.midLine, false);
			assert.equal(scan.cursor, size);
			assert.equal(scan.oversizedLines, 0);
		});
	});

	it("skips an oversized line but keeps the cursor on a line boundary", () => {
		const contents = [
			controlLine("run-oversized", "before"),
			bulkyLine("x".repeat(SMALL_MAX_LINE * 3)),
			controlLine("run-oversized", "after"),
			"",
		].join("\n");
		withScanFile(contents, (fd, size) => {
			// Window larger than the line budget so the byte cap is what discards the line.
			const result = drain(fd, size, 0, false, { maxLineBytes: SMALL_MAX_LINE, readChunkBytes: SMALL_CHUNK, scanWindowBytes: SMALL_MAX_LINE * 4 });
			assert.deepEqual(result.delivered, [controlLine("run-oversized", "before"), controlLine("run-oversized", "after")]);
			assert.equal(result.oversizedLines, 1);
			assert.equal(result.midLine, false);
			assert.equal(result.cursor, size);
		});
	});

	it("never hands the tail of an oversized line to the parser across polls", () => {
		// Regression: the tracker used to persist a mid-line cursor while skipping an
		// oversized line, so the next poll parsed the remainder as a fresh line and
		// logged "Ignoring malformed async control event ... Unexpected
		// non-whitespace character after JSON at position 1".
		const contents = [
			controlLine("run-tail", "before"),
			bulkyLine("y".repeat(SMALL_MAX_LINE * 4)),
			controlLine("run-tail", "after"),
			"",
		].join("\n");
		withScanFile(contents, (fd, size) => {
			const result = drain(fd, size, 0, false, { maxLineBytes: SMALL_MAX_LINE, readChunkBytes: SMALL_CHUNK, scanWindowBytes: SMALL_WINDOW });
			assert.equal(result.delivered.length, 2);
			for (const line of result.delivered) {
				const parsed = JSON.parse(line) as { event: { message: string } };
				assert.equal(parsed.event.message.startsWith("before") || parsed.event.message.startsWith("after"), true);
			}
			assert.equal(result.midLine, false);
			assert.equal(result.cursor, size);
		});
	});

	it("delivers control events after an oversized line exactly once", () => {
		const contents = [
			bulkyLine("z".repeat(SMALL_MAX_LINE * 6)),
			controlLine("run-once", "first"),
			bulkyLine("z".repeat(SMALL_MAX_LINE * 6)),
			controlLine("run-once", "second"),
			bulkyLine("z".repeat(SMALL_MAX_LINE * 6)),
			controlLine("run-once", "third"),
			"",
		].join("\n");
		withScanFile(contents, (fd, size) => {
			const result = drain(fd, size, 0, false, { maxLineBytes: SMALL_MAX_LINE, readChunkBytes: SMALL_CHUNK, scanWindowBytes: SMALL_MAX_LINE * 4 });
			const messages = result.delivered.map((line) => (JSON.parse(line) as { event: { message: string } }).event.message);
			assert.deepEqual(messages, ["first", "second", "third"]);
			assert.equal(result.oversizedLines, 3);
			assert.equal(result.polls > 1, true, "the small scan window should force several polls");
		});
	});

	it("marks the cursor mid-line when the scan window ends mid-line", () => {
		const contents = [bulkyLine("w".repeat(SMALL_MAX_LINE * 4)), controlLine("run-window", "after"), ""].join("\n");
		withScanFile(contents, (fd, size) => {
			const first = scanControlEventLines({
				fd,
				size,
				cursor: 0,
				onLine: () => {},
				maxLineBytes: SMALL_MAX_LINE,
				readChunkBytes: SMALL_CHUNK,
				scanWindowBytes: SMALL_WINDOW,
			});
			assert.equal(first.midLine, true, "window exhausted mid-line");
			assert.equal(first.cursor, SMALL_WINDOW);
			assert.equal(first.cursor % 1, 0);
			// Resuming from that mid-line cursor must skip the fragment, not parse it.
			const delivered: string[] = [];
			let cursor = first.cursor;
			let midLine: boolean = first.midLine;
			for (let poll = 0; poll < 200 && cursor < size; poll++) {
				const scan = scanControlEventLines({
					fd,
					size,
					cursor,
					midLine,
					onLine: (line) => delivered.push(line),
					maxLineBytes: SMALL_MAX_LINE,
					readChunkBytes: SMALL_CHUNK,
					scanWindowBytes: SMALL_WINDOW,
				});
				if (scan.cursor === cursor && !scan.midLine) break;
				cursor = scan.cursor;
				midLine = scan.midLine;
			}
			assert.deepEqual(delivered, [controlLine("run-window", "after")]);
			assert.equal(midLine, false);
			assert.equal(cursor, size);
		});
	});

	it("discards the remainder when resuming from an explicit mid-line cursor", () => {
		const contents = [bulkyLine("v".repeat(500)), controlLine("run-resume", "after"), ""].join("\n");
		withScanFile(contents, (fd, size) => {
			const delivered: string[] = [];
			const scan = scanControlEventLines({
				fd,
				size,
				cursor: 120,
				midLine: true,
				onLine: (line) => delivered.push(line),
				maxLineBytes: SMALL_MAX_LINE,
				readChunkBytes: SMALL_CHUNK,
			});
			assert.deepEqual(delivered, [controlLine("run-resume", "after")]);
			assert.equal(scan.midLine, false);
			assert.equal(scan.cursor, size);
		});
	});

	it("leaves a trailing partial line unconsumed until the writer finishes it", () => {
		const complete = controlLine("run-partial", "complete");
		const partial = controlLine("run-partial", "incomplete");
		const dir = createTempDir("pi-control-event-scanner-");
		const file = path.join(dir, "events.jsonl");
		try {
			fs.writeFileSync(file, complete, "utf-8");
			let fd = fs.openSync(file, "r");
			try {
				let size = fs.fstatSync(fd).size;
				const first = drain(fd, size, 0, false, { readChunkBytes: SMALL_CHUNK });
				assert.deepEqual(first.delivered, []);
				assert.equal(first.cursor, 0, "an unterminated line must not be consumed");
				assert.equal(first.midLine, false);
				fs.closeSync(fd);

				fs.appendFileSync(file, `\n${partial.slice(0, 20)}`, "utf-8");
				fd = fs.openSync(file, "r");
				size = fs.fstatSync(fd).size;
				const second = drain(fd, size, 0, false, { readChunkBytes: SMALL_CHUNK });
				assert.deepEqual(second.delivered, [complete]);
				assert.equal(second.cursor, complete.length + 1);
				fs.closeSync(fd);

				fs.appendFileSync(file, `${partial.slice(20)}\n`, "utf-8");
				fd = fs.openSync(file, "r");
				size = fs.fstatSync(fd).size;
				const third = drain(fd, size, second.cursor, second.midLine, { readChunkBytes: SMALL_CHUNK });
				assert.deepEqual(third.delivered, [partial]);
				assert.equal(third.cursor, size);
			} finally {
				try { fs.closeSync(fd); } catch {}
			}
		} finally {
			removeTempDir(dir);
		}
	});

	it("bounds read allocations to the configured chunk size", () => {
		const contents = [bulkyLine("q".repeat(SMALL_MAX_LINE * 3)), controlLine("run-bounded", "after"), ""].join("\n");
		withScanFile(contents, (fd, size) => {
			const originalAlloc = Buffer.alloc;
			const sizes: number[] = [];
			Buffer.alloc = ((allocSize: number, fill?: string | Buffer | number, encoding?: BufferEncoding) => {
				sizes.push(allocSize);
				return originalAlloc(allocSize, fill as never, encoding);
			}) as typeof Buffer.alloc;
			try {
				drain(fd, size, 0, false, { maxLineBytes: SMALL_MAX_LINE, readChunkBytes: SMALL_CHUNK, scanWindowBytes: SMALL_MAX_LINE * 4 });
			} finally {
				Buffer.alloc = originalAlloc;
			}
			assert.ok(sizes.length > 0);
			assert.equal(Math.max(...sizes) <= SMALL_CHUNK, true);
		});
	});

	it("drops lines larger than the default 1 MiB budget without emitting fragments", () => {
		// Mirrors a real `agent_end` event carrying a multi-megabyte message list:
		// the 2 MiB scan window ends inside the 1.1 MB line's oversize discard.
		const contents = [bulkyLine("m".repeat(1_100_000)), controlLine("run-default", "after"), ""].join("\n");
		withScanFile(contents, (fd, size) => {
			const result = drain(fd, size, 0, false, { readChunkBytes: 64 * 1024, scanWindowBytes: 2 * 1024 * 1024 });
			assert.deepEqual(result.delivered, [controlLine("run-default", "after")]);
			assert.equal(result.oversizedLines, 1);
			assert.equal(result.cursor, size);
			assert.equal(result.midLine, false);
		});
	});

	it("treats a shrunk file as a full rescan from zero", () => {
		const contents = [controlLine("run-shrunk", "one"), ""].join("\n");
		withScanFile(contents, (fd, size) => {
			const delivered: string[] = [];
			const scan = scanControlEventLines({ fd, size, cursor: size + 5000, onLine: (line) => delivered.push(line) });
			assert.deepEqual(delivered, [controlLine("run-shrunk", "one")]);
			assert.equal(scan.cursor, size);
			assert.equal(scan.midLine, false);
		});
	});
});
