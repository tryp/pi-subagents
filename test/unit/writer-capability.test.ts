import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CwdClaimRegistry } from "../../src/runs/shared/cwd-claims.ts";
import { applyReadOnlyToolPolicy, isReadOnlyToolSet, READ_ONLY_CHILD_TOOLS, READ_ONLY_PARENT_ENV } from "../../src/runs/shared/writer-capability.ts";
import { buildPiArgs, cleanupTempDir } from "../../src/runs/shared/pi-args.ts";

const live = (...ids: string[]) => new Set(ids);

test("readOnly policy strips write-capable tools, user extensions, MCP tools, and nested fanout", () => {
	const agent = applyReadOnlyToolPolicy({
		name: "reviewer",
		tools: ["read", "edit", "bash", "subagent", "custom.ts"],
		extensions: ["user-extension"],
		subagentOnlyExtensions: ["fanout-extension"],
		mcpDirectTools: ["mcp__mutate"],
	});
	assert.deepEqual(agent.tools, READ_ONLY_CHILD_TOOLS);
	assert.deepEqual(agent.extensions, []);
	assert.deepEqual(agent.subagentOnlyExtensions, []);
	assert.deepEqual(agent.mcpDirectTools, []);
	assert.equal(isReadOnlyToolSet(agent.tools), true);
	const built = buildPiArgs({ baseArgs: ["--mode", "json", "-p"], task: "review", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, tools: agent.tools, extensions: agent.extensions, subagentOnlyExtensions: agent.subagentOnlyExtensions, mcpDirectTools: agent.mcpDirectTools });
	const toolsFlag = built.args.indexOf("--tools");
	assert.deepEqual(built.args[toolsFlag + 1]?.split(","), READ_ONLY_CHILD_TOOLS);
	assert.equal(built.args.includes("--no-extensions"), true);
	assert.equal(built.env[READ_ONLY_PARENT_ENV], "1");
	assert.equal(built.args.some((arg) => arg.includes("user-extension") || arg.includes("mcp__mutate")), false);
	if (built.tempDir) cleanupTempDir(built.tempDir);
});

test("same-cwd quadrant matrix only rejects writer x writer", () => {
	const readOnlyTools = READ_ONLY_CHILD_TOOLS;
	const cases = [
		{ name: "read-only parent x read-only child", parentTools: readOnlyTools, childTools: readOnlyTools, blocked: false },
		{ name: "read-only parent x writer", parentTools: readOnlyTools, childTools: undefined, blocked: false },
		{ name: "writer parent x read-only", parentTools: undefined, childTools: readOnlyTools, blocked: false },
		{ name: "writer parent x writer", parentTools: undefined, childTools: undefined, blocked: true },
	] as const;
	for (const item of cases) {
		const registry = new CwdClaimRegistry();
		const result = registry.claim({
			requests: [{ runId: "child", childIndex: 0, cwd: "/repo", ...(item.childTools ? { tools: item.childTools } : {}) }],
			liveRunIds: live("child"),
			parentCwd: "/repo",
			parentRunId: "parent",
			parentTools: item.parentTools,
		});
		assert.equal(Boolean(result.error), item.blocked, item.name);
	}
});

test("a declared read-only acceptance role does not exempt a writer-capable child", () => {
	const registry = new CwdClaimRegistry();
	const result = registry.claim({ requests: [{ runId: "child", childIndex: 0, cwd: "/repo", agentName: "reviewer", acceptanceRole: "read-only" }], liveRunIds: live("child"), parentCwd: "/repo", parentRunId: "parent" });
	assert.equal(result.conflict?.code, "cwd_writer_conflict");
});

test("unknown tools are classified as write-capable", () => {
	assert.equal(isReadOnlyToolSet(["read", "unknown-extension-tool"]), false);
});

test("guard trip and named override are persisted as queryable audit events", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-writer-guard-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const claimsFile = path.join(dir, "claims.jsonl");
	const registry = new CwdClaimRegistry();
	registry.claim({ requests: [{ runId: "holder", childIndex: 0, cwd: "/repo" }], liveRunIds: live("holder") });
	const refused = registry.claim({ requests: [{ runId: "refused", childIndex: 0, cwd: "/repo", claimsFile }], liveRunIds: live("holder", "refused") });
	assert.equal(refused.conflict?.code, "cwd_writer_conflict");
	assert.equal(registry.guardTrips, 1);
	const overridden = registry.claim({ requests: [{ runId: "override", childIndex: 0, cwd: "/repo", claimsFile }], liveRunIds: live("holder", "override"), overrideWriterGuard: true });
	assert.equal(overridden.error, undefined);
	assert.equal(registry.guardTrips, 2);
	assert.equal(registry.guardOverrides, 1);
	const events = fs.readFileSync(claimsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(events.map((event) => event.event), ["cwd-writer-guard-trip", "cwd-writer-guard-trip", "cwd-writer-guard-override", "claim"]);
	assert.deepEqual(events[2].holderRunIds, ["holder"]);
	assert.equal(events[2].conflict.code, "cwd_writer_conflict");
	assert.equal(events[2].overrideReason, "explicit overrideWriterGuard dispatch parameter");
});
