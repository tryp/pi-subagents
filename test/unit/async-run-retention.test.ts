import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	ASYNC_RUN_GC_BUDGET_BYTES,
	pruneAsyncRunDirs,
	type AsyncRunGcOptions,
	runAsyncRunGc,
} from "../../src/runs/background/async-run-retention.ts";

const roots: string[] = [];
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-run-gc-test-"));
	roots.push(root);
	const asyncDir = path.join(root, "async-subagent-runs");
	const resultsDir = path.join(root, "results");
	const nestedEventsDir = path.join(root, "nested-subagent-events");
	fs.mkdirSync(asyncDir);
	fs.mkdirSync(resultsDir);
	fs.mkdirSync(nestedEventsDir);
	return { root, asyncDir, resultsDir, nestedEventsDir };
}

function addRun(
	root: ReturnType<typeof fixture>,
	id: string,
	state: string,
	endedAt: number,
	options: { pid?: number; resultBytes?: number; nested?: boolean } = {},
): string {
	const runDir = path.join(root.asyncDir, id);
	fs.mkdirSync(runDir);
	fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
		runId: id,
		mode: "single",
		state,
		startedAt: endedAt - 1_000,
		endedAt,
		lastUpdate: endedAt,
		...(options.pid ? { pid: options.pid } : {}),
	}));
	fs.writeFileSync(path.join(runDir, "output.log"), "12345678");
	if (options.resultBytes) fs.writeFileSync(path.join(root.resultsDir, `${id}.json`), "r".repeat(options.resultBytes));
	if (options.nested) {
		const route = path.join(root.nestedEventsDir, `${id}-token`);
		fs.mkdirSync(route);
		fs.writeFileSync(path.join(route, "route.json"), JSON.stringify({ rootRunId: id, capabilityToken: "token" }));
		fs.writeFileSync(path.join(route, "registry.json"), "registry");
		const nestedResults = path.join(root.resultsDir, "nested", id);
		fs.mkdirSync(nestedResults, { recursive: true });
		fs.writeFileSync(path.join(nestedResults, "child.json"), "nested result");
	}
	return runDir;
}

