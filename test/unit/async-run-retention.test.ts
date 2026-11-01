import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	ASYNC_RUN_GC_BUDGET_BYTES,
	pruneAsyncRunDirs,
	scanProcOpenFds,
	type AsyncRunGcOptions,
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

function fakeProc(root: ReturnType<typeof fixture>, pid: string, uidLine?: string, fdTable: "directory" | "file" | "missing" = "missing", fdTarget?: string): string {
	const procRoot = path.join(root.root, "proc");
	const procDir = path.join(procRoot, pid);
	fs.mkdirSync(procDir, { recursive: true });
	if (uidLine !== undefined) fs.writeFileSync(path.join(procDir, "status"), `Name:\tfake\n${uidLine}\n`);
	if (fdTable === "directory") {
		fs.mkdirSync(path.join(procDir, "fd"));
		if (fdTarget) fs.symlinkSync(fdTarget, path.join(procDir, "fd", "0"));
	}
	if (fdTable === "file") fs.writeFileSync(path.join(procDir, "fd"), "not a directory");
	return procRoot;
}

function gc(root: ReturnType<typeof fixture>, options: Partial<AsyncRunGcOptions> = {}) {
	return pruneAsyncRunDirs({
		asyncDir: root.asyncDir,
		resultsDir: root.resultsDir,
		nestedEventsDir: root.nestedEventsDir,
		now: Date.now(),
		budgetBytes: 0,
		keepRecentTerminal: 0,
		minAgeMs: 0,
		scanOpenFds: () => ({ complete: true, unreadable: 0, foreignUid: 0, scannedReadableForeign: 0, foreignUnreadable: 0, sameUidUnreadable: 0, uidUnverifiable: 0, scanTruncated: false, unreadableForeignUids: [], openPaths: [] }),
		...options,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("async run retention", () => {
	it("uses a named 2 GiB budget setting", () => {
		assert.equal(ASYNC_RUN_GC_BUDGET_BYTES, 2 * 1024 * 1024 * 1024);
	});

	it("prunes only terminal writer states and keeps paused, running, queued, missing, and unreadable statuses", () => {
		const root = fixture();
		for (const [id, state] of [["complete", "complete"], ["failed", "failed"], ["stopped", "stopped"]]) addRun(root, id, state, 1);
		for (const [id, state] of [["paused", "paused"], ["running", "running"], ["queued", "queued"]]) addRun(root, id, state, 1);
		fs.mkdirSync(path.join(root.asyncDir, "missing"));
		fs.mkdirSync(path.join(root.asyncDir, "invalid"));
		fs.writeFileSync(path.join(root.asyncDir, "invalid", "status.json"), "{");
		const summary = gc(root);
		assert.deepEqual(["complete", "failed", "stopped"].map((id) => fs.existsSync(path.join(root.asyncDir, id))), [false, false, false]);
		for (const id of ["paused", "running", "queued", "missing", "invalid"]) assert.equal(fs.existsSync(path.join(root.asyncDir, id)), true, id);
		assert.equal(summary.pruned, 3);
		assert.equal(summary.kept.paused, 1);
		assert.equal(summary.kept.nonterminal, 2);
		assert.equal(summary.kept["missing-status"], 1);
		assert.equal(summary.keptMissingStatus, 1);
		assert.equal(summary.statusErrors.ENOENT, 1);
		assert.equal(summary.kept["unreadable-status"], 1);
		assert.equal(summary.statusErrors.malformed, 1);
	});

	it("classifies status EACCES separately from ENOENT and keeps the unreadable status", () => {
		const root = fixture();
		const runDir = addRun(root, "inaccessible-status", "complete", 1);
		fs.chmodSync(path.join(runDir, "status.json"), 0);
		const summary = gc(root);
		assert.equal(fs.existsSync(runDir), true);
		assert.equal(summary.keptUnreadableStatusForeign, 1);
		assert.equal(summary.kept["unreadable-status-foreign"], 1);
		assert.equal(summary.statusErrors.EACCES, 1);
	});

	it("keeps runs with a live or permission-denied recorded PID and prunes dead PIDs", () => {
		const root = fixture();
		addRun(root, "dead", "complete", 1, { pid: 123 });
		addRun(root, "live", "failed", 1, { pid: 456 });
		const summary = gc(root, { isPidAlive: (pid) => pid === 456 });
		assert.equal(fs.existsSync(path.join(root.asyncDir, "dead")), false);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "live")), true);
		assert.equal(summary.kept["live-pid"], 1);
	});

	it("keeps a tree with an open fd or an incomplete /proc scan", () => {
		const root = fixture();
		const open = addRun(root, "open", "complete", 1);
		addRun(root, "incomplete", "failed", 1);
		const summary = gc(root, {
			scanOpenFds: (paths) => ({ complete: true, unreadable: 0, foreignUid: 0, scannedReadableForeign: 0, foreignUnreadable: 0, sameUidUnreadable: 0, uidUnverifiable: 0, scanTruncated: false, unreadableForeignUids: [], openPaths: [open] }),
		});
		assert.equal(fs.existsSync(open), true);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "incomplete")), false);
		assert.equal(summary.kept["open-fd"], 1);
		const conservative = gc(root, {
			scanOpenFds: () => ({ complete: false, unreadable: 7, foreignUid: 0, scannedReadableForeign: 0, foreignUnreadable: 0, sameUidUnreadable: 0, uidUnverifiable: 0, scanTruncated: false, unreadableForeignUids: [], openPaths: [] }),
		});
		assert.equal(fs.existsSync(open), true);
		assert.equal(conservative.kept["incomplete-fd-scan"], 1);
		assert.equal(conservative.fdScan.unreadable, 7);
	});

	it("prunes when unreadable foreign fd tables cannot reach any candidate path", () => {
		const root = fixture();
		const runDir = addRun(root, "foreign-only", "complete", 1);
		const foreignUid = (process.getuid?.() ?? 1000) + 1;
		const procRoot = fakeProc(root, "901", `Uid:\t${foreignUid}\t${foreignUid}\t${foreignUid}\t${foreignUid}`, "file");
		const lines: string[] = [];
		const summary = gc(root, { procRoot, scanOpenFds: scanProcOpenFds, log: (line) => lines.push(line) });
		assert.equal(fs.existsSync(runDir), false);
		assert.equal(summary.pruned, 1);
		assert.equal(summary.skippedUnreadableForeignProvenUnreachable, 1);
		assert.equal(summary.keptUnreadableForeignReachable, 0);
		assert.equal(summary.keptSameUidUnreadable, 0);
		assert.match(lines[0]!, /sweep examined=1 collectable=1 .*deleted=1/);
		assert.match(lines[0]!, /blockedUnreadable=0 blockedWorldAccessible=0/);
	});

	it("keeps a candidate when an unreadable foreign fd table could reach its world-readable tree", () => {
		const root = fixture();
		const runDir = addRun(root, "foreign-world", "complete", 1);
		fs.chmodSync(root.root, 0o755);
		fs.chmodSync(root.asyncDir, 0o755);
		fs.chmodSync(runDir, 0o755);
		const foreignUid = (process.getuid?.() ?? 1000) + 1;
		const procRoot = fakeProc(root, "902", `Uid:\t${foreignUid}\t${foreignUid}\t${foreignUid}\t${foreignUid}`, "file");
		const summary = gc(root, { procRoot, scanOpenFds: scanProcOpenFds });
		assert.equal(fs.existsSync(runDir), true);
		assert.equal(summary.keptUnreadableForeignReachable, 1);
		assert.equal(summary.kept["unreadable-foreign-reachable"], 1);
	});

	it("scans readable foreign fd tables and keeps a candidate they hold open", () => {
		const root = fixture();
		const runDir = addRun(root, "readable-foreign-open", "complete", 1);
		const foreignUid = (process.getuid?.() ?? 1000) + 1;
		const procRoot = fakeProc(root, "906", `Uid:\t${foreignUid}\t${foreignUid}\t${foreignUid}\t${foreignUid}`, "directory", runDir);
		const summary = gc(root, { procRoot, scanOpenFds: scanProcOpenFds });
		assert.equal(fs.existsSync(runDir), true);
		assert.equal(summary.scannedReadableForeign, 1);
		assert.equal(summary.kept["open-fd"], 1);
		assert.equal(summary.skippedUnreadableForeignProvenUnreachable, 0);
	});

	it("keeps candidates when a same-uid fd table is unreadable", () => {
		const root = fixture();
		const runDir = addRun(root, "same-uid-unreadable", "complete", 1);
		const uid = process.getuid?.() ?? 1000;
		const procRoot = fakeProc(root, "903", `Uid:\t${uid}\t${uid}\t${uid}\t${uid}`, "file");
		const summary = gc(root, { procRoot, scanOpenFds: scanProcOpenFds });
		assert.equal(fs.existsSync(runDir), true);
		assert.equal(summary.keptSameUidUnreadable, 1);
		assert.equal(summary.kept["same-uid-unreadable-fd"], 1);
	});

	it("keeps candidates when process uid cannot be verified", () => {
		const root = fixture();
		const runDir = addRun(root, "uid-unverifiable", "complete", 1);
		const procRoot = fakeProc(root, "904", "State:\tS");
		const summary = gc(root, { procRoot, scanOpenFds: scanProcOpenFds });
		assert.equal(fs.existsSync(runDir), true);
		assert.equal(summary.keptUidUnverifiable, 1);
		assert.equal(summary.kept["uid-unverifiable"], 1);
	});

	it("accounts for every examined candidate in a mixed sweep", () => {
		const root = fixture();
		const privateRun = addRun(root, "private", "complete", 1);
		const worldRun = addRun(root, "world", "complete", 1);
		const openRun = addRun(root, "open", "complete", 1);
		addRun(root, "owner-alive", "complete", 1, { pid: 905 });
		fs.chmodSync(root.root, 0o711);
		fs.chmodSync(root.asyncDir, 0o711);
		fs.chmodSync(privateRun, 0o700);
		fs.chmodSync(worldRun, 0o711);
		fs.chmodSync(openRun, 0o700);
		const lines: string[] = [];
		const summary = gc(root, {
			isPidAlive: (pid) => pid === 905,
			scanOpenFds: () => ({ complete: true, unreadable: 0, foreignUid: 1, scannedReadableForeign: 1, foreignUnreadable: 0, sameUidUnreadable: 0, uidUnverifiable: 0, scanTruncated: false, unreadableForeignUids: [], openPaths: [openRun] }),
			log: (line) => lines.push(line),
		});
		assert.equal(fs.existsSync(privateRun), false);
		assert.equal(fs.existsSync(worldRun), false);
		assert.equal(fs.existsSync(openRun), true);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "owner-alive")), true);
		assert.equal(summary.pruned, 2);
		assert.equal(summary.scannedReadableForeign, 1);
		assert.equal(summary.keptWorldAccessible, 0);
		assert.equal(summary.kept["live-pid"], 1);
		assert.equal(summary.keptOwnerAlive, 1);
		assert.equal(summary.kept["open-fd"], 1);
		assert.equal(summary.pruned + summary.wouldPrune + Object.values(summary.kept).reduce((sum, count) => sum + count, 0), summary.examined);
		assert.equal(Object.values(summary.outcomes).reduce((sum, count) => sum + count, 0), summary.examined);
		assert.match(lines[0]!, /sweep examined=4 collectable=2 .*deleted=2/);
	});

	it("preserves the 20 newest terminal runs and anything under 48 hours", () => {
		const root = fixture();
		const now = Date.now();
		for (let index = 0; index < 22; index++) addRun(root, `run-${index}`, "complete", now - (index === 20 ? 72 : 1) * 60 * 60 * 1000 - index);
		const summary = gc(root, { now, keepRecentTerminal: 20, minAgeMs: 48 * 60 * 60 * 1000 });
		assert.equal(fs.existsSync(path.join(root.asyncDir, "run-20")), false);
		for (let index = 0; index < 20; index++) assert.equal(fs.existsSync(path.join(root.asyncDir, `run-${index}`)), true);
		assert.equal(summary.kept["retention-floor"], 20);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "run-21")), true);
		assert.equal(summary.kept["younger-than-min-age"], 1);
	});

	it("dry-run reports would-delete counts and bytes without deleting candidate data", () => {
		const root = fixture();
		const runDir = addRun(root, "dry-run", "complete", 1, { resultBytes: 32 });
		const bytesBefore = fs.statSync(path.join(runDir, "status.json")).size + fs.statSync(path.join(runDir, "output.log")).size + 32;
		const summary = gc(root, { dryRun: true });
		assert.equal(fs.existsSync(runDir), true);
		assert.equal(fs.existsSync(path.join(root.resultsDir, "dry-run.json")), true);
		assert.equal(summary.pruned, 0);
		assert.equal(summary.wouldPrune, 1);
		assert.equal(summary.bytesWouldReclaim, bytesBefore);
		assert.equal(summary.bytesAfter, summary.bytesBefore);
	});

	it("prunes oldest first only until the configured byte budget is met and removes related trees", () => {
		const root = fixture();
		const now = Date.now();
		addRun(root, "oldest", "complete", now - 10 * 24 * 60 * 60 * 1000, { resultBytes: 10, nested: true });
		addRun(root, "middle", "complete", now - 9 * 24 * 60 * 60 * 1000, { resultBytes: 10 });
		addRun(root, "newest", "complete", now - 8 * 24 * 60 * 60 * 1000, { resultBytes: 10 });
		const oneRunBytes = fs.statSync(path.join(root.asyncDir, "newest", "status.json")).size + 18;
		const summary = gc(root, { now, budgetBytes: oneRunBytes, keepRecentTerminal: 0 });
		assert.equal(fs.existsSync(path.join(root.asyncDir, "oldest")), false);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "middle")), false);
		assert.equal(fs.existsSync(path.join(root.asyncDir, "newest")), true);
		assert.equal(fs.existsSync(path.join(root.resultsDir, "oldest.json")), false);
		assert.equal(fs.existsSync(path.join(root.resultsDir, "nested", "oldest")), false);
		assert.equal(fs.existsSync(path.join(root.nestedEventsDir, "oldest-token")), false);
		assert.equal(summary.pruned, 2);
		assert.ok(summary.bytesAfter <= oneRunBytes);
	});

	it("indexes nested routes once instead of rescanning them per run", () => {
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
			const summary = gc(root);
			assert.equal(summary.examined, 300);
			assert.equal(routeDirReads, 1);
			assert.equal(routeFileReads, 400);
			assert.ok(routeDirReads + routeFileReads < 300 * 400);
		} finally {
			fs.readdirSync = originalReaddir;
			fs.readFileSync = originalReadFile;
		}
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

	it("counts retention keeps and emits one summary line", () => {
		const root = fixture();
		addRun(root, "fresh", "complete", Date.now());
		const lines: string[] = [];
		const summary = gc(root, { minAgeMs: 48 * 60 * 60 * 1000, log: (line) => lines.push(line) });
		assert.equal(summary.kept["younger-than-min-age"], 1);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /sweep examined=1 collectable=0 .*deleted=0/);
		assert.match(lines[0], /younger-than-min-age/);
	});
});
