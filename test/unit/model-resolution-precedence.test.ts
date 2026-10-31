import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerSteps, buildModelResolutionReceipts } from "../../src/runs/background/async-execution.ts";
import { flattenSteps } from "../../src/runs/shared/parallel-utils.ts";
import {
	formatModelResolutionReceipt,
	isDefaultedAgentModel,
	resolveEffectiveSubagentModel,
	resolveEffectiveSubagentModelWithSource,
} from "../../src/runs/shared/model-fallback.ts";
import type { AgentConfig, AgentModelSourceInfo } from "../../src/agents/agents.ts";

/**
 * The operator policy these tests pin: cheap workers (`openai-codex/gpt-6-luna`)
 * orchestrated by a strong parent session model. `subagents.defaultModel` is
 * applied when agents are *discovered*, before a run's context mode is known, so
 * on its own it drags fork children onto the cheap model and inverts the policy.
 * The fix is a precedence rule, tested here row by row.
 */
const parentModel = { provider: "ollama-cloud", id: "deepseek-v4.1-flash:1017" };
const parentFullId = "ollama-cloud/deepseek-v4.1-flash:1017";

const userDefaultSource: AgentModelSourceInfo = {
	type: "subagents.defaultModel",
	scope: "user",
	path: "/home/dev/.pi/agent/settings.json",
	model: "openai-codex/gpt-6-luna",
};

const agent = (name: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
	name,
	description: `${name} agent`,
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "You are a test agent.",
	source: "project",
	filePath: `${name}.md`,
	...overrides,
});

const ctx = {
	pi: {} as never,
	cwd: process.cwd(),
	currentSessionId: "session-1",
	currentModel: parentModel,
	currentModelProvider: parentModel.provider,
	modelScope: undefined,
};

describe("effective subagent model precedence", () => {
	it("row 1: a caller-supplied model wins over a declared one on a fork", () => {
		const resolution = resolveEffectiveSubagentModelWithSource(
			"openai-codex/gpt-6-luna",
			"anthropic/claude-sonnet-4",
			parentModel,
			undefined,
			parentModel.provider,
			{ forked: true, agentModelFromDefault: false },
		);
		assert.equal(resolution.model, "openai-codex/gpt-6-luna");
		assert.equal(resolution.source, "explicit");
	});

	it("row 2: a model declared on the agent wins on a fork, over the parent", () => {
		const resolution = resolveEffectiveSubagentModelWithSource(
			undefined,
			"anthropic/claude-sonnet-4",
			parentModel,
			undefined,
			parentModel.provider,
			{ forked: true, agentModelFromDefault: false },
		);
		// Naming a model on the agent is a decision about that agent, not a gap filler:
		// it must not be downgraded to the parent model just because the child forks.
		assert.equal(resolution.model, "anthropic/claude-sonnet-4");
		assert.equal(resolution.source, "agent");
	});

	it("row 3: a defaulted model loses to the parent on a fork", () => {
		const resolution = resolveEffectiveSubagentModelWithSource(
			undefined,
			"openai-codex/gpt-6-luna",
			parentModel,
			undefined,
			parentModel.provider,
			{ forked: true, agentModelFromDefault: true },
		);
		assert.equal(resolution.model, parentFullId);
		assert.equal(resolution.source, "fork-parent");
		// The requested model is still recorded: the receipt has to be able to say
		// which default was superseded.
		assert.equal(resolution.requested, "openai-codex/gpt-6-luna");
	});

	it("row 4: a defaulted model applies to a fresh child", () => {
		const resolution = resolveEffectiveSubagentModelWithSource(
			undefined,
			"openai-codex/gpt-6-luna",
			parentModel,
			undefined,
			parentModel.provider,
			{ forked: false, agentModelFromDefault: true },
		);
		assert.equal(resolution.model, "openai-codex/gpt-6-luna");
		assert.equal(resolution.source, "user-default");
	});

	it("row 5: nothing set inherits the parent session model, forked or fresh", () => {
		for (const forked of [true, false]) {
			const resolution = resolveEffectiveSubagentModelWithSource(undefined, undefined, parentModel, undefined, undefined, { forked });
			assert.equal(resolution.model, parentFullId);
			assert.equal(resolution.source, "parent-session");
		}
	});

	it("treats the inherit sentinel as no model at all", () => {
		const resolution = resolveEffectiveSubagentModelWithSource("inherit", "inherit", parentModel, undefined, parentModel.provider, {
			forked: false,
			agentModelFromDefault: true,
		});
		assert.equal(resolution.model, parentFullId);
		assert.equal(resolution.source, "parent-session");
	});

	it("keeps the plain resolver's answer identical for callers that pass no fork context", () => {
		assert.equal(
			resolveEffectiveSubagentModel(undefined, "openai-codex/gpt-6-luna", parentModel, undefined, parentModel.provider),
			"openai-codex/gpt-6-luna",
		);
		// Same call, but a fork: the default no longer wins.
		assert.equal(
			resolveEffectiveSubagentModel(undefined, "openai-codex/gpt-6-luna", parentModel, undefined, parentModel.provider, {
				forked: true,
				agentModelFromDefault: true,
			}),
			parentFullId,
		);
	});

	it("recognizes the recorded defaultModel provenance and nothing else", () => {
		assert.equal(isDefaultedAgentModel(userDefaultSource), true);
		assert.equal(isDefaultedAgentModel(undefined), false);
		assert.equal(isDefaultedAgentModel({ type: "frontmatter" }), false);
	});
});

