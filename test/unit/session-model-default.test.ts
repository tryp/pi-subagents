import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionModelDefaultStore } from "../../src/runs/shared/session-model-default.ts";
import { applyInvocationModelDefaults } from "../../src/runs/shared/invocation-model.ts";
import type { SubagentParamsLike } from "../../src/runs/foreground/subagent-executor.ts";
import { isDynamicParallelStep, isParallelStep } from "../../src/shared/settings.ts";
import { formatModelResolutionReceipt, resolveEffectiveSubagentModelWithSource } from "../../src/runs/shared/model-fallback.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

describe("session model default", () => {
	it("sets, reports, clears, and isolates defaults by normalized cwd", () => {
		const store = new SessionModelDefaultStore();
		store.set("/tmp/work/../work", "openai-codex/gpt-6-luna");
		assert.equal(store.get("/tmp/work"), "openai-codex/gpt-6-luna");
		assert.equal(store.get("/tmp/other"), undefined);
		store.set("/tmp/work", "inherit");
		assert.equal(store.get("/tmp/work"), "inherit");
		store.set("/tmp/work", undefined);
		assert.equal(store.get("/tmp/work"), undefined);
	});

	it("leaves invocation untouched when unset and propagates session default without replacing explicit entries", () => {
		const omitted: SubagentParamsLike = { agent: "worker", task: "T" };
		assert.equal(applyInvocationModelDefaults(omitted), omitted);
		const params: SubagentParamsLike = {
			model: "openai-codex/gpt-6-luna",
			modelSource: "session-default" as const,
			tasks: [{ agent: "worker", task: "default" }, { agent: "reviewer", task: "explicit", model: "inherit" }],
			chain: [
				{ agent: "worker", task: "sequential" },
				{ parallel: [{ agent: "worker", task: "parallel" }], concurrency: 2 },
				{ expand: { from: { output: "plan", path: "/items" } }, parallel: { agent: "worker", task: "dynamic" }, collect: { as: "results" } },
			],
		};
		const result = applyInvocationModelDefaults(params);
		assert.equal(result.tasks?.[0]?.model, "openai-codex/gpt-6-luna");
		assert.equal(result.tasks?.[0]?.modelSource, "session-default");
		assert.equal(result.tasks?.[1]?.model, "inherit");
		const sequential = result.chain?.[0];
		assert.ok(sequential && !isParallelStep(sequential) && !isDynamicParallelStep(sequential));
		assert.equal(sequential.model, "openai-codex/gpt-6-luna");
		assert.equal(sequential.modelSource, "session-default");
		const parallel = result.chain?.[1];
		assert.ok(parallel && isParallelStep(parallel));
		assert.equal(parallel.parallel[0]?.model, "openai-codex/gpt-6-luna");
		const dynamic = result.chain?.[2];
		assert.ok(dynamic && isDynamicParallelStep(dynamic));
		assert.equal(dynamic.parallel.model, "openai-codex/gpt-6-luna");
	});

	it("resolves session-default before agent frontmatter, while a call-level model remains higher", () => {
		const parent = { provider: "ollama-cloud", id: "flash" };
		const available = [
			{ provider: "openai-codex", id: "gpt-6-luna", fullId: "openai-codex/gpt-6-luna" },
			{ provider: "zai", id: "glm", fullId: "zai/glm" },
		];
		const agent: AgentConfig = { name: "worker", description: "worker", systemPrompt: "worker", source: "project", filePath: "worker.md", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false, model: "zai/glm" };
		const defaultResolution = resolveEffectiveSubagentModelWithSource(
			"openai-codex/gpt-6-luna", agent.model, parent, available, undefined, { modelSource: "session-default" },
		);
		assert.equal(defaultResolution.model, "openai-codex/gpt-6-luna");
		assert.equal(defaultResolution.source, "session-default");
		assert.match(formatModelResolutionReceipt("worker", defaultResolution), /session default/);
		const explicit = resolveEffectiveSubagentModelWithSource(
			"zai/glm", agent.model, parent, available,
		);
		assert.equal(explicit.model, "zai/glm");
		assert.equal(explicit.source, "explicit");
		const inherited = resolveEffectiveSubagentModelWithSource(
			"inherit", agent.model, parent, available, undefined, { forked: true },
		);
		assert.equal(inherited.model, "ollama-cloud/flash");
		const forkedDefault = resolveEffectiveSubagentModelWithSource(
			"openai-codex/gpt-6-luna", agent.model, parent, available, undefined, { modelSource: "session-default", forked: true },
		);
		assert.equal(forkedDefault.model, "openai-codex/gpt-6-luna");
		assert.equal(forkedDefault.source, "session-default");
		const inheritedDefault = resolveEffectiveSubagentModelWithSource(
			"inherit", agent.model, parent, available, undefined, { modelSource: "session-default", forked: true },
		);
		assert.equal(inheritedDefault.model, "ollama-cloud/flash");
		assert.equal(inheritedDefault.source, "session-default");
	});
});
