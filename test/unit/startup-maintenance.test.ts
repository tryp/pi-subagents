import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStartupReconciliationController } from "../../src/extension/startup-maintenance.ts";

describe("startup reconciliation scheduler", () => {
	it("defers work until the timer fires and supplies a current-generation guard", async () => {
		const controller = createStartupReconciliationController();
		let called = false;
		let isCurrent: (() => boolean) | undefined;
		controller.schedule((guard) => {
			called = true;
			isCurrent = guard;
		}, 5);
		assert.equal(called, false, "scheduling must not run reconciliation synchronously");
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(called, true);
		assert.equal(isCurrent?.(), true);
		controller.invalidate();
		assert.equal(isCurrent?.(), false, "a later session generation invalidates in-flight work");
		controller.dispose();
	});

	it("suppresses a scheduled callback after shutdown", async () => {
		const controller = createStartupReconciliationController();
		let called = false;
		controller.schedule(() => { called = true; }, 10);
		controller.dispose();
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(called, false);
	});
});