describe("model resolution receipts", () => {
	it("names the model and the provenance for each shape", () => {
		const fresh = resolveEffectiveSubagentModelWithSource(undefined, "openai-codex/gpt-6-luna", parentModel, undefined, parentModel.provider, {
			forked: false,
			agentModelFromDefault: true,
		});
		assert.equal(formatModelResolutionReceipt("worker", fresh), "worker -> openai-codex/gpt-6-luna (user defaultModel)");

		const forked = resolveEffectiveSubagentModelWithSource(undefined, "openai-codex/gpt-6-luna", parentModel, undefined, parentModel.provider, {
			forked: true,
			agentModelFromDefault: true,
		});
		assert.equal(formatModelResolutionReceipt("planner", forked), `planner -> ${parentFullId} (fork: parent session)`);

		const declared = resolveEffectiveSubagentModelWithSource(undefined, "openai-codex/gpt-6-luna", parentModel, undefined, parentModel.provider, {
			forked: true,
			agentModelFromDefault: false,
		});
		assert.equal(formatModelResolutionReceipt("reviewer", declared), "reviewer -> openai-codex/gpt-6-luna (agent frontmatter)");
	});

	// A launch receipt must be readable in one glance: one line per child, in step
	// order, each naming the branch of the precedence rule that fired.
	it("is emitted one line per child, in step order, at async launch", () => {
		const built = buildAsyncRunnerSteps("run-receipt", {
			chain: [
				{ agent: "worker", task: "fresh child on the user default" },
				{ agent: "planner", task: "forked child on a defaulted model" },
				{ agent: "reviewer", task: "unresolved child" },
			],
			agents: [
				agent("worker", { model: "openai-codex/gpt-6-luna", modelSource: userDefaultSource }),
				agent("planner", { model: "openai-codex/gpt-6-luna", modelSource: userDefaultSource }),
				agent("reviewer"),
			],
			ctx,
			forked: false,
			asyncDir: path.join(process.cwd(), ".tmp-receipt-test"),
			maxSubagentDepth: 2,
			waitToolEnabled: false,
		});
		assert.ok("steps" in built, "expected a successful step build");

		const receipts = buildModelResolutionReceipts(built.steps);
		assert.deepEqual(receipts, [
			"worker -> openai-codex/gpt-6-luna (user defaultModel)",
			"planner -> openai-codex/gpt-6-luna (user defaultModel)",
			"reviewer -> ollama-cloud/deepseek-v4.1-flash:1017 (parent session)",
		]);
		const [first] = flattenSteps(built.steps);
		assert.deepEqual(first?.modelResolution, {
			requested: "openai-codex/gpt-6-luna",
			resolved: "openai-codex/gpt-6-luna",
			source: "user-default",
		});
	});

	it("skips steps that carry no resolution, so a resumed run never prints 'undefined'", () => {
		const steps = [{ agent: "legacy" } as unknown as Parameters<typeof buildModelResolutionReceipts>[0][number]];
		assert.deepEqual(buildModelResolutionReceipts(steps), []);
	});

	it("resolves mixed async chains per agent instead of using the run-level any-fork flag", () => {
		const built = buildAsyncRunnerSteps("run-mixed-fork", {
			chain: [
				{ agent: "planner", task: "forked planner" },
				{ agent: "worker", task: "fresh worker" },
			],
			agents: [
				agent("planner", { defaultContext: "fork", model: "openai-codex/gpt-6-luna", modelSource: userDefaultSource }),
				agent("worker", { defaultContext: "fresh", model: "openai-codex/gpt-6-luna", modelSource: userDefaultSource }),
			],
			ctx,
			forked: true,
			forkedAgents: ["planner"],
			asyncDir: path.join(process.cwd(), ".tmp-receipt-mixed-fork-test"),
			maxSubagentDepth: 2,
			waitToolEnabled: false,
		});
		assert.ok("steps" in built, "expected a successful step build");
		const steps = flattenSteps(built.steps);
		assert.equal(steps[0]?.model, parentFullId);
		assert.equal(steps[0]?.modelResolution?.source, "fork-parent");
		assert.equal(steps[1]?.model, "openai-codex/gpt-6-luna");
		assert.equal(steps[1]?.modelResolution?.source, "user-default");
	});

	it("preserves run-level fork behavior when forkedAgents is absent", () => {
		const built = buildAsyncRunnerSteps("run-legacy-fork", {
			chain: [
				{ agent: "planner", task: "forked planner" },
				{ agent: "worker", task: "also treated as forked for compatibility" },
			],
			agents: [
				agent("planner", { model: "openai-codex/gpt-6-luna", modelSource: userDefaultSource }),
				agent("worker", { model: "openai-codex/gpt-6-luna", modelSource: userDefaultSource }),
			],
			ctx,
			forked: true,
			asyncDir: path.join(process.cwd(), ".tmp-receipt-legacy-fork-test"),
			maxSubagentDepth: 2,
			waitToolEnabled: false,
		});
		assert.ok("steps" in built, "expected a successful step build");
		for (const step of flattenSteps(built.steps)) {
			assert.equal(step.model, parentFullId);
			assert.equal(step.modelResolution?.source, "fork-parent");
		}
	});

	it("requires the run-level fork flag even when a step is listed in forkedAgents", () => {
		const built = buildAsyncRunnerSteps("run-fork-flag", {
			chain: [{ agent: "planner", task: "listed but run is fresh" }],
			agents: [agent("planner", { model: "openai-codex/gpt-6-luna", modelSource: userDefaultSource })],
			ctx,
			forked: false,
			forkedAgents: ["planner"],
			asyncDir: path.join(process.cwd(), ".tmp-receipt-fork-flag-test"),
			maxSubagentDepth: 2,
			waitToolEnabled: false,
		});
		assert.ok("steps" in built, "expected a successful step build");
		const [step] = flattenSteps(built.steps);
		assert.equal(step?.model, "openai-codex/gpt-6-luna");
		assert.equal(step?.modelResolution?.source, "user-default");
	});

	it("records the fork override on the step so status.json and the receipt agree", () => {
		const built = buildAsyncRunnerSteps("run-fork", {
			chain: [{ agent: "planner", task: "forked child on a defaulted model" }],
			agents: [agent("planner", { model: "openai-codex/gpt-6-luna", modelSource: userDefaultSource })],
			ctx,
			forked: true,
			asyncDir: path.join(process.cwd(), ".tmp-receipt-fork-test"),
			maxSubagentDepth: 2,
			waitToolEnabled: false,
		});
		assert.ok("steps" in built, "expected a successful step build");
		const [step] = flattenSteps(built.steps);
		assert.equal(step?.model, parentFullId);
		assert.deepEqual(step?.modelResolution, {
			requested: "openai-codex/gpt-6-luna",
			resolved: parentFullId,
			source: "fork-parent",
		});
		assert.deepEqual(buildModelResolutionReceipts(built.steps), [`planner -> ${parentFullId} (fork: parent session)`]);
	});

	it("does not downgrade a declared model on a forked step", () => {
		const built = buildAsyncRunnerSteps("run-fork-declared", {
			chain: [{ agent: "reviewer", task: "forked child with a declared model" }],
			agents: [agent("reviewer", { model: "openai-codex/gpt-6-luna" })],
			ctx,
			forked: true,
			asyncDir: path.join(process.cwd(), ".tmp-receipt-declared-test"),
			maxSubagentDepth: 2,
			waitToolEnabled: false,
		});
		assert.ok("steps" in built, "expected a successful step build");
		const [declaredStep] = flattenSteps(built.steps);
		assert.equal(declaredStep?.model, "openai-codex/gpt-6-luna");
		assert.equal(declaredStep?.modelResolution?.source, "agent");
	});
});
