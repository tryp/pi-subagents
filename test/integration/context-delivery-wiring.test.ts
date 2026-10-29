import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { PI_SUBAGENT_PI_BINARY_ENV } from "../../src/runs/shared/pi-spawn.ts";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-wiring-"));
	try { await run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("runSync sends required context in the real child prompt and writes unique truthful receipts", async () => {
	await withTempDir(async (root) => {
		const cwd = path.join(root, "child-cwd");
		const wrongCwd = path.join(root, "chain-dir");
		const artifactsDir = path.join(root, "artifacts");
		fs.mkdirSync(cwd); fs.mkdirSync(wrongCwd);
		fs.writeFileSync(path.join(cwd, "required.md"), "distinctive required context: cedar-731");
		fs.writeFileSync(path.join(wrongCwd, "required.md"), "WRONG CHAIN DIRECTORY CONTENT");
		const capture = path.join(root, "args.jsonl");
		const binary = path.join(root, "fake-pi");
		fs.writeFileSync(binary, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");\nprocess.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"mock result"}],model:"mock/test",stopReason:"stop",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:{total:0}}}})+"\\n");\n`);
		fs.chmodSync(binary, 0o755);
		const previousBinary = process.env[PI_SUBAGENT_PI_BINARY_ENV];
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = binary;
		try {
			for (const [index, agent] of [[1, "alpha"], [2, "beta"], [1, "alpha"]] as const) {
				const result = await runSync(root, [{ name: agent, model: "test/model" } as AgentConfig], agent, "distinctive task: task-984", {
					runId: "receipt-wiring", cwd, index, artifactsDir,
					contextFiles: { required: ["required.md"], optional: ["absent-optional.md"] },
				});
				assert.equal(result.exitCode, 0, result.error ?? "fake child failed");
			}
			process.env[PI_SUBAGENT_PI_BINARY_ENV] = path.join(root, "no-such-child");
			const failedSpawn = await runSync(root, [{ name: "alpha", model: "test/model" } as AgentConfig], "alpha", "distinctive task: task-984", {
				runId: "receipt-wiring", cwd, index: 1, artifactsDir,
				contextFiles: { required: ["required.md"], optional: ["absent-optional.md"] },
			});
			assert.notEqual(failedSpawn.exitCode, 0, "a missing child executable should fail the run");
		} finally {
			if (previousBinary === undefined) delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
			else process.env[PI_SUBAGENT_PI_BINARY_ENV] = previousBinary;
		}
		const invocations = fs.readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; cwd: string });
		assert.equal(invocations.length, 3);
		assert.ok(invocations.every(({ args }) => args.join(" ").includes("distinctive required context: cedar-731")));
		assert.ok(invocations.every(({ args }) => args.join(" ").includes("distinctive task: task-984")));
		assert.ok(invocations.every(({ args }) => !args.some((arg) => arg.includes("WRONG CHAIN DIRECTORY CONTENT"))));
		assert.ok(invocations.every(({ cwd: actualCwd }) => actualCwd === cwd));
		const receipts = fs.readdirSync(artifactsDir).filter((name) => name.endsWith("_context-receipt.json"));
		assert.equal(receipts.length, 4);
		const docs = receipts.map((name) => JSON.parse(fs.readFileSync(path.join(artifactsDir, name), "utf8")) as Record<string, any>);
		assert.equal(new Set(docs.map((receipt) => receipt.attemptId)).size, 4);
		assert.deepEqual(new Set(docs.map((receipt) => receipt.childId)), new Set(["alpha:1", "beta:2"]));
		assert.ok(docs.every((receipt) => receipt.taskSha256 === docs[0].taskSha256));
		assert.ok(docs.every((receipt) => receipt.revision === null || typeof receipt.revision === "string"));
		assert.ok(docs.every((receipt) => receipt.version === 1 && receipt.runId === "receipt-wiring" && receipt.lifecycle.state === "prepared" && receipt.lifecycle.modelDelivery === "unknown"));
		assert.ok(docs.every((receipt) => receipt.references.some((item: { path: string; status: string }) => item.path.endsWith("absent-optional.md") && item.status === "missing")));
	});
});

test("async single refuses deleted cwd before runner or recovery artifacts, even without contextFiles", async () => {
	await withTempDir(async (root) => {
		const capture = path.join(root, "spawn-count");
		const binary = path.join(root, "fake-pi");
		fs.writeFileSync(binary, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(capture)}, "spawn\\n");\n`);
		fs.chmodSync(binary, 0o755);
		const previousBinary = process.env[PI_SUBAGENT_PI_BINARY_ENV];
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = binary;
		const missing = path.join(root, "deleted-cwd");
		try {
			const result = executeAsyncSingle(`missing-cwd-${process.pid}-${Date.now()}`, {
				agent: "worker", agentConfig: { name: "worker" } as AgentConfig,
				ctx: { cwd: root, currentSessionId: "parent" } as never,
				cwd: missing, task: "task",
			} as never);
			assert.equal(result.isError, true);
			assert.ok(!fs.existsSync(capture), "runner spawn counter must remain zero");
			const asyncRoot = path.join(os.homedir(), ".pi", "agent", "subagent-runs");
			assert.ok(!fs.existsSync(asyncRoot) || !fs.readdirSync(asyncRoot).some((name) => name.startsWith("missing-cwd-")));
		} finally {
			if (previousBinary === undefined) delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
			else process.env[PI_SUBAGENT_PI_BINARY_ENV] = previousBinary;
		}
	});
});
