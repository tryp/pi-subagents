import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function functionBody(source: string, declaration: string): string {
	const start = source.indexOf(declaration);
	assert.notEqual(start, -1, `missing ${declaration}`);
	const open = source.indexOf("{", start);
	assert.notEqual(open, -1, `missing body for ${declaration}`);
	let depth = 0;
	for (let index = open; index < source.length; index++) {
		if (source[index] === "{") depth++;
		if (source[index] === "}" && --depth === 0) return source.slice(open, index + 1);
	}
	assert.fail(`unterminated body for ${declaration}`);
}

describe("deferred startup reconciliation wiring", () => {
	it("keeps console output unreachable from timer-triggered restoration and logs failures silently", () => {
		const index = fs.readFileSync(path.join(root, "src/extension/index.ts"), "utf-8");
		const tracker = fs.readFileSync(path.join(root, "src/runs/background/async-job-tracker.ts"), "utf-8");
		const status = fs.readFileSync(path.join(root, "src/runs/background/async-status.ts"), "utf-8");
		const restore = functionBody(tracker, "const restoreActiveJobsYielding = async");
		const scan = functionBody(status, "export async function listAsyncRunsYielding(");
		const schedule = functionBody(index, "startupReconciliation.schedule(async (isCurrent) =>");

		assert.doesNotMatch(restore, /\bconsole\s*\./);
		assert.doesNotMatch(scan, /\bconsole\s*\./);
		assert.match(restore, /reconcile:\s*"yielding"/, "deferred timer path must own bounded stale-run reconciliation");
		assert.match(status, /await yieldToEventLoop\(\)/, "reconciliation scan yields before the next entry");
		assert.match(schedule, /pi\.appendEntry\("subagent_startup_maintenance"/);
		assert.doesNotMatch(schedule, /\bconsole\s*\./);
	});
});
