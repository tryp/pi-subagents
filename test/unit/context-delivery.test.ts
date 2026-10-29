import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { prepareContextDelivery, writeContextDeliveryReceipt } from "../../src/runs/shared/context-delivery.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";

async function withTempDir(run: (dir: string) => void | Promise<void>): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-context-"));
	try { await run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("explicit context files are supplied to the prompt and missing optional files are quiet", async () => {
	await withTempDir((cwd) => {
		fs.writeFileSync(path.join(cwd, "task.md"), "specific task context");
		const prepared = prepareContextDelivery(cwd, { required: ["task.md"], optional: ["not-there.md"] });
		assert.match(prepared.prompt, /specific task context/);
		assert.equal(prepared.receipt.references[0]?.status, "available");
		assert.equal(prepared.receipt.references[1]?.status, "missing");
		assert.deepEqual(prepared.receipt.projectContext, { inventory: "unknown", loaded: "unknown", truncation: "unknown" });
		assert.equal(prepared.receipt.lifecycle.modelDelivery, "unknown");
		assert.equal(prepared.receipt.lifecycle.state, "prepared");
	});
});

test("missing required context and deleted cwd fail before launch with actionable messages", async () => {
	await withTempDir((cwd) => {
		assert.throws(() => prepareContextDelivery(cwd, { required: ["missing.md"] }), /required context file 'missing.md' is missing/);
	});
	const deleted = path.join(os.tmpdir(), `pi-subagents-deleted-${process.pid}-${Date.now()}`);
	assert.throws(() => prepareContextDelivery(deleted), /working directory .* is unavailable/);
});

test("runSync rejects required context and deleted cwd before child startup", async () => {
	await withTempDir(async (cwd) => {
		const result = await runSync(cwd, [{ name: "worker" } as AgentConfig], "worker", "task", {
			runId: "context-preflight-test",
			cwd,
			contextFiles: { required: ["missing.md"] },
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /required context file 'missing.md' is missing/);
	});
	const deleted = path.join(os.tmpdir(), `pi-subagents-deleted-run-${process.pid}-${Date.now()}`);
	const result = await runSync(process.cwd(), [{ name: "worker" } as AgentConfig], "worker", "task", {
		runId: "deleted-cwd-test",
		cwd: deleted,
	});
	assert.equal(result.exitCode, 1);
	assert.match(result.error ?? "", /working directory .* is unavailable/);
});

test("async single preflights cwd and required context before creating recovery artifacts", async () => {
	await withTempDir((cwd) => {
		const runId = `context-preflight-${process.pid}-${Date.now()}`;
		const result = executeAsyncSingle(runId, {
			agent: "worker",
			agentConfig: { name: "worker" } as AgentConfig,
			ctx: { cwd, currentSessionId: "parent" } as never,
			cwd,
			task: "task",
			contextFiles: { required: ["missing.md"] },
		} as never);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /required context file 'missing.md' is missing/);
	});
});

test("required oversized or binary context fails; optional unsupported context is recorded without inclusion", async () => {
	await withTempDir((cwd) => {
		fs.writeFileSync(path.join(cwd, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
		fs.writeFileSync(path.join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
		assert.throws(() => prepareContextDelivery(cwd, { required: ["large.txt"] }), /no larger than 1048576 bytes/);
		assert.throws(() => prepareContextDelivery(cwd, { required: ["binary.bin"] }), /not valid UTF-8 text|binary data/);
		const optional = prepareContextDelivery(cwd, { optional: ["large.txt", "binary.bin"] });
		assert.equal(optional.prompt, "");
		assert.deepEqual(optional.receipt.references.map(({ status }) => status), ["unsupported", "unsupported"]);
	});
});

test("receipt writes are unique per child attempt and bind the task", async () => {
	await withTempDir((cwd) => {
		const a = prepareContextDelivery(cwd, {}, { runId: "run", childId: "child-1", task: "task" }).receipt;
		const b = prepareContextDelivery(cwd, {}, { runId: "run", childId: "child-2", task: "task" }).receipt;
		assert.notEqual(a.attemptId, b.attemptId);
		assert.equal(a.taskSha256, b.taskSha256);
		assert.equal(a.childId, "child-1");
		const firstPath = path.join(cwd, `run_child_${a.attemptId}_context-receipt.json`);
		const secondPath = path.join(cwd, `run_child_${b.attemptId}_context-receipt.json`);
		writeContextDeliveryReceipt(firstPath, a);
		writeContextDeliveryReceipt(secondPath, b);
		assert.equal(JSON.parse(fs.readFileSync(firstPath, "utf8")).childId, "child-1");
		assert.equal(JSON.parse(fs.readFileSync(secondPath, "utf8")).childId, "child-2");
	});
});

test("Pi's real project resource loader confirms availability without fabricating child loaded status", async () => {
	await withTempDir((cwd) => {
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "loader-visible instruction");
		const files = loadProjectContextFiles({ cwd, agentDir: path.join(cwd, "no-global-agent-dir") });
		assert.equal(files.length, 1);
		assert.match(files[0]!.content, /loader-visible instruction/);
		const receipt = prepareContextDelivery(cwd).receipt;
		assert.deepEqual(receipt.projectContext, { inventory: "unknown", loaded: "unknown", truncation: "unknown" });
	});
});
