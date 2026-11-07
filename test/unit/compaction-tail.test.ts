import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	classifyCompactedThenAborted,
	diagnoseCompactionTail,
	isAbortFailure,
	readSessionTailEntries,
} from "../../src/runs/shared/compaction-tail.ts";

function fixture(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-compaction-tail-"));
}

function writeSession(dir: string, entries: Array<Record<string, unknown>>): string {
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
	return file;
}

function messageEntry(index: number, padding = ""): Record<string, unknown> {
	return {
		type: "message",
		id: `m${index}`,
		timestamp: "2026-11-07T00:00:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text: `turn ${index} ${padding}` }] },
	};
}

function compactionEntry(tokensBefore = 200350): Record<string, unknown> {
	return {
		type: "compaction",
		id: "c1",
		timestamp: "2026-11-07T02:43:08.634Z",
		summary: "[Session Goal] compacted",
		firstKeptEntryId: "m3",
		tokensBefore,
		details: { reason: "manual" },
	};
}

describe("isAbortFailure", () => {
	it("matches the abort message a headless child reports", () => {
		assert.equal(isAbortFailure("This operation was aborted"), true);
		assert.equal(isAbortFailure("AbortError: stream closed"), true);
	});

	it("does not match deliberate ends or unrelated failures", () => {
		assert.equal(isAbortFailure("Subagent stopped by user."), false);
		assert.equal(isAbortFailure("Subagent timed out after 60000ms."), false);
		assert.equal(isAbortFailure("bash failed (exit 1): connection refused"), false);
		assert.equal(isAbortFailure(undefined), false);
	});
});

describe("readSessionTailEntries", () => {
	it("reads the tail of a file larger than one read block", () => {
		const dir = fixture();
		// ~600 KB of entries so the reader has to walk several blocks backwards.
		const entries: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 40; i += 1) entries.push(messageEntry(i, "x".repeat(15_000)));
		entries.push(compactionEntry());
		entries.push({ type: "custom_message", customType: "pi-vcc-auto-continue", content: [] });
		const file = writeSession(dir, entries);

		const tail = readSessionTailEntries(file, 3);
		// The reader returns whole trailing entries from the blocks it read, so it may
		// hand back more than the requested minimum; the tail order is what matters.
		assert.deepEqual(
			tail.slice(-3).map((entry) => entry.type),
			["message", "compaction", "custom_message"],
		);
		assert.equal(tail.every((entry) => typeof entry.type === "string"), true);
	});

	it("skips malformed lines instead of throwing", () => {
		const dir = fixture();
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, `${JSON.stringify(messageEntry(1))}\n{not json}\n${JSON.stringify(compactionEntry())}\n`, "utf-8");
		const tail = readSessionTailEntries(file, 4);
		assert.deepEqual(
			tail.map((entry) => entry.type),
			["message", "compaction"],
		);
	});

	it("returns an empty list for a missing file", () => {
		assert.deepEqual(readSessionTailEntries(path.join(fixture(), "absent.jsonl")), []);
	});
});

describe("diagnoseCompactionTail", () => {
	it("reports a completed compaction and counts the entries after it", () => {
		const dir = fixture();
		const file = writeSession(dir, [
			messageEntry(1),
			messageEntry(2),
			compactionEntry(200_350),
			{ type: "custom", customType: "pi-vcc-compaction-limits", data: {} },
			{ type: "custom_message", customType: "pi-vcc-auto-continue", content: [] },
		]);

		assert.deepEqual(diagnoseCompactionTail(file), {
			occurred: true,
			completed: true,
			tokensBefore: 200_350,
			tailEntriesAfter: 2,
		});
	});

	it("reports no compaction for a plain transcript", () => {
		const dir = fixture();
		const file = writeSession(dir, [messageEntry(1), messageEntry(2)]);
		assert.deepEqual(diagnoseCompactionTail(file), { occurred: false, completed: false, tailEntriesAfter: 0 });
	});

	it("treats a compaction entry without a summary or kept id as incomplete", () => {
		const dir = fixture();
		const file = writeSession(dir, [{ type: "compaction", id: "c1", tokensBefore: 120 }, messageEntry(1)]);
		const diagnosis = diagnoseCompactionTail(file);
		assert.equal(diagnosis.occurred, true);
		assert.equal(diagnosis.completed, false);
	});

	it("tolerates a missing session file", () => {
		assert.deepEqual(diagnoseCompactionTail(undefined), { occurred: false, completed: false, tailEntriesAfter: 0 });
		assert.deepEqual(diagnoseCompactionTail(path.join(fixture(), "absent.jsonl")), {
			occurred: false,
			completed: false,
			tailEntriesAfter: 0,
		});
	});
});

