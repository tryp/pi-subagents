import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CwdClaimRegistry } from "../../src/runs/shared/cwd-claims.ts";

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

test("parent cwd is treated as a live writer for conflict checks", () => {
	const registry = new CwdClaimRegistry();
	const result = registry.claim({ requests: [{ runId: "child-run", childIndex: 0, cwd: "/repo" }], liveRunIds: new Set(["child-run"]), parentCwd: "/repo", parentRunId: "parent-session" });
	assert.match(result.warnings[0] ?? "", /child-run.*parent-session.*\/repo/);
});
