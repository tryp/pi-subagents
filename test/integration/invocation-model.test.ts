import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { readPendingChainAppendRequests } from "../../src/runs/background/chain-append.ts";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSubagentExecutor, type SubagentParamsLike } from "../../src/runs/foreground/subagent-executor.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, makeMinimalCtx, type MockPi } from "../support/helpers.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const parentModel = { provider: "zai", id: "glm-5.3-flash" };
const batchModel = "openai-codex/gpt-6-luna";
const entryModel = "openai-codex/gpt-6.1-terra";
const available = [parentModel, { provider: "openai-codex", id: "gpt-6-luna" }, { provider: "openai-codex", id: "gpt-6.1-terra" }];
const tasks = [
	{ agent: "probe", task: "batch-default" },
	{ agent: "probe", task: "entry-override", model: entryModel },
	{ agent: "probe", task: "parent-inherit", model: "inherit" },
];

// Exercise the public executor, not just a model resolver: these assertions see
// the actual --model args of spawned mock children. No provider calls are made.
describe("invocation model defaults reach spawned children", () => {
	let root: string;
	let mockPi: MockPi;
	const runIds: string[] = [];

	beforeEach(() => {
		fs.mkdirSync("tmp", { recursive: true });
		root = fs.mkdtempSync(path.resolve("tmp/invocation-model-"));
		mockPi = createMockPi();
		mockPi.install();
		mockPi.onCall({ output: "probe complete" });
	});

	afterEach(() => {
		for (const id of runIds.splice(0)) {
			fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
			fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
		}
		mockPi.uninstall();
		fs.rmSync(root, { recursive: true, force: true });
	});

	async function launch(params: SubagentParamsLike): Promise<void> {
		const agent: AgentConfig = {
			name: "probe", description: "Model probe", systemPrompt: "Return a short response.",
			systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false,
			source: "project", filePath: path.join(root, "probe.md"), model: entryModel,
		};
		const executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined } as never,
			state: { baseCwd: root, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null } as never,
			config: {}, asyncByDefault: false, tempArtifactsDir: root,
			getSubagentSessionRoot: () => root, expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [agent] }),
		});
		const ctx = { ...makeMinimalCtx(root), model: parentModel, modelRegistry: { getAvailable: () => available } };
		const result = await executor.execute("invocation-model", { context: "fresh", artifacts: false, ...params }, new AbortController().signal, undefined, ctx as never);
		assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify(result.content));
		if (params.async) {
			const id = result.details?.asyncId;
			assert.ok(id, "async launch must detach, not silently run in foreground");
			runIds.push(id);
			const resultPath = path.join(RESULTS_DIR, `${id}.json`);
			// Same runner/result-file backstop used by async-execution.test.ts.
			const deadline = Date.now() + 15_000;
			while (!fs.existsSync(resultPath)) {
				assert.ok(Date.now() < deadline, `runner did not publish ${resultPath}`);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf8"));
			assert.equal(payload.success, true, JSON.stringify(payload));
		}
	}

	function assertSpawnModel(task: string, model: string): void {
		const calls = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.map((name) => JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf8")) as { args: string[] });
		const call = calls.find(({ args }) => args.some((arg) => arg.includes(task)));
		assert.ok(call, `missing spawned child for ${task}`);
		assert.equal(call.args[call.args.indexOf("--model") + 1], model, task);
	}

	for (const async of [false, true]) {
		for (const shape of ["parallel", "sequential chain", "embedded parallel"] as const) {
			it(`${async ? "async" : "foreground"} ${shape}: batch default applies and entry overrides win`, async () => {
				const params: SubagentParamsLike = { model: batchModel, async };
				if (shape === "parallel") {
					// Match the reported call shape, which also carried top-level agent.
					params.agent = "probe";
					params.tasks = tasks;
				} else params.chain = shape === "sequential chain" ? tasks : [{ parallel: tasks }];
				await launch(params);
				assertSpawnModel("batch-default", batchModel);
				assertSpawnModel("entry-override", entryModel);
				assertSpawnModel("parent-inherit", "zai/glm-5.3-flash");
			});
		}
	}

	for (const async of [false, true]) {
		it(`${async ? "async" : "foreground"} dynamic fanout materializes the batch default`, async () => {
			mockPi.reset();
			const producer = { output: "targets", structuredOutput: { items: ["alpha", "beta"] } };
			mockPi.onCall(producer);
			mockPi.onCall({ output: "child complete" });
			await launch({ model: batchModel, async, chain: [
				{ agent: "probe", task: "produce-targets", as: "targets", outputSchema: { type: "object" } },
				{ expand: { from: { output: "targets", path: "/items" }, maxItems: 2 }, parallel: { agent: "probe", task: "dynamic-{item}" }, collect: { as: "answers" } },
			] });
			assert.equal(mockPi.callCount(), 3);
			assertSpawnModel("dynamic-alpha", batchModel);
			assertSpawnModel("dynamic-beta", batchModel);
		});
	}

	for (const shape of ["sequential", "parallel", "dynamic"] as const) {
		it(`append-step ${shape} honors the invocation model and explicit entries`, async () => {
			const id = randomUUID();
			runIds.push(id);
			const asyncDir = path.join(ASYNC_DIR, id);
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: id, mode: "chain", state: "running", startedAt: Date.now(), cwd: root,
				steps: [{ agent: "probe", status: "running", outputName: "targets" }],
			}));
			const chain: NonNullable<SubagentParamsLike["chain"]> = shape === "sequential"
				? [tasks[0]!]
				: shape === "parallel" ? [{ parallel: tasks }]
				: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 2 }, parallel: tasks[0]!, collect: { as: "answers" } }];
			await launch({ action: "append-step", id, model: batchModel, chain });
			const requests = readPendingChainAppendRequests(asyncDir);
			assert.equal(requests.length, 1);
			const step = requests[0]!.steps[0]!;
			const children = "parallel" in step ? (Array.isArray(step.parallel) ? step.parallel : [step.parallel]) : [step];
			assert.deepEqual(children.map((child) => child.model), shape === "parallel"
				? [batchModel, entryModel, "zai/glm-5.3-flash"] : [batchModel]);
			assert.equal(mockPi.callCount(), 0, "append queues runner steps without launching a child immediately");
		});
	}

	it("foreground counted tasks inherit a thinking-suffixed batch model", async () => {
		await launch({ model: `${batchModel}:high`, async: false, tasks: [{ agent: "probe", task: "counted-default", count: 2 }] });
		assert.equal(mockPi.callCount(), 2);
		// The CLI accepts the thinking suffix on --model directly.
		assertSpawnModel("counted-default", `${batchModel}:high`);
	});

	it("top-level inherit requests the parent model ahead of the agent config", async () => {
		await launch({ model: "inherit", async: false, tasks: [{ agent: "probe", task: "batch-inherit" }] });
		assertSpawnModel("batch-inherit", "zai/glm-5.3-flash");
	});

	it("omitting the batch model preserves agent model resolution", async () => {
		await launch({ async: false, tasks: [{ agent: "probe", task: "agent-default" }] });
		assertSpawnModel("agent-default", entryModel);
	});
});
