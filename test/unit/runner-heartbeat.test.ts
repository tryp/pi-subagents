import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { RUNNER_HEARTBEAT_INTERVAL_MS, startRunnerHeartbeat } from "../../src/runs/background/runner-heartbeat.ts";

test("runner heartbeat fires while a child runs and stops when the run ends", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		let running = true;
		let beats = 0;
		const stop = startRunnerHeartbeat(() => running, () => { beats++; });
		mock.timers.tick(RUNNER_HEARTBEAT_INTERVAL_MS);
		assert.equal(beats, 1);
		running = false;
		mock.timers.tick(RUNNER_HEARTBEAT_INTERVAL_MS);
		mock.timers.tick(RUNNER_HEARTBEAT_INTERVAL_MS);
		assert.equal(beats, 1);
		stop();
	} finally {
		mock.timers.reset();
	}
});
