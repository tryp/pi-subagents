import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { prepareContextDelivery } from "../../src/runs/shared/context-delivery.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";

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
		assert.deepEqual(prepared.receipt.projectContext, { loaded: "unknown", truncation: "unknown" });
	});
});

test("missing required context and deleted cwd fail before launch with actionable messages", async () => {
	await withTempDir((cwd) => {
		assert.throws(() => prepareContextDelivery(cwd, { required: ["missing.md"] }), /required context file 'missing.md' is unavailable/);
	});
	const deleted = path.join(os.tmpdir(), `pi-subagents-deleted-${process.pid}-${Date.now()}`);
	assert.throws(() => prepareContextDelivery(deleted), /working directory .* is unavailable/);
});

test("runSync rejects required context and deleted cwd before child startup", async () => {
	withTempDir(async (cwd) => {
		const result = await runSync(cwd, [{ name: "worker" } as AgentConfig], "worker", "task", {
			runId: "context-preflight-test",
			cwd,
			contextFiles: { required: ["missing.md"] },
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /required context file 'missing.md' is unavailable/);
	});
	const deleted = path.join(os.tmpdir(), `pi-subagents-deleted-run-${process.pid}-${Date.now()}`);
	const result = await runSync(process.cwd(), [{ name: "worker" } as AgentConfig], "worker", "task", {
		runId: "deleted-cwd-test",
		cwd: deleted,
	});
	assert.equal(result.exitCode, 1);
	assert.match(result.error ?? "", /working directory .* is unavailable/);
});

test("Pi's real project resource loader confirms availability without fabricating child loaded status", async () => {
	await withTempDir((cwd) => {
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "loader-visible instruction");
		const files = loadProjectContextFiles({ cwd, agentDir: path.join(cwd, "no-global-agent-dir") });
		assert.equal(files.length, 1);
		assert.match(files[0]!.content, /loader-visible instruction/);
		const receipt = prepareContextDelivery(cwd).receipt;
		assert.deepEqual(receipt.projectContext, { loaded: "unknown", truncation: "unknown" });
	});
});
