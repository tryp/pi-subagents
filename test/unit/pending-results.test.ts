import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	findCompletionNoticeRunIds,
	formatPendingResultsMessage,
	selectPendingResults,
	type PendingResultRun,
} from "../../src/runs/background/pending-results.ts";

const fakeRuns: PendingResultRun[] = [
	{
		id: "run-finished",
		asyncDir: "/runs/run-finished",
		outputFile: "/runs/run-finished/output.log",
		state: "complete",
		steps: [
			{ agent: "alpha", status: "complete" },
			{ agent: "beta", status: "failed" },
		],
	},
	{ id: "run-live", asyncDir: "/runs/run-live", state: "running", steps: [{ agent: "gamma", status: "running" }] },
	{ id: "run-seen", asyncDir: "/runs/run-seen", state: "failed", steps: [{ agent: "delta", status: "failed" }] },
];

describe("pending result selection", () => {
	it("selects terminal unacknowledged children and recognizes notices found in session history", () => {
		const history = findCompletionNoticeRunIds([
			{ type: "message", message: { role: "custom", customType: "subagent-notify", details: { version: 1, completions: [{ runId: "run-finished" }] } } },
		]);
		const selection = selectPendingResults(fakeRuns, new Set(["run-seen"]), history.runIds);
		assert.deepEqual(selection.lines.map(({ runId, agent, state, recoveredFromHistory }) => ({ runId, agent, state, recoveredFromHistory })), [
			{ runId: "run-finished", agent: "alpha", state: "complete", recoveredFromHistory: true },
			{ runId: "run-finished", agent: "beta", state: "failed", recoveredFromHistory: true },
		]);
		assert.deepEqual(selection.acknowledgeRunIds, ["run-finished"]);
		assert.equal(selection.totalChildren, 2);
		const message = formatPendingResultsMessage(selection);
		assert.match(message?.content ?? "", /result: \/runs\/run-finished\/output.log/);
		assert.deepEqual(message?.shownRunIds, ["run-finished"]);
	});

	it("does not acknowledge a batch unless every child fit in the surfaced message", () => {
		const selection = selectPendingResults(fakeRuns.slice(0, 1), new Set(), new Set(), 1);
		assert.deepEqual(selection.acknowledgeRunIds, []);
		const message = formatPendingResultsMessage(selection);
		assert.deepEqual(message?.shownRunIds, []);
	});

	it("does not surface acknowledged, active, or empty selections", () => {
		const selection = selectPendingResults(fakeRuns, new Set(["run-finished", "run-seen"]), new Set());
		assert.deepEqual(selection.lines, []);
		assert.equal(formatPendingResultsMessage(selection), undefined);
	});

	it("repairs history from legacy and current completion notice envelopes", () => {
		const history = findCompletionNoticeRunIds([
			{ message: { customType: "subagent-notify", details: [{ runId: "legacy-run" }] } },
			{ message: { customType: "subagent-notify", details: { completions: [{ runId: "new-run" }, { runId: "new-run-2" }] } } },
			{ message: { customType: "unrelated", details: {} } },
		]);
		assert.deepEqual([...history.runIds].sort(), ["legacy-run", "new-run", "new-run-2"]);
	});

	it("bounds visible output while reporting omitted children", () => {
		const runs: PendingResultRun[] = Array.from({ length: 30 }, (_, index) => ({
			id: `run-${index}`,
			asyncDir: `/runs/${index}`,
			state: "failed",
			steps: [{ agent: `agent-${index}`, status: "failed" }],
		}));
		const selection = selectPendingResults(runs, new Set(), new Set());
		const message = formatPendingResultsMessage(selection, 500);
		assert.ok(message);
		assert.ok(message.content.length <= 500);
		assert.match(message.content, /^Pending results: 30/);
		assert.ok(message.omittedChildren > 0);
		assert.ok(message.shownRunIds.length < 30);
	});
});