async function gc(root: ReturnType<typeof fixture>, options: Partial<AsyncRunGcOptions> = {}) {
	return await pruneAsyncRunDirs({
		asyncDir: root.asyncDir,
		resultsDir: root.resultsDir,
		nestedEventsDir: root.nestedEventsDir,
		now: Date.now(),
		budgetBytes: 0,
		keepRecentTerminal: 0,
		minAgeMs: 0,
		scanOpenFds: () => ({ complete: true, unreadable: 0, openPaths: [] }),
		...options,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("async run retention", () => {
	it("uses a named 2 GiB budget setting", async () => {
		assert.equal(ASYNC_RUN_GC_BUDGET_BYTES, 2 * 1024 * 1024 * 1024);
	});

	it("prunes only terminal writer states and keeps paused, running, queued, missing, and unreadable statuses", async () => {
		const root = fixture();
		for (const [id, state] of [["complete", "complete"], ["failed", "failed"], ["stopped", "stopped"]]) addRun(root, id, state, 1);
		for (const [id, state] of [["paused", "paused"], ["running", "running"], ["queued", "queued"]]) addRun(root, id, state, 1);
		fs.mkdirSync(path.join(root.asyncDir, "missing"));
		fs.mkdirSync(path.join(root.asyncDir, "invalid"));
		fs.writeFileSync(path.join(root.asyncDir, "invalid", "status.json"), "{");
		const summary = await gc(root);
		assert.deepEqual(["complete", "failed", "stopped"].map((id) => fs.existsSync(path.join(root.asyncDir, id))), [false, false, false]);
		for (const id of ["paused", "running", "queued", "missing", "invalid"]) assert.equal(fs.existsSync(path.join(root.asyncDir, id)), true, id);
		assert.equal(summary.pruned, 3);
		assert.equal(summary.kept.paused, 1);
		assert.equal(summary.kept.nonterminal, 2);
		assert.equal(summary.kept["missing-status"], 1);
		assert.equal(summary.kept["unreadable-status"], 1);
	});

	it("keeps runs with a live or permission-denied recorded PID and prunes dead PIDs", async () => {
		const root = fixture();
		addRun(root, "dead", "complete", 1, { pid: 123 });
		addRun(root, "live", "failed", 1, { pid: 456 });
		const summary = await gc(root, { isPidAlive: (pid) => pid === 456 });
		assert.equal(fs.existsSync(path.join(root.asyncDir, "dead")), false);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "live")), true);
		assert.equal(summary.kept["live-pid"], 1);
	});

	it("keeps a tree with an open fd or an incomplete /proc scan", async () => {
		const root = fixture();
		const open = addRun(root, "open", "complete", 1);
		addRun(root, "incomplete", "failed", 1);
		const summary = await gc(root, {
			scanOpenFds: (paths) => ({ complete: true, unreadable: 0, openPaths: [open] }),
		});
		assert.equal(fs.existsSync(open), true);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "incomplete")), false);
		assert.equal(summary.kept["open-fd"], 1);
		const conservative = await gc(root, {
			scanOpenFds: () => ({ complete: false, unreadable: 7, openPaths: [] }),
		});
		assert.equal(fs.existsSync(open), true);
		assert.equal(conservative.kept["incomplete-fd-scan"], 1);
		assert.equal(conservative.fdScan.unreadable, 7);
	});

	it("preserves the 20 newest terminal runs and anything under 48 hours", async () => {
		const root = fixture();
		const now = Date.now();
		for (let index = 0; index < 22; index++) addRun(root, `run-${index}`, "complete", now - (index === 20 ? 72 : 1) * 60 * 60 * 1000 - index);
		const summary = await gc(root, { now, keepRecentTerminal: 20, minAgeMs: 48 * 60 * 60 * 1000 });
		assert.equal(fs.existsSync(path.join(root.asyncDir, "run-20")), false);
		for (let index = 0; index < 20; index++) assert.equal(fs.existsSync(path.join(root.asyncDir, `run-${index}`)), true);
		assert.equal(summary.kept["retention-floor"], 20);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "run-21")), true);
		assert.equal(summary.kept["younger-than-min-age"], 1);
	});

	it("prunes oldest first only until the configured byte budget is met and removes related trees", async () => {
		const root = fixture();
		const now = Date.now();
		addRun(root, "oldest", "complete", now - 10 * 24 * 60 * 60 * 1000, { resultBytes: 10, nested: true });
		addRun(root, "middle", "complete", now - 9 * 24 * 60 * 60 * 1000, { resultBytes: 10 });
		addRun(root, "newest", "complete", now - 8 * 24 * 60 * 60 * 1000, { resultBytes: 10 });
		const oneRunBytes = fs.statSync(path.join(root.asyncDir, "newest", "status.json")).size + 18;
		const summary = await gc(root, { now, budgetBytes: oneRunBytes, keepRecentTerminal: 0 });
		assert.equal(fs.existsSync(path.join(root.asyncDir, "oldest")), false);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "middle")), false);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "newest")), true);
		assert.equal(fs.existsSync(path.join(root.resultsDir, "oldest.json")), false);
		assert.equal(fs.existsSync(path.join(root.resultsDir, "nested", "oldest")), false);
		assert.equal(fs.existsSync(path.join(root.nestedEventsDir, "oldest-token")), false);
		assert.equal(summary.pruned, 2);
		assert.ok(summary.bytesAfter <= oneRunBytes);
	});

	it("indexes nested routes once instead of rescanning them per run", async () => {
		const root = fixture();
		for (let i = 0; i < 300; i++) addRun(root, `run-${i}`, "running", 1);
		for (let i = 0; i < 400; i++) {
			const route = path.join(root.nestedEventsDir, `route-${i}`);
			fs.mkdirSync(route);
			fs.writeFileSync(path.join(route, "route.json"), JSON.stringify({ rootRunId: `run-${i % 300}` }));
		}
		const originalReaddir = fs.readdirSync;
		const originalReadFile = fs.readFileSync;
		let routeDirReads = 0;
		let routeFileReads = 0;
		fs.readdirSync = ((target: fs.PathLike, ...args: unknown[]) => {
			if (path.resolve(String(target)) === path.resolve(root.nestedEventsDir)) routeDirReads++;
			return (originalReaddir as (...values: unknown[]) => unknown)(target, ...args);
		}) as typeof fs.readdirSync;
		fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
			if (typeof target === "string" && target.endsWith(`${path.sep}route.json`)) routeFileReads++;
			return (originalReadFile as (...values: unknown[]) => unknown)(target, ...args);
		}) as typeof fs.readFileSync;
		try {
			const summary = await gc(root);
			assert.equal(summary.examined, 300);
			assert.equal(routeDirReads, 1);
			assert.equal(routeFileReads, 400);
			assert.ok(routeDirReads + routeFileReads < 300 * 400);
		} finally {
			fs.readdirSync = originalReaddir;
			fs.readFileSync = originalReadFile;
		}
	});

	it("counts injected reader calls as O(N+M), not N*M", async () => {
		const root = fixture();
		const runCount = 80;
		const routeCount = 120;
		for (let i = 0; i < runCount; i++) addRun(root, `count-${i}`, "running", 1);
		for (let i = 0; i < routeCount; i++) {
			const route = path.join(root.nestedEventsDir, `count-route-${i}`);
			fs.mkdirSync(route);
			fs.writeFileSync(path.join(route, "route.json"), JSON.stringify({ rootRunId: `count-${i % runCount}` }));
		}
		let statusReads = 0;
		let routeReads = 0;
		const reader = new Proxy(fs, {
			get(target, property, receiver) {
				if (property === "readFileSync") return (file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
					if (String(file).endsWith(`${path.sep}status.json`)) statusReads++;
					if (String(file).endsWith(`${path.sep}route.json`)) routeReads++;
					return (target.readFileSync as (...values: unknown[]) => unknown)(file, ...args);
				};
				return Reflect.get(target, property, receiver);
			},
		}) as unknown as AsyncRunGcOptions["reader"];
		const summary = await gc(root, { reader });
		assert.equal(summary.examined, runCount);
		assert.equal(statusReads, runCount);
		assert.equal(routeReads, routeCount);
		assert.equal(statusReads + routeReads, runCount + routeCount);
	});

	it("lets a scheduled setImmediate run before the sweep completes", async () => {
		const root = fixture();
		for (let i = 0; i < 300; i++) addRun(root, `yield-${i}`, "running", 1);
		let immediateRan = false;
		setImmediate(() => { immediateRan = true; });
		const summary = await gc(root, { yieldEveryItems: 8, maxChunkMs: 1000 });
		assert.equal(immediateRan, true);
		assert.ok(summary.yieldedChunks > 0);
	});

	it("reports budget yields and resumes its cursor without rereading completed candidates", async () => {
		const root = fixture();
		const candidateCount = 40;
		for (let i = 0; i < candidateCount; i++) addRun(root, `resume-${i}`, "running", 1);
		let statusReads = 0;
		let observedCursorAdvance = false;
		const telemetry: string[] = [];
		const reader = new Proxy(fs, {
			get(target, property, receiver) {
				if (property === "readFileSync") return (file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
					if (String(file).endsWith(`${path.sep}status.json`)) statusReads++;
					return (target.readFileSync as (...values: unknown[]) => unknown)(file, ...args);
				};
				return Reflect.get(target, property, receiver);
			},
		}) as unknown as AsyncRunGcOptions["reader"];
		const cursor = { phase: "nested-routes" as const, routeOffset: 0, candidateOffset: 0, fdProcessOffset: 0, fdEntryOffset: 0, deleteOffset: 0, yieldedChunks: 0 };
		const summary = await gc(root, {
			reader,
			cursor,
			yieldEveryItems: 4,
			maxChunkMs: 1000,
			onYield: (current) => { if (current.candidateOffset > 0) observedCursorAdvance = true; },
			log: (line) => telemetry.push(line),
		});
		assert.ok(summary.deferredByBudget > 0);
		assert.equal(summary.deferredByBudget, summary.yieldedChunks);
		assert.equal(statusReads, candidateCount);
		assert.equal(cursor.candidateOffset, candidateCount);
		assert.equal(cursor.phase, "done");
		assert.equal(observedCursorAdvance, true);
		assert.match(telemetry[0], /deferredByBudget=[1-9][0-9]*/);
	});

	it("does not run overlapping GC sweeps concurrently", async () => {
		const root = fixture();
		for (let i = 0; i < 80; i++) addRun(root, `overlap-${i}`, "running", 1);
		const options: AsyncRunGcOptions = {
			asyncDir: root.asyncDir,
			resultsDir: root.resultsDir,
			nestedEventsDir: root.nestedEventsDir,
			yieldEveryItems: 1,
			maxChunkMs: 1000,
			scanOpenFds: () => ({ complete: true, unreadable: 0, openPaths: [] }),
		};
		const first = runAsyncRunGc(options);
		const second = await runAsyncRunGc(options);
		assert.equal(second, null);
		assert.ok(await first);
	});

	it("dry-run reports would-prune without deleting copied candidates", async () => {
		const root = fixture();
		const runDir = addRun(root, "dry-run", "complete", 1);
		const summary = await gc(root, { dryRun: true });
		assert.equal(summary.pruned, 0);
		assert.equal(summary.dryRunWouldPrune, 1);
		assert.equal(fs.existsSync(runDir), true);
	});

	it("honors PI_SUBAGENTS_GC=off as a kill switch", async () => {
		const previous = process.env.PI_SUBAGENTS_GC;
		process.env.PI_SUBAGENTS_GC = "off";
		const lines: string[] = [];
		try {
			const summary = await (await import("../../src/runs/background/async-run-retention.ts")).runAsyncRunGc({ log: (line) => lines.push(line) });
			assert.equal(summary, null);
			assert.deepEqual(lines, ["[subagent async-run GC] disabled=env"]);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_GC;
			else process.env.PI_SUBAGENTS_GC = previous;
		}
	});

	it("counts retention keeps and emits one summary line", async () => {
		const root = fixture();
		addRun(root, "fresh", "complete", Date.now());
		const lines: string[] = [];
		const summary = await gc(root, { minAgeMs: 48 * 60 * 60 * 1000, log: (line) => lines.push(line) });
		assert.equal(summary.kept["younger-than-min-age"], 1);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /pruned=0.*examined=1/);
		assert.match(lines[0], /younger-than-min-age/);
	});
});
