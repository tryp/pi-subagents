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

function messagesOf(lines: string[]): string[] {
	return lines.map((line) => (JSON.parse(line) as { event: { message: string } }).event.message);
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
			const delivered: string[] = [];
			const scan = scanControlEventLines({ fd, size, cursor: 0, onLine: (line) => delivered.push(line) });
			assert.deepEqual(delivered, [controlLine("run-1", "one"), controlLine("run-1", "two"), controlLine("run-1", "three")]);
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
			assert.deepEqual(messagesOf(result.delivered), ["before", "after"], "no fragment and no duplicate delivery");
			for (const line of result.delivered) JSON.parse(line);
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
			assert.deepEqual(messagesOf(result.delivered), ["first", "second", "third"]);
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

	it("forgets mid-line state when the log shrinks", () => {
		// A truncated/rotated log must restart from a real boundary; carrying the
		// stale mid-line flag would discard the first fresh line.
		const dir = createTempDir("pi-control-event-scanner-");
		const file = path.join(dir, "events.jsonl");
		try {
			fs.writeFileSync(file, `${bulkyLine("t".repeat(SMALL_MAX_LINE * 4))}\n${controlLine("run-shrink", "old")}\n`, "utf-8");
			let fd = fs.openSync(file, "r");
			let size = fs.fstatSync(fd).size;
			const options = { maxLineBytes: SMALL_MAX_LINE, readChunkBytes: SMALL_CHUNK, scanWindowBytes: SMALL_WINDOW };
			const first = scanControlEventLines({ fd, size, cursor: 0, onLine: () => {}, ...options });
			assert.equal(first.midLine, true, "window should stop inside the oversized line");
			assert.equal(first.cursor, SMALL_WINDOW);
			fs.closeSync(fd);

			const fresh = [controlLine("run-shrink", "first"), controlLine("run-shrink", "second"), ""].join("\n");
			fs.writeFileSync(file, fresh, "utf-8");
			fd = fs.openSync(file, "r");
			size = fs.fstatSync(fd).size;
			assert.ok(first.cursor > size, "fixture should have shrunk past the stored cursor");
			const delivered: string[] = [];
			const scan = scanControlEventLines({ fd, size, cursor: first.cursor, midLine: first.midLine, onLine: (line) => delivered.push(line), ...options });
			assert.deepEqual(messagesOf(delivered), ["first", "second"]);
			assert.equal(scan.cursor, size);
			assert.equal(scan.midLine, false);
			fs.closeSync(fd);
		} finally {
			removeTempDir(dir);
		}
	});

	it("delivers a line of exactly maxLineBytes and drops one byte more", () => {
		const exact = `{"type":"message_update","pad":"y"}`;
		const atCap = exact.padEnd(SMALL_MAX_LINE, "z");
		const overCap = atCap + "z";
		// Same boundary for multibyte content, where the budget counts bytes.
		const multibyte = Buffer.from("é".repeat(SMALL_MAX_LINE / 2), "utf-8").toString("utf-8");
		withScanFile([atCap, overCap, multibyte, controlLine("run-cap", "after"), ""].join("\n"), (fd, size) => {
			const delivered: string[] = [];
			const scan = scanControlEventLines({
				fd,
				size,
				cursor: 0,
				onLine: (line) => delivered.push(line),
				maxLineBytes: SMALL_MAX_LINE,
				readChunkBytes: SMALL_CHUNK,
				scanWindowBytes: SMALL_MAX_LINE * 8,
			});
			assert.equal(atCap.length, SMALL_MAX_LINE, "fixture should sit exactly on the cap");
			assert.equal(Buffer.byteLength(multibyte, "utf-8"), SMALL_MAX_LINE, "multibyte fixture should sit exactly on the cap");
			assert.deepEqual(delivered, [atCap, multibyte, controlLine("run-cap", "after")]);
			assert.equal(scan.oversizedLines, 1);
			assert.equal(scan.cursor, size);
		});
	});

	it("does not resume past bytes it could not read when the log shrank mid-scan", () => {
		const contents = `${controlLine("run-race", "one")}\n${controlLine("run-race", "two")}\n`;
		const oversized = `{"pad":"${"s".repeat(SMALL_MAX_LINE * 2)}"}`;
		withScanFile(`${contents}${oversized}`, (fd) => {
			const realSize = fs.fstatSync(fd).size;
			const options = { maxLineBytes: SMALL_MAX_LINE, readChunkBytes: SMALL_CHUNK, scanWindowBytes: SMALL_MAX_LINE * 8 };
			const delivered: string[] = [];
			// Caller passes a stale, larger stat() size: the real file is shorter.
			const scan = scanControlEventLines({ fd, size: realSize + 5000, cursor: 0, onLine: (line) => delivered.push(line), ...options });
			assert.equal(scan.cursor, realSize, "resume point must not exceed what was actually read");
			assert.equal(scan.midLine, true, "still discarding the unterminated oversized tail");
			assert.deepEqual(messagesOf(delivered), ["one", "two"], "both readable lines are still delivered");
		});
		withScanFile(contents, (fd, size) => {
			const delivered: string[] = [];
			const scan = scanControlEventLines({ fd, size: size + 5000, cursor: 0, onLine: (line) => delivered.push(line), readChunkBytes: SMALL_CHUNK, scanWindowBytes: SMALL_WINDOW });
			assert.equal(scan.cursor, size, "resume point must not exceed what was actually read");
			assert.equal(scan.midLine, false);
			assert.equal(delivered.length, 2, "both readable lines are still delivered");
		});
	});

	it("carries an unterminated oversized discard across polls until the writer finishes it", () => {
		const dir = createTempDir("pi-control-event-scanner-");
		const file = path.join(dir, "events.jsonl");
		try {
			const bulky = `{"type":"message_update","pad":"${"o".repeat(SMALL_MAX_LINE * 2)}"}`;
			fs.writeFileSync(file, bulky, "utf-8"); // oversized, no trailing newline yet
			let fd = fs.openSync(file, "r");
			let size = fs.fstatSync(fd).size;
			const options = { maxLineBytes: SMALL_MAX_LINE, readChunkBytes: SMALL_CHUNK, scanWindowBytes: SMALL_MAX_LINE * 4 };
			const first = scanControlEventLines({ fd, size, cursor: 0, onLine: () => {}, ...options });
			assert.equal(first.midLine, true, "oversize discard in progress at EOF");
			assert.equal(first.cursor, size);
			assert.equal(first.oversizedLines, 1, "the line must be counted once when the cap trips");
			const second = scanControlEventLines({ fd, size, cursor: first.cursor, midLine: first.midLine, onLine: () => {}, ...options });
			assert.equal(second.midLine, true, "discard must still be in progress at EOF");
			assert.equal(second.cursor, size);
			assert.equal(second.oversizedLines, 0, "the same line must not be counted twice");
			fs.closeSync(fd);

			fs.appendFileSync(file, `\n${controlLine("run-carry", "after")}\n`, "utf-8");
			fd = fs.openSync(file, "r");
			size = fs.fstatSync(fd).size;
			const delivered: string[] = [];
			const third = scanControlEventLines({ fd, size, cursor: second.cursor, midLine: second.midLine, onLine: (line) => delivered.push(line), ...options });
			assert.equal(third.midLine, false);
			assert.equal(third.cursor, size);
			assert.equal(third.oversizedLines, 0);
			assert.deepEqual(messagesOf(delivered), ["after"]);
			fs.closeSync(fd);
		} finally {
			removeTempDir(dir);
		}
	});

	it("keeps resuming mid-line across an EOF while a writer is mid-append", () => {
		const dir = createTempDir("pi-control-event-scanner-");
		const file = path.join(dir, "events.jsonl");
		try {
			const control = controlLine("run-eof-append", "done");
			fs.writeFileSync(file, control.slice(0, control.length - 5), "utf-8");
			let fd = fs.openSync(file, "r");
			let size = fs.fstatSync(fd).size;
			const first = scanControlEventLines({ fd, size, cursor: Math.floor(size / 2), midLine: true, onLine: () => {}, readChunkBytes: SMALL_CHUNK });
			assert.equal(first.cursor, size, "mid-line resume should advance to EOF");
			assert.equal(first.midLine, true, "EOF mid-line must stay marked mid-line");
			fs.closeSync(fd);

			fs.appendFileSync(file, `${control.slice(control.length - 5)}\n${controlLine("run-eof-append", "next")}\n`, "utf-8");
			fd = fs.openSync(file, "r");
			size = fs.fstatSync(fd).size;
			const delivered: string[] = [];
			const second = scanControlEventLines({ fd, size, cursor: first.cursor, midLine: first.midLine, onLine: (line) => delivered.push(line), readChunkBytes: SMALL_CHUNK });
			assert.deepEqual(delivered, [controlLine("run-eof-append", "next")]);
			assert.equal(second.cursor, size);
			assert.equal(second.midLine, false);
			fs.closeSync(fd);
		} finally {
			removeTempDir(dir);
		}
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
