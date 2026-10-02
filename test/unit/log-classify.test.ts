import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyLine, countLogLines, firstErrorLine } from "../../src/runs/shared/log-classify.ts";

void describe("classifyLine", () => {
	it("classifies strong error lines", () => {
		for (const line of [
			"Traceback (most recent call last):",
			"Traceback (innermost last):",
			"panic: runtime error: index out of range",
			"FATAL: database unavailable",
			"segmentation fault (core dumped)",
			"TypeError: value is not callable",
			"ReferenceError: name is not defined",
			"AssertionError: expected true",
			"ERROR: request failed",
			"Error: quoted tool output",
			"error: cannot open file",
			"[ERROR] request failed",
			"Uncaught exception in worker",
		]) assert.equal(classifyLine(line), "err", line);
	});

	it("classifies warnings and weak error-shaped lines as warn", () => {
		for (const line of ["WARN: retrying", "[WARNING] slow response", "deprecated API", "build failed", "error fetching package"]) {
			assert.equal(classifyLine(line), "warn", line);
		}
	});

	it("does not flag ordinary text, benign error mentions, or paths containing error", () => {
		for (const line of [
			"all tests passed",
			"0 errors found",
			"error handler tests passed",
			"Reading /tmp/error/output.log",
			"Loaded src/error-handler.ts",
			"debug: request started",
		]) assert.equal(classifyLine(line), null, line);
	});
});

void describe("countLogLines", () => {
	it("counts every line while tallying classified severities", () => {
		assert.deepEqual(countLogLines("ERROR: failed\nWARN: retry\nready\n"), { err: 1, warn: 1, total: 3 });
		assert.deepEqual(countLogLines(""), { err: 0, warn: 0, total: 0 });
		assert.deepEqual(countLogLines("one\r\ntwo\rthree"), { err: 0, warn: 0, total: 3 });
		assert.deepEqual(countLogLines("\n"), { err: 0, warn: 0, total: 1 });
	});
});

void describe("firstErrorLine", () => {
	it("returns the first strong error without line endings", () => {
		assert.equal(firstErrorLine("WARN: first\r\nTypeError: bad value\nFATAL: later"), "TypeError: bad value");
		assert.equal(firstErrorLine("WARN: only warning\nready"), undefined);
	});

	it("truncates to maxLen and returns undefined for non-positive limits", () => {
		assert.equal(firstErrorLine("ERROR: this is a long error", 10), "ERROR: thi");
		assert.equal(firstErrorLine("ERROR: bad", 0), undefined);
	});
});
