import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyInvocationModelDefaults } from "../../src/runs/shared/invocation-model.ts";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import type { SubagentParamsLike } from "../../src/runs/foreground/subagent-executor.ts";
import { isDynamicParallelStep, isParallelStep } from "../../src/shared/settings.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const model = "openai-codex/gpt-6-luna:high";
const override = "openai-codex/gpt-6.1-terra";

describe("invocation model defaults", () => {
	it("defaults tasks without mutating caller input; explicit inherit and entry models win", () => {
		const params = { model, tasks: [{ agent: "probe", task: "default" }, { agent: "probe", task: "explicit", model: override }, { agent: "probe", task: "parent", model: "inherit" }] };
		const before = structuredClone(params);
		const result = applyInvocationModelDefaults(params);
		assert.deepEqual(result.tasks.map((task) => task.model), [model, override, "inherit"]);
		assert.deepEqual(params, before);
	});

	it("defaults sequential steps, embedded parallel children and dynamic templates independently", () => {
		const params: SubagentParamsLike = {
			model,
			chain: [
				{ agent: "probe", task: "sequential" },
				{ agent: "probe", task: "explicit", model: override },
				{ parallel: [{ agent: "probe", task: "parallel" }, { agent: "probe", task: "parent", model: "inherit" }], concurrency: 2 },
				{ expand: { from: { output: "plan", path: "/items" } }, parallel: { agent: "probe", task: "dynamic {item}" }, collect: { as: "dynamic" } },
				{ expand: { from: { output: "plan", path: "/items" } }, parallel: { agent: "probe", task: "explicit {item}", model: override }, collect: { as: "explicit" } },
			],
		};
		const before = structuredClone(params);
		const result = applyInvocationModelDefaults(params);
		assert.deepEqual(result.chain?.map((step) => isParallelStep(step) ? step.parallel.map((task) => task.model) : isDynamicParallelStep(step) ? step.parallel.model : step.model), [model, override, [model, "inherit"], model, override]);
		assert.deepEqual(params, before);
	});

	it("omission is a no-op, leaving agent/parent resolution to existing code", () => {
		const params = { tasks: [{ agent: "probe", task: "T" }] };
		assert.equal(applyInvocationModelDefaults(params), params);
	});

	it("single-agent launches keep their original shape", () => {
		const params = { agent: "probe", task: "T", model };
		assert.deepEqual(applyInvocationModelDefaults(params), params);
	});

	it("keeps top-level inherit as a raw sentinel even when the agent has a model", () => {
		const params: SubagentParamsLike = { model: "inherit", tasks: [{ agent: "probe", task: "T" }] };
		const result = applyInvocationModelDefaults(params);
		assert.equal(result.tasks?.[0]?.model, "inherit");
	});

	it("materializes the default into async runner model, thinking and fallback candidates", () => {
		const params = applyInvocationModelDefaults({ model, chain: [{ parallel: [{ agent: "probe", task: "T" }] }] });
		const agent: AgentConfig = { name: "probe", description: "probe", systemPrompt: "probe", source: "project", filePath: "probe.md", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false, model: "zai/glm-5.3-flash", fallbackModels: [override] };
		const result = buildAsyncRunnerSteps("invocation-default", {
			chain: params.chain, agents: [agent],
			ctx: { pi: {} as never, cwd: process.cwd(), currentSessionId: "test-invocation-model", currentModel: { provider: "zai", id: "glm-5.3-flash" }, currentModelProvider: "zai" },
			availableModels: [
				{ provider: "openai-codex", id: "gpt-6-luna", fullId: "openai-codex/gpt-6-luna" },
				{ provider: "openai-codex", id: "gpt-6.1-terra", fullId: override },
				{ provider: "zai", id: "glm-5.3-flash", fullId: "zai/glm-5.3-flash" },
			],
			asyncDir: "tmp/invocation-model-unit", maxSubagentDepth: 2, waitToolEnabled: false,
		});
		assert.ok("steps" in result);
		const step = result.steps[0];
		assert.ok(step && "parallel" in step && Array.isArray(step.parallel));
		assert.equal(step.parallel[0]?.model, model);
		assert.equal(step.parallel[0]?.thinking, "high");
		assert.deepEqual(step.parallel[0]?.modelCandidates, [model, override]);
	});
});
