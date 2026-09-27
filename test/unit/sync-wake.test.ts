import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SYNC_WAKE_MS } from "../../src/shared/types.ts";
import { resolveSupervisorCheckpointMs, resolveSyncWakeMs } from "../../src/runs/shared/sync-wake.ts";

void describe("resolveSupervisorCheckpointMs", () => {
	it("uses the shared 4-minute default and configured budget", () => {
		assert.equal(resolveSupervisorCheckpointMs({}), 240_000);
		assert.equal(resolveSupervisorCheckpointMs({ syncWakeMs: 60_000 }), 60_000);
	});

	it("can be disabled with syncWakeMs = 0 and ignores a wait timeout", () => {
		assert.equal(resolveSupervisorCheckpointMs({ syncWakeMs: 0 }), undefined);
		// A wait timeout is an upper bound, unlike an explicit foreground-run timeout.
		assert.equal(resolveSupervisorCheckpointMs({ syncWakeMs: 60_000 }), 60_000);
	});
});

void describe("resolveSyncWakeMs", () => {
	it("defaults to 4 minutes when config is unset", () => {
		assert.equal(resolveSyncWakeMs({}), DEFAULT_SYNC_WAKE_MS);
		assert.equal(DEFAULT_SYNC_WAKE_MS, 240_000);
	});

	it("uses the configured budget", () => {
		assert.equal(resolveSyncWakeMs({ syncWakeMs: 60_000 }), 60_000);
	});

	it("is disabled by config.syncWakeMs = 0", () => {
		assert.equal(resolveSyncWakeMs({ syncWakeMs: 0 }), undefined);
	});

	it("is disabled when the caller passed an explicit timeout", () => {
		assert.equal(resolveSyncWakeMs({}, 600_000), undefined);
		assert.equal(resolveSyncWakeMs({ syncWakeMs: 60_000 }, 600_000), undefined);
	});

	it("falls back to the default on invalid config values", () => {
		assert.equal(resolveSyncWakeMs({ syncWakeMs: -1 }), DEFAULT_SYNC_WAKE_MS);
		assert.equal(resolveSyncWakeMs({ syncWakeMs: Number.NaN }), DEFAULT_SYNC_WAKE_MS);
		assert.equal(resolveSyncWakeMs({ syncWakeMs: "60000" as unknown as number }), DEFAULT_SYNC_WAKE_MS);
	});
});
