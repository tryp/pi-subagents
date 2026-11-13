import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CwdClaimRegistry, releaseTerminalCwdClaims } from "../../src/runs/shared/cwd-claims.ts";
import { registerAsyncCwdClaims } from "../../src/runs/foreground/subagent-executor.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";

function fixture(t: test.TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-claims-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return { dir, file: path.join(dir, "run", "claims.jsonl") };
}

test("claim-record persists a claim with run, child, and resolved cwd", (t) => {
	const { file } = fixture(t);
	const registry = new CwdClaimRegistry();
	const result = registry.claim({ requests: [{ runId: "run-a", childIndex: 2, cwd: ".", claimsFile: file }], liveRunIds: new Set(["run-a"]), now: 10 });
	assert.equal(result.claims.length, 1);
	assert.equal(result.claims[0]?.cwd, process.cwd());
	const record = JSON.parse(fs.readFileSync(file, "utf8").trim());
	assert.deepEqual({ event: record.event, runId: record.runId, childIndex: record.childIndex, cwd: record.cwd }, { event: "claim", runId: "run-a", childIndex: 2, cwd: process.cwd() });
});

test("conflict-warn allows a second run and reports both owners", () => {
	const registry = new CwdClaimRegistry();
	registry.claim({ requests: [{ runId: "run-a", childIndex: 0, cwd: "/repo" }], liveRunIds: new Set(["run-a"]) });
	const result = registry.claim({ requests: [{ runId: "run-b", childIndex: 1, cwd: "/repo" }], liveRunIds: new Set(["run-a", "run-b"]) });
	assert.equal(result.error, undefined);
	assert.match(result.warnings[0]!, /run-b.*run-a.*\/repo/);
	assert.equal(registry.list(new Set(["run-a", "run-b"])).length, 2);
});

test("conflict-refuse rejects strict worktree launch before recording any claim", (t) => {
	const { file } = fixture(t);
	const registry = new CwdClaimRegistry();
	registry.claim({ requests: [{ runId: "run-a", childIndex: 0, cwd: "/repo" }], liveRunIds: new Set(["run-a"]) });
	const result = registry.claim({ requests: [{ runId: "run-b", childIndex: 0, cwd: "/repo", claimsFile: file }], liveRunIds: new Set(["run-a", "run-b"]), strict: true });
	assert.match(result.error ?? "", /run-b.*\/repo.*run-a/);
	assert.equal(registry.list(new Set(["run-a", "run-b"])).some((claim) => claim.runId === "run-b"), false);
	assert.equal(fs.existsSync(file), false);
});

test("release-on-terminal appends release records and removes all run claims", (t) => {
	const { file } = fixture(t);
	const registry = new CwdClaimRegistry();
	registry.claim({ requests: [{ runId: "run-a", childIndex: 0, cwd: "/repo", claimsFile: file }], liveRunIds: new Set(["run-a"]) });
	assert.equal(registry.releaseRun("run-a", "completed").length, 1);
	assert.equal(registry.list(new Set(["run-a"])).length, 0);
	const records = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(records.map((record) => record.event), ["claim", "release"]);
	assert.equal(records[1].reason, "completed");
});

test("status-summary reports run count and per-claim rows", () => {
	const registry = new CwdClaimRegistry();
	registry.claim({ requests: [{ runId: "run-a", childIndex: 0, cwd: "/repo" }, { runId: "run-b", childIndex: 1, cwd: "/repo" }], liveRunIds: new Set(["run-a", "run-b"]) });
	const status = registry.format(new Set(["run-a", "run-b"]));
	assert.match(status, /2 runs writing \/repo/);
	assert.match(status, /run run-a child 0: \/repo/);
	assert.match(status, /run run-b child 1: \/repo/);
});

