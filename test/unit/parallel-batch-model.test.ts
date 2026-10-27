import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { ParallelTaskItem } from "../../src/shared/settings.ts";
import { resolveEffectiveSubagentModel } from "../../src/runs/shared/model-fallback.ts";

// Negative control: per-task model overrides already propagated correctly.
// The reported loss was a top-level model alongside tasks[], not tasks[].model;
// invocation-model.test.ts and its integration suite pin that normalization.
// This batch build seam also covers chain-embedded parallel entries, while the
// resolver assertions below pin the existing explicit > agent > parent order.

const availableModels = [
	{ provider: "openai-codex", id: "gpt-6-luna", fullId: "openai-codex/gpt-6-luna" },
	{ provider: "openai-codex", id: "gpt-6.1-terra", fullId: "openai-codex/gpt-6.1-terra" },
	{ provider: "zai", id: "glm-5.3-flash", fullId: "zai/glm-5.3-flash" },
];

const parentModel = { provider: "zai", id: "glm-5.3-flash" };

const agent = (name: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({
	name,
	description: `${name} agent`,
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "You are a test agent.",
	source: "project",
	filePath: `${name}.md`,
	...extra,
});

const ctx = {
	cwd: process.cwd(),
	currentSessionId: "session-parallel-model",
	currentModel: parentModel,
	currentModelProvider: "zai",
	modelScope: undefined,
};

type ParallelChild = {
	model?: string;
	thinking?: string;
	modelCandidates?: string[];
};

function buildParallelBatch(tasks: ParallelTaskItem[], agents: AgentConfig[], ctxOverride?: Record<string, unknown>): ParallelChild[] {
	const result = buildAsyncRunnerSteps("run-parallel-model", {
		chain: [{ parallel: tasks }],
		agents,
		ctx: (ctxOverride ?? ctx) as never,
		availableModels,
		asyncDir: path.join(process.cwd(), ".tmp-parallel-model-test"),
		maxSubagentDepth: 2,
		waitToolEnabled: false,
	});
	assert.ok("steps" in result, `expected a successful step build: ${"error" in result ? result.error : ""}`);
	const first = result.steps[0] as { parallel: ParallelChild[] } | undefined;
	assert.ok(first?.parallel, "expected a parallel step");
	return first.parallel;
}

describe("parallel batch model override propagation", () => {
	it("carries each task's model override into its own runner step, independently", () => {
		const parallel = buildParallelBatch(
			[
				{ agent: "probe-a", task: "A", model: "openai-codex/gpt-6-luna" },
				{ agent: "probe-b", task: "B", model: "openai-codex/gpt-6.1-terra" },
				{ agent: "probe-c", task: "C" },
			],
			[
				agent("probe-a"),
				// The agent config model must NOT beat the explicit task override.
				agent("probe-b", { model: "zai/glm-5.3-flash" }),
				agent("probe-c"),
			],
		);
		assert.equal(parallel[0]?.model, "openai-codex/gpt-6-luna");
		assert.equal(parallel[1]?.model, "openai-codex/gpt-6.1-terra");
		// Without an override the parent session model is inherited.
		assert.equal(parallel[2]?.model, "zai/glm-5.3-flash");
	});

	it("keeps the override as the primary model candidate, ahead of agent fallbacks", () => {
		const parallel = buildParallelBatch(
			[{ agent: "worker", task: "T", model: "openai-codex/gpt-6-luna" }],
			[agent("worker", { fallbackModels: ["zai/glm-5.3-flash", "openai-codex/gpt-6.1-terra"] })],
		);
		assert.equal(parallel[0]?.model, "openai-codex/gpt-6-luna");
		assert.deepEqual(
			parallel[0]?.modelCandidates,
			["openai-codex/gpt-6-luna", "zai/glm-5.3-flash", "openai-codex/gpt-6.1-terra"],
		);
	});

	it("resolves a bare task model id against the registry instead of passing it raw", () => {
		const parallel = buildParallelBatch(
			[{ agent: "worker", task: "T", model: "gpt-6-luna" }],
			[agent("worker")],
		);
		assert.equal(parallel[0]?.model, "openai-codex/gpt-6-luna");
		assert.equal(parallel[0]?.modelCandidates?.[0], "openai-codex/gpt-6-luna");
	});

	it("treats the inherit sentinel as parent-model inheritance, never the literal string", () => {
		const parallel = buildParallelBatch(
			[{ agent: "worker", task: "T", model: "inherit" }],
			[agent("worker")],
		);
		assert.equal(parallel[0]?.model, "zai/glm-5.3-flash");
		assert.ok(!parallel[0]?.modelCandidates?.includes("inherit"));
	});

	it("keeps a thinking-suffixed override on the model arg and derives thinking from the suffix", () => {
		const parallel = buildParallelBatch(
			[{ agent: "worker", task: "T", model: "openai-codex/gpt-6-luna:high" }],
			[agent("worker")],
		);
		assert.equal(parallel[0]?.model, "openai-codex/gpt-6-luna:high");
		assert.equal(parallel[0]?.thinking, "high");
	});

	it("emits no phantom model when neither the task, the agent config, nor the parent has one", () => {
		const noParentCtx = { ...ctx, currentModel: undefined, currentModelProvider: undefined };
		const parallel = buildParallelBatch(
			[{ agent: "worker", task: "T" }],
			[agent("worker")],
			noParentCtx,
		);
		assert.equal(parallel[0]?.model, undefined);
		assert.deepEqual(parallel[0]?.modelCandidates, []);
	});

	it("explicit override beats the agent config model even when the parent model is known", () => {
		// The precedence every batch shape composes: explicit > agent config > parent.
		assert.equal(
			resolveEffectiveSubagentModel("openai-codex/gpt-6-luna", "zai/glm-5.3-flash", parentModel, availableModels),
			"openai-codex/gpt-6-luna",
		);
		assert.equal(
			resolveEffectiveSubagentModel(undefined, "openai-codex/gpt-6.1-terra", parentModel, availableModels),
			"openai-codex/gpt-6.1-terra",
		);
		assert.equal(
			resolveEffectiveSubagentModel(undefined, undefined, parentModel, availableModels),
			"zai/glm-5.3-flash",
		);
	});
});
