import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { summarizeAsyncStatus } from "../../src/runs/background/async-status.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

function asyncDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-compaction-"));
}

function failedStatus(): AsyncStatus {
	return {
		runId: "run-1",
		mode: "single",
		state: "failed",
		error: "Step failed: worker",
		startedAt: 1_000,
		endedAt: 5_000,
		steps: [
			{
				agent: "worker",
				status: "failed",
				exitCode: 1,
				error: "This operation was aborted",
				sessionFile: "/tmp/session.jsonl",
				failureKind: "compacted_then_aborted",
				retryable: true,
				compaction: { occurred: true, completed: true, tokensBefore: 200_350, tailEntriesAfter: 1 },
			},
		],
	};
}

describe("async status compaction diagnosis", () => {
	it("carries the step failure kind, retryability and compaction evidence", () => {
		const status = failedStatus();
		status.failureKind = "compacted_then_aborted";
		status.retryable = true;
		const summary = summarizeAsyncStatus(asyncDir(), status, 6_000);

		assert.equal(summary.state, "failed");
		assert.equal(summary.failureKind, "compacted_then_aborted");
		assert.equal(summary.retryable, true);
		assert.equal(summary.steps[0].failureKind, "compacted_then_aborted");
		assert.equal(summary.steps[0].retryable, true);
		assert.deepEqual(summary.steps[0].compaction, {
			occurred: true,
			completed: true,
			tokensBefore: 200_350,
			tailEntriesAfter: 1,
		});
	});

	it("leaves ordinary failures without a failure kind", () => {
		const status: AsyncStatus = {
			...failedStatus(),
			steps: [{ agent: "worker", status: "failed", exitCode: 1, error: "bash failed (exit 1)" }],
		};
		const summary = summarizeAsyncStatus(asyncDir(), status, 6_000);
		assert.equal(summary.failureKind, undefined);
		assert.equal(summary.steps[0].failureKind, undefined);
		assert.equal(summary.steps[0].compaction, undefined);
	});
});
