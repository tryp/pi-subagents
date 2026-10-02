import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CheckpointDeltaStore, MAX_SCAN_BYTES } from "../../src/runs/background/checkpoint-deltas.ts";
import type { LogCounts } from "../../src/runs/shared/log-classify.ts";

const EMPTY_COUNTS: LogCounts = { err: 0, warn: 0, total: 0 };

async function withTempLog(test: (logPath: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-delta-test-"));
	try {
		await test(path.join(dir, "output.log"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

void describe("CheckpointDeltaStore", () => {
	it("returns undefined without a baseline", async () => {
		const store = new CheckpointDeltaStore();
		assert.equal(await store.delta("run-1", { turnCount: 1 }, undefined), undefined);
	});

	it("computes progress and log deltas, then advances the baseline", async () => {
		await withTempLog(async (logPath) => {
			await writeFile(logPath, "existing output\n");
			const initialSize = (await readFile(logPath)).byteLength;
			const store = new CheckpointDeltaStore();
			store.baseline("run-1", { turnCount: 3, toolCount: 5, tokens: 100 }, initialSize, EMPTY_COUNTS);

			await appendFile(logPath, "ERROR: request failed\nWARN: retrying\nready\n");
			const first = await store.delta("run-1", { turnCount: 5, toolCount: 8, tokens: 175 }, logPath);
			assert.deepEqual(first, {
				turns: 2,
				tools: 3,
				tokens: 75,
				logLines: 3,
				logErr: 1,
				logWarn: 1,
				firstError: "ERROR: request failed",
				rotated: false,
				truncated: false,
			});

			await appendFile(logPath, "second batch\n");
			const second = await store.delta("run-1", { turnCount: 6, toolCount: 9, tokens: 200 }, logPath);
			assert.deepEqual(second, {
				turns: 1,
				tools: 1,
				tokens: 25,
				logLines: 1,
				logErr: 0,
				logWarn: 0,
				firstError: undefined,
				rotated: false,
				truncated: false,
			});
		});
	});

	it("detects rotation and scans the replacement file from byte zero", async () => {
		await withTempLog(async (logPath) => {
			await writeFile(logPath, "old output that is longer than new\n");
			const store = new CheckpointDeltaStore();
			store.baseline("run-rotate", { turnCount: 1 }, 35, EMPTY_COUNTS);
			await writeFile(logPath, "WARN: replacement\n");
			const result = await store.delta("run-rotate", { turnCount: 2 }, logPath);
			assert.equal(result?.rotated, true);
			assert.equal(result?.logLines, 1);
			assert.equal(result?.logWarn, 1);
		});
	});

	it("caps bytes scanned and marks the delta truncated", async () => {
		await withTempLog(async (logPath) => {
			await writeFile(logPath, "x\n".repeat(MAX_SCAN_BYTES / 2 + 1));
			const store = new CheckpointDeltaStore();
			store.baseline("run-cap", {}, 0, EMPTY_COUNTS);
			const result = await store.delta("run-cap", {}, logPath);
			assert.equal(result?.truncated, true);
			assert.equal(result?.logLines, MAX_SCAN_BYTES / 2);
		});
	});

	it("forgets run state", async () => {
		const store = new CheckpointDeltaStore();
		store.baseline("run-forget", { turnCount: 1 }, 0, EMPTY_COUNTS);
		store.forget("run-forget");
		assert.equal(await store.delta("run-forget", { turnCount: 2 }, undefined), undefined);
	});
});