test("stale-claim handling prunes claims for runs absent from the live table and counts them", (t) => {
	const { file } = fixture(t);
	const registry = new CwdClaimRegistry();
	registry.claim({ requests: [{ runId: "crashed", childIndex: 0, cwd: "/repo", claimsFile: file }], liveRunIds: new Set(["crashed"]) });
	assert.equal(registry.list(new Set()).length, 0);
	assert.equal(registry.staleClaims, 1);
	const records = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records[1].reason, "stale-run-not-live");
});

test("a refused launch leaves no stale claim on the next lookup", () => {
	const registry = new CwdClaimRegistry();
	registry.claim({ requests: [{ runId: "run-a", childIndex: 0, cwd: "/repo" }], liveRunIds: new Set(["run-a"]) });
	const refused = registry.claim({ requests: [{ runId: "run-b", childIndex: 0, cwd: "/repo" }], liveRunIds: new Set(["run-a", "run-b"]), strict: true });
	assert.ok(refused.error);
	assert.equal(registry.list(new Set(["run-a"])).some((claim) => claim.runId === "run-b"), false);
});

test("spawn preparation persists the claim before the child task starts", (t) => {
	const runId = `cwd-claim-before-spawn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const asyncDir = path.join(ASYNC_DIR, runId);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-spawn-"));
	t.after(() => {
		fs.rmSync(asyncDir, { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	});
	const state = { cwdClaims: new CwdClaimRegistry(), asyncJobs: new Map() };
	const deps = { state, config: { worktreeBaseDir: path.join(root, "worktrees") } } as any;
	let taskStarted = false;
	const error = registerAsyncCwdClaims(deps, {
		runId,
		params: { agent: "worker" },
		cwd: root,
		parentCwd: os.tmpdir(),
	}, () => {
		taskStarted = true;
		const records = fs.readFileSync(path.join(asyncDir, "claims.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records[0]?.event, "claim");
		assert.equal(records[0]?.runId, runId);
		assert.equal(records[0]?.cwd, root);
	});
	assert.equal(error, undefined);
	assert.equal(taskStarted, true);
});

test("terminal status releases cwd claims for completed, failed, and stopped runs", (t) => {
	for (const status of ["complete", "completed", "failed", "stopped"] as const) {
		const { file } = fixture(t);
		const registry = new CwdClaimRegistry();
		registry.claim({ requests: [{ runId: `run-${status}`, childIndex: 0, cwd: "/repo", claimsFile: file }], liveRunIds: new Set([`run-${status}`]) });
		assert.equal(releaseTerminalCwdClaims(registry, `run-${status}`, status).length, 1, `${status} should release claim`);
		assert.equal(registry.list(new Set([`run-${status}`])).length, 0, `${status} should leave no active claim`);
		const records = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records[1]?.event, "release");
		assert.equal(records[1]?.reason, status);
	}
});

test("kill path status is stopped and releases its cwd claim", (t) => {
	const { file } = fixture(t);
	const registry = new CwdClaimRegistry();
	registry.claim({ requests: [{ runId: "killed-by-stop", childIndex: 0, cwd: "/repo", claimsFile: file }], liveRunIds: new Set(["killed-by-stop"]) });
	// stopAsyncRun delivers a stop request; subagent-runner persists state="stopped" (not "killed").
	assert.equal(releaseTerminalCwdClaims(registry, "killed-by-stop", "stopped").length, 1);
	assert.equal(registry.list(new Set(["killed-by-stop"])).length, 0);
	const records = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records[1]?.reason, "stopped");
	assert.equal(releaseTerminalCwdClaims(registry, "killed-by-stop", "killed").length, 0, "no distinct killed status is supported");
});

test("parent cwd is treated as a live writer for conflict checks", () => {
	const registry = new CwdClaimRegistry();
	const result = registry.claim({ requests: [{ runId: "child-run", childIndex: 0, cwd: "/repo" }], liveRunIds: new Set(["child-run"]), parentCwd: "/repo", parentRunId: "parent-session" });
	assert.match(result.warnings[0] ?? "", /child-run.*parent-session.*\/repo/);
});
