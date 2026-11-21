import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findModelInfo, getSupportedThinkingLevels, resolveScopedModelInfo, splitKnownThinkingSuffix, toModelInfo, type ModelInfo } from "../../src/shared/model-info.ts";

describe("model info helpers", () => {
	const ambiguousModels: ModelInfo[] = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", reasoning: true, thinkingLevelMap: { high: "high" } },
		{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini", reasoning: true, thinkingLevelMap: { off: null, high: "high", xhigh: "xhigh" } },
	];
	const lunaModels: ModelInfo[] = ["amazon-bedrock", "openai-codex", "opencode", "opencode-go"].map((provider) => ({ provider, id: "gpt-6-luna", fullId: `${provider}/gpt-6-luna` }));

	it("does not choose arbitrary metadata for ambiguous bare model ids", () => {
		assert.equal(findModelInfo("gpt-5-mini", ambiguousModels), undefined);
	});

	it("uses the preferred provider for ambiguous bare model metadata", () => {
		assert.equal(findModelInfo("gpt-5-mini", ambiguousModels, "github-copilot")?.fullId, "github-copilot/gpt-5-mini");
	});

	it("matches provider-qualified model metadata before bare ids", () => {
		assert.equal(findModelInfo("openai/gpt-5-mini:high", ambiguousModels, "github-copilot")?.fullId, "openai/gpt-5-mini");
	});

	it("prefers the enabled provider when a bare id exists under four providers", () => {
		const models = ["amazon-bedrock", "openai-codex", "opencode", "opencode-go"].map((provider) => ({
			provider,
			id: "gpt-6-luna",
			fullId: `${provider}/gpt-6-luna`,
		}));
		const result = resolveScopedModelInfo("gpt-6-luna", models, { enabledModels: [models[1]!] });
		assert.equal(result.model?.fullId, "openai-codex/gpt-6-luna");
	});

	it("keeps qualified provider/model requests unchanged", () => {
		const result = resolveScopedModelInfo("opencode/gpt-6-luna", lunaModels, { enabledModels: [lunaModels[1]!] });
		assert.equal(result.model?.fullId, "opencode/gpt-6-luna");
	});

	it("rejects bare ids found only in unauthenticated providers", () => {
		const result = resolveScopedModelInfo("gpt-6-luna", lunaModels, { isAuthenticated: () => false });
		assert.match(result.error ?? "", /without configured credentials/);
		assert.equal(result.model, undefined);
	});

	it("deterministically resolves authenticated full-registry ambiguity with a warning", () => {
		const warnings: string[] = [];
		const result = resolveScopedModelInfo("gpt-6-luna", lunaModels, {
			isAuthenticated: () => true,
			onWarning: (message) => warnings.push(message),
		});
		assert.equal(result.model?.fullId, "amazon-bedrock/gpt-6-luna");
		assert.match(warnings[0] ?? "", /selected amazon-bedrock\/gpt-6-luna.*alternatives: openai-codex\/gpt-6-luna, opencode\/gpt-6-luna, opencode-go\/gpt-6-luna/);
	});

	it("preserves a thinking suffix while resolving a bare id", () => {
		const result = resolveScopedModelInfo("gpt-6-luna:high", lunaModels, { enabledModels: [lunaModels[1]!] });
		assert.equal(result.model?.fullId, "openai-codex/gpt-6-luna");
		assert.equal(result.thinkingSuffix, ":high");
	});

	it("preserves registry API metadata", () => {
		assert.equal(toModelInfo({ provider: "gateway", id: "model", api: "anthropic-messages" }).api, "anthropic-messages");
	});

	it("keeps the legacy thinking list for models without per-level metadata", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5", reasoning: true }),
			["off", "minimal", "low", "medium", "high", "xhigh"],
		);
		assert.deepEqual(getSupportedThinkingLevels(undefined), ["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("keeps the legacy thinking list when older model metadata omits reasoning", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" }),
			["off", "minimal", "low", "medium", "high", "xhigh"],
		);
	});

	it("filters levels only when per-level metadata is present", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "deepseek",
				id: "deepseek-v4-pro",
				fullId: "deepseek/deepseek-v4-pro",
				reasoning: true,
				thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
			}),
			["off", "high", "xhigh"],
		);
	});

	it("honors metadata that marks off unsupported", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "always-thinking",
				id: "model",
				fullId: "always-thinking/model",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" },
			}),
			["high"],
		);
	});

	it("honors an explicit max mapping and recognizes max suffixes", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "openai",
				id: "gpt-5",
				fullId: "openai/gpt-5",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" },
			}),
			["max"],
		);
		assert.deepEqual(
			splitKnownThinkingSuffix("openai/gpt-5:max"),
			{ baseModel: "openai/gpt-5", thinkingSuffix: ":max" },
		);
	});
});
