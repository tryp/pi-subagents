import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { isDefaultedAgentModel, resolveEffectiveSubagentModelWithSource } from "../../src/runs/shared/model-fallback.ts";

const parentModel = { provider: "ollama-cloud", id: "deepseek-v4.1-flash:1017" };
const userDefault = { provider: "openai-codex", id: "gpt-6-luna" };
const projectDefault = { provider: "anthropic", id: "claude-sonnet-4" };
const declaredModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
const availableModels = [parentModel, userDefault, projectDefault, declaredModel].map((model) => ({
	...model,
	fullId: `${model.provider}/${model.id}`,
}));

let tempDir = "";
let previousAgentDir: string | undefined;

function modelId(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function writeSettings(options: {
	userDefault?: string;
	projectDefault?: string;
	declaredModel?: string;
	defaultContext: "fresh" | "fork";
}): void {
	const agentHome = path.join(tempDir, "agent-home");
	fs.mkdirSync(agentHome, { recursive: true });
	fs.writeFileSync(path.join(agentHome, "settings.json"), JSON.stringify({
		subagents: options.userDefault ? { defaultModel: options.userDefault } : {},
	}));
	const projectPi = path.join(tempDir, ".pi");
	fs.mkdirSync(projectPi, { recursive: true });
	fs.writeFileSync(path.join(projectPi, "settings.json"), JSON.stringify({
		subagents: {
			...(options.projectDefault ? { defaultModel: options.projectDefault } : {}),
			agentOverrides: {
				worker: {
					defaultContext: options.defaultContext,
					...(options.declaredModel ? { model: options.declaredModel } : {}),
				},
			},
		},
	}));
}

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first?.text);
	return first.text;
}

function reportedModel(text: string): string | undefined {
	return /^  (.+)$/m.exec(text.split("Effective model:")[1] ?? "")?.[1]?.trim();
}

function runnerModel(agentName: string) {
	const agent = discoverAgentsAll(tempDir).builtin.find((entry) => entry.name === agentName);
	assert.ok(agent, `missing builtin ${agentName}`);
	return resolveEffectiveSubagentModelWithSource(
		undefined,
		agent.model,
		parentModel,
		availableModels,
		parentModel.provider,
		{
			forked: agent.defaultContext === "fork",
			agentModelFromDefault: isDefaultedAgentModel(agent.modelSource),
		},
	);
}

function modelsOutput() {
	return readText(handleManagementAction("models", { agent: "worker" }, {
		cwd: tempDir,
		model: parentModel,
		modelRegistry: { getAvailable: () => availableModels, getAll: () => availableModels },
	}));
}

describe("models report / runner model consistency", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-model-report-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("reports the runner's effective model for declared/defaulted models across fork contexts and default scopes", () => {
		const cases = [
			{
				name: "user default on fork",
				settings: { userDefault: modelId(userDefault), defaultContext: "fork" as const },
				expected: modelId(parentModel),
			},
			{
				name: "user default on fresh child",
				settings: { userDefault: modelId(userDefault), defaultContext: "fresh" as const },
				expected: modelId(userDefault),
			},
			{
				name: "project default on fork",
				settings: { projectDefault: modelId(projectDefault), defaultContext: "fork" as const },
				expected: modelId(parentModel),
			},
			{
				name: "project default on fresh child",
				settings: { projectDefault: modelId(projectDefault), defaultContext: "fresh" as const },
				expected: modelId(projectDefault),
			},
			{
				name: "project default overrides the user default on a fresh child",
				settings: {
					userDefault: modelId(userDefault),
					projectDefault: modelId(projectDefault),
					defaultContext: "fresh" as const,
				},
				expected: modelId(projectDefault),
			},
			{
				name: "declared model on fork",
				settings: { declaredModel: modelId(declaredModel), defaultContext: "fork" as const },
				expected: modelId(declaredModel),
			},
			{
				name: "declared model on fresh child",
				settings: { declaredModel: modelId(declaredModel), defaultContext: "fresh" as const },
				expected: modelId(declaredModel),
			},
			{
				name: "no default on fork inherits parent",
				settings: { defaultContext: "fork" as const },
				expected: modelId(parentModel),
			},
			{
				name: "no default on fresh child inherits parent",
				settings: { defaultContext: "fresh" as const },
				expected: modelId(parentModel),
			},
		];

		for (const testCase of cases) {
			writeSettings(testCase.settings);
			const text = modelsOutput();
			const reported = reportedModel(text);
			const launched = runnerModel("worker").model;
			assert.equal(reported, launched, `${testCase.name}: models reports ${String(reported)}, runner resolves ${String(launched)}\n${text}`);
			assert.equal(reported, testCase.expected, `${testCase.name}: unexpected resolved model`);
		}
	});
});