describe("classifyCompactedThenAborted", () => {
	function compactedSession(trailingEntries: number): string {
		const dir = fixture();
		const entries: Array<Record<string, unknown>> = [messageEntry(1), messageEntry(2), compactionEntry()];
		for (let i = 0; i < trailingEntries; i += 1) entries.push(messageEntry(10 + i));
		return writeSession(dir, entries);
	}

	it("classifies an abort right after a completed compaction as retryable", () => {
		const diagnosis = classifyCompactedThenAborted({
			sessionFile: compactedSession(1),
			error: "This operation was aborted",
			exitCode: 1,
		});
		assert.equal(diagnosis.failureKind, "compacted_then_aborted");
		assert.equal(diagnosis.retryable, true);
		assert.equal(diagnosis.compaction?.occurred, true);
		assert.equal(diagnosis.compaction?.tokensBefore, 200_350);
		assert.equal(diagnosis.compaction?.tailEntriesAfter, 1);
	});

	it("classifies a second abort after the one recovery as non-retryable", () => {
		const diagnosis = classifyCompactedThenAborted({
			sessionFile: compactedSession(1),
			error: "This operation was aborted\nCompaction-induced child abort could not be resumed safely: resume already attempted.",
			exitCode: 1,
			recoveryAttempted: true,
		});
		assert.equal(diagnosis.failureKind, "compacted_abort_after_resume");
		assert.equal(diagnosis.retryable, false);
	});

	it("keeps a refused recovery as diagnosed retryable compacted_then_aborted", () => {
		const diagnosis = classifyCompactedThenAborted({
			sessionFile: compactedSession(1),
			error: "This operation was aborted\\nCompaction-induced child abort could not be resumed safely: no useful prior progress.",
			exitCode: 1,
			recoveryAttempted: false,
		});
		assert.equal(diagnosis.failureKind, "compacted_then_aborted");
		assert.equal(diagnosis.retryable, true);
	});

	it("does not classify an abort whose compaction is far from the end", () => {
		const diagnosis = classifyCompactedThenAborted({
			sessionFile: compactedSession(10),
			error: "This operation was aborted",
			exitCode: 1,
		});
		assert.equal(diagnosis.failureKind, undefined);
		assert.equal(diagnosis.retryable, undefined);
		// The evidence is still reported so an investigation sees what happened.
		assert.equal(diagnosis.compaction?.occurred, true);
		assert.equal(diagnosis.compaction?.tailEntriesAfter, 10);
	});

	it("does not classify an abort with no compaction in the transcript", () => {
		const dir = fixture();
		const file = writeSession(dir, [messageEntry(1), messageEntry(2)]);
		const diagnosis = classifyCompactedThenAborted({ sessionFile: file, error: "This operation was aborted", exitCode: 1 });
		assert.equal(diagnosis.failureKind, undefined);
		assert.deepEqual(diagnosis.compaction, { occurred: false, completed: false, tailEntriesAfter: 0 });
	});

	it("ignores stopped, timed-out, interrupted and successful children", () => {
		const sessionFile = compactedSession(0);
		const aborted = { error: "This operation was aborted", exitCode: 1 };
		assert.deepEqual(classifyCompactedThenAborted({ ...aborted, sessionFile, stopped: true }), {});
		assert.deepEqual(classifyCompactedThenAborted({ ...aborted, sessionFile, timedOut: true }), {});
		assert.deepEqual(classifyCompactedThenAborted({ ...aborted, sessionFile, interrupted: true }), {});
		assert.deepEqual(classifyCompactedThenAborted({ ...aborted, sessionFile, exitCode: 0 }), {});	});

	it("ignores failures whose message is not an abort and never reads the file", () => {
		// A path that cannot be parsed as a session proves the file is not consulted.
		const diagnosis = classifyCompactedThenAborted({
			sessionFile: "/dev/null",
			error: "bash failed (exit 1): connection refused",
			exitCode: 1,
		});
		assert.deepEqual(diagnosis, {});
	});
});
