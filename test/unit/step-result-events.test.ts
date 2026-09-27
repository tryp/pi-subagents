import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	createStepResultEventBridge,
	type StepResultEventSource,
} from "../../src/runs/background/step-result-events.ts";
import { SUBAGENT_STEP_RESULT_EVENT } from "../../src/shared/types.ts";

const RUN: StepResultEventSource = { asyncId: "run-a", asyncDir: "", status: "running" };

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-step-events-"));
	const asyncDir = path.join(root, "run-a");
	fs.mkdirSync(asyncDir, { recursive: true });
	const eventsFile = path.join(asyncDir, "events.jsonl");
	fs.writeFileSync(eventsFile, "");
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const cleared: unknown[] = [];
	const bridge = createStepResultEventBridge({
		runs: () => [{ ...RUN, asyncDir }],
		events: { emit: (channel, payload) => emitted.push({ channel, payload }) },
		timers: { setInterval: () => "timer", clearInterval: (handle) => cleared.push(handle) },
	});
	const publish = (line: Record<string, unknown>) => {
		fs.appendFileSync(eventsFile, `${JSON.stringify(line)}\n`);
	};
	return { root, asyncDir, eventsFile, emitted, cleared, bridge, publish };
}

const stepLine = (stepIndex: number, overrides: Record<string, unknown> = {}) => ({
	type: "subagent.step.result.completed",
	stepResultArtifactVersion: 1,
	ts: 1_700_000_000_000 + stepIndex,
	runId: "run-a",
	stepIndex,
	agent: "scout",
	state: "complete",
	resultPath: `/tmp/run-a/step-results/step-${stepIndex}.json`,
	...overrides,
});

describe("step result event bridge", () => {
	it("emits a bus event when a child publishes a result", () => {
		// This is the wake signal: run-level completion only fires after the whole
		// batch joins, so without it a sleeper learns about a finished child on its
		// next poll instead of on the event.
		const f = fixture();
		try {
			f.publish(stepLine(0));
			f.bridge.tick();
			assert.equal(f.emitted.length, 1);
			assert.equal(f.emitted[0]!.channel, SUBAGENT_STEP_RESULT_EVENT);
			assert.deepEqual(f.emitted[0]!.payload, {
				runId: "run-a",
				stepIndex: 0,
				agent: "scout",
				state: "complete",
				resultPath: "/tmp/run-a/step-results/step-0.json",
				ts: 1_700_000_000_000,
			});
		} finally {
			f.bridge.dispose();
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("emits each publication once and only the new ones", () => {
		const f = fixture();
		try {
			f.publish(stepLine(0));
			f.bridge.tick();
			f.bridge.tick();
			assert.equal(f.emitted.length, 1, "a re-tick must not re-emit an already-read line");

			f.publish(stepLine(1));
			f.bridge.tick();
			assert.deepEqual(
				f.emitted.map((entry) => (entry.payload as { stepIndex: number }).stepIndex),
				[0, 1],
			);
		} finally {
			f.bridge.dispose();
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("ignores other event types and a half-written trailing line", () => {
		const f = fixture();
		try {
			f.publish({ type: "subagent.steering.notice", runId: "run-a", ts: 1 });
			f.publish(stepLine(0));
			fs.appendFileSync(f.eventsFile, '{"type":"subagent.step.result.comp');
			f.bridge.tick();
			assert.equal(f.emitted.length, 1, "only the complete, relevant line may be emitted");

			// Completing the line makes it readable; the cursor must not have skipped it.
			fs.appendFileSync(f.eventsFile, 'leted","runId":"run-a","stepIndex":2,"state":"failed"}\n');
			f.bridge.tick();
			assert.deepEqual(
				f.emitted.map((entry) => (entry.payload as { stepIndex: number }).stepIndex),
				[0, 2],
			);
		} finally {
			f.bridge.dispose();
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("reads a terminal run's final flush, which is where the result line lands", () => {
		// Regression: the runner appends the published-result line in the same last burst
		// as the run's completion events, so the run is already `complete` when that line
		// hits disk. Filtering on a running status dropped exactly that line, and the
		// live trace showed the bridge reading four other lines and stopping.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-step-events-terminal-"));
		try {
			const asyncDir = path.join(root, "run-b");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(
				path.join(asyncDir, "events.jsonl"),
				[
					JSON.stringify({ type: "subagent.step.completed", runId: "run-b", stepIndex: 0 }),
					JSON.stringify(stepLine(0, { runId: "run-b" })),
					JSON.stringify({ type: "subagent.run.completed", runId: "run-b" }),
					"",
				].join("\n"),
			);
			const emitted: unknown[] = [];
			const bridge = createStepResultEventBridge({
				runs: () => [{ asyncId: "run-b", asyncDir, status: "complete" }],
				events: { emit: (_channel, payload) => emitted.push(payload) },
				timers: { setInterval: () => 1, clearInterval: () => {} },
			});
			bridge.tick();
			assert.equal(emitted.length, 1, "the terminal flush must still be read");
			assert.equal((emitted[0] as { stepIndex: number }).stepIndex, 0);
			bridge.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("lets go of a run once it leaves the map", () => {
		// Cursors are per-run state; a run that is gone is not read again even though its
		// log still exists on disk.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-step-events-dropped-"));
		try {
			const asyncDir = path.join(root, "run-c");
			fs.mkdirSync(asyncDir, { recursive: true });
			const file = path.join(asyncDir, "events.jsonl");
			fs.writeFileSync(file, `${JSON.stringify(stepLine(0, { runId: "run-c" }))}\n`);
			let active = true;
			const emitted: unknown[] = [];
			const bridge = createStepResultEventBridge({
				runs: () => (active ? [{ asyncId: "run-c", asyncDir, status: "running" }] : []),
				events: { emit: (_channel, payload) => emitted.push(payload) },
				timers: { setInterval: () => 1, clearInterval: () => {} },
			});
			bridge.tick();
			active = false;
			bridge.tick();
			// Re-adding it starts from offset 0 again rather than replaying from a stale
			// cursor, which is what makes a long-lived parent safe.
			active = true;
			bridge.tick();
			assert.deepEqual(
				emitted.map((entry) => (entry as { stepIndex: number }).stepIndex),
				[0, 0],
			);
			bridge.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("survives an emit that throws, since a stale session context does", () => {
		const f = fixture();
		try {
			const bridge = createStepResultEventBridge({
				runs: () => [{ ...RUN, asyncDir: f.asyncDir }],
				events: {
					emit: () => {
						throw new Error("This extension ctx is stale after session replacement or reload.");
					},
				},
				timers: { setInterval: () => 1, clearInterval: () => {} },
				logError: () => {},
			});
			f.publish(stepLine(0));
			bridge.tick();
			bridge.tick();
			bridge.dispose();
		} finally {
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("clears its timer on dispose", () => {
		const f = fixture();
		try {
			f.bridge.dispose();
			assert.deepEqual(f.cleared, ["timer"]);
		} finally {
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});
});
