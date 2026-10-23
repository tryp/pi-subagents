import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";
import { createMainWatchdogReview, resolveWatchdogReviewModel } from "../../src/watchdog/review.ts";
import type { WatchdogReviewRequest } from "../../src/watchdog/runtime.ts";
import type { ResolvedWatchdogConfig, WatchdogWarning } from "../../src/watchdog/types.ts";

function model(provider: string, id: string, overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id,
		name: id,
		api: "faux",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
		...overrides,
	};
}

function cloneConfig(): ResolvedWatchdogConfig {
	return {
		...DEFAULT_WATCHDOG_CONFIG,
		guidance: { ...DEFAULT_WATCHDOG_CONFIG.guidance },
		autoFollow: { ...DEFAULT_WATCHDOG_CONFIG.autoFollow },
		main: { ...DEFAULT_WATCHDOG_CONFIG.main },
		children: {
			...DEFAULT_WATCHDOG_CONFIG.children,
			autoFollow: { ...DEFAULT_WATCHDOG_CONFIG.children.autoFollow },
			overrides: { ...DEFAULT_WATCHDOG_CONFIG.children.overrides },
		},
		asyncCompletion: { ...DEFAULT_WATCHDOG_CONFIG.asyncCompletion },
		lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp },
	};
}

function enabledConfig(main: Partial<ResolvedWatchdogConfig["main"]> = {}): ResolvedWatchdogConfig {
	const config = cloneConfig();
	config.enabled = true;
	config.main = { ...config.main, enabled: true, ...main };
	return config;
}

function createCtx(input: {
	current?: Model<any>;
	models?: Model<any>[];
	authenticated?: string[];
	thinkingLevel?: string;
	sessionId?: string | null;
	authHeaders?: Record<string, string>;
}) {
	const allModels = input.models ?? (input.current ? [input.current] : []);
	const authenticated = new Set(input.authenticated ?? allModels.map((entry) => `${entry.provider}/${entry.id}`));
	return {
		cwd: "/tmp/watchdog-review",
		sessionManager: { getSessionId: () => input.sessionId === undefined ? "parent-session-1" : input.sessionId },
		model: input.current,
		...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		signal: undefined,
		getSystemPrompt: () => "Parent system prompt",
		modelRegistry: {
			getAvailable: () => allModels.filter((entry) => authenticated.has(`${entry.provider}/${entry.id}`)),
			find: (provider: string, id: string) => allModels.find((entry) => entry.provider === provider && entry.id === id),
			hasConfiguredAuth: (entry: Model<any>) => authenticated.has(`${entry.provider}/${entry.id}`),
			getApiKeyAndHeaders: async (entry: Model<any>) => authenticated.has(`${entry.provider}/${entry.id}`)
				? { ok: true as const, apiKey: `key-${entry.provider}-${entry.id}`, headers: input.authHeaders ?? { "x-model": entry.id }, env: { WATCHDOG_PROVIDER: entry.provider } }
				: { ok: false as const, error: `No auth for ${entry.provider}/${entry.id}` },
		},
	} as never;
}

function responseStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			stream.push({ type: "done", reason: message.stopReason, message });
		}
	});
	return stream;
}

function createStreamFn(responses: AssistantMessage[]) {
	const calls: Array<{ model: Model<any>; context: Context; options?: SimpleStreamOptions }> = [];
	const streamFn: StreamFn = (nextModel, context, options) => {
		calls.push({ model: nextModel, context, options });
		return responseStream(responses.shift() ?? fauxAssistantMessage("done", { stopReason: "stop" }));
	};
	return { streamFn, calls };
}

function request(config: ResolvedWatchdogConfig, warnings: WatchdogWarning[]): WatchdogReviewRequest {
	return {
		delta: "Assistant changed src/example.ts and said tests passed.",
		epoch: 1,
		reviewId: 7,
		config,
		emitWarning(warning) {
			warnings.push(warning);
			return true;
		},
	};
}

describe("main watchdog review adapter", () => {
	it("ignores clean freeform review text and emits no warnings", async () => {
		const current = model("openai", "gpt-clean");
		const ctx = createCtx({ current });
		const { streamFn } = createStreamFn([fauxAssistantMessage("No concerns.", { stopReason: "stop" })]);
		const warnings: WatchdogWarning[] = [];

		const result = await createMainWatchdogReview(ctx, { streamFn })(request(enabledConfig(), warnings));

		assert.deepEqual(warnings, []);
		assert.equal(result?.stopReason, "stop");
	});

	it("records watchdog_warn emissions through the runtime seam", async () => {
		const current = model("opencode", "gpt-warning");
		const ctx = createCtx({ current });
		const { streamFn, calls } = createStreamFn([
			fauxAssistantMessage(fauxToolCall("watchdog_warn", {
				severity: "blocker",
				category: "correctness",
				confidence: "high",
				summary: "The test claim is unverified",
				evidence: "The delta says tests passed but no test command appears.",
				recommendedAction: "Run the focused test before accepting the result.",
			}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);
		const warnings: WatchdogWarning[] = [];

		await createMainWatchdogReview(ctx, { streamFn })(request(enabledConfig(), warnings));

		assert.equal(warnings.length, 1);
		assert.equal(calls[0]?.options?.sessionId, "parent-session-1");
		assert.equal(calls[1]?.options?.sessionId, "parent-session-1");
		assert.deepEqual(warnings[0], {
			severity: "blocker",
			category: "correctness",
			confidence: "high",
			source: "main",
			summary: "The test claim is unverified",
			evidence: "The delta says tests passed but no test command appears.",
			recommendedAction: "Run the focused test before accepting the result.",
		});
	});

	it("does not start the agent stream when the review request signal is already aborted", async () => {
		const current = model("openai", "gpt-pre-abort");
		const ctx = createCtx({ current });
		const controller = new AbortController();
		controller.abort();
		let streamStarted = false;
		const streamFn: StreamFn = () => {
			streamStarted = true;
			return responseStream(fauxAssistantMessage("should not start", { stopReason: "stop" }));
		};
		const warnings: WatchdogWarning[] = [];

		const result = await createMainWatchdogReview(ctx, { streamFn })(
			{ ...request(enabledConfig(), warnings), signal: controller.signal },
		);

		assert.equal(streamStarted, false);
		assert.equal(result?.stopReason, "aborted");
	});

	it("does not start the agent stream when the review request aborts during model setup", async () => {
		const current = model("openai", "gpt-setup-abort");
		const controller = new AbortController();
		let releaseAuth!: () => void;
		const authStarted = new Promise<void>((resolve) => { releaseAuth = resolve; });
		let streamStarted = false;
		const ctx = {
			...createCtx({ current }),
			modelRegistry: {
				...createCtx({ current }).modelRegistry,
				async getApiKeyAndHeaders(entry: Model<any>) {
					await authStarted;
					return { ok: true as const, apiKey: `key-${entry.provider}-${entry.id}` };
				},
			},
		} as never;
		const streamFn: StreamFn = () => {
			streamStarted = true;
			return responseStream(fauxAssistantMessage("should not start", { stopReason: "stop" }));
		};
		const warnings: WatchdogWarning[] = [];

		const review = createMainWatchdogReview(ctx, { streamFn })(
			{ ...request(enabledConfig(), warnings), signal: controller.signal },
		);
		controller.abort();
		releaseAuth();
		const result = await review;

		assert.equal(streamStarted, false);
		assert.equal(result?.stopReason, "aborted");
	});

	it("aborts the underlying agent stream when the review request signal aborts", async () => {
		const current = model("openai", "gpt-abort");
		const ctx = createCtx({ current });
		const controller = new AbortController();
		let streamStarted!: () => void;
		let streamAborted = false;
		const started = new Promise<void>((resolve) => { streamStarted = resolve; });
		const streamFn: StreamFn = (_nextModel, _context, options) => {
			const stream = createAssistantMessageEventStream();
			options?.signal?.addEventListener("abort", () => {
				streamAborted = true;
				stream.push({ type: "error", reason: "aborted", error: fauxAssistantMessage("aborted", { stopReason: "aborted" }) });
			}, { once: true });
			streamStarted();
			return stream;
		};
		const warnings: WatchdogWarning[] = [];

		const review = createMainWatchdogReview(ctx, { streamFn })(
			{ ...request(enabledConfig(), warnings), signal: controller.signal },
		);
		await started;
		controller.abort();
		const result = await review;

		assert.equal(streamAborted, true);
		assert.equal(result?.stopReason, "aborted");
	});

	it("does not expose mutating tools to the watchdog agent", async () => {
		const current = model("openai", "gpt-readonly");
		const ctx = createCtx({ current });
		const { streamFn, calls } = createStreamFn([
			fauxAssistantMessage(fauxToolCall("bash", { command: "touch should-not-run" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);
		const warnings: WatchdogWarning[] = [];

		await createMainWatchdogReview(ctx, { streamFn })(request(enabledConfig(), warnings));

		assert.equal(warnings.length, 0);
		assert.deepEqual(calls[0]?.context.tools?.map((tool) => tool.name).sort(), ["find", "grep", "ls", "read", "watchdog_warn"]);
		const toolResult = calls[1]?.context.messages.find((message) => message.role === "toolResult" && message.toolName === "bash");
		assert.equal(toolResult?.isError, true);
	});

	it("fails loudly for explicit unauthenticated watchdog models", async () => {
		const current = model("openai", "gpt-current");
		const watchdog = model("anthropic", "claude-watchdog");
		const ctx = createCtx({ current, models: [current, watchdog], authenticated: [`${current.provider}/${current.id}`] });

		await assert.rejects(
			() => resolveWatchdogReviewModel(ctx, enabledConfig({ model: "anthropic/claude-watchdog" })),
			/authenticated.*anthropic/s,
		);
	});

	it("fails loudly for explicit missing watchdog models", async () => {
		const current = model("openai", "gpt-current");
		const ctx = createCtx({ current });

		await assert.rejects(
			() => resolveWatchdogReviewModel(ctx, enabledConfig({ model: "anthropic/missing-watchdog" })),
			/was not found.*anthropic\/missing-watchdog/s,
		);
	});

	it("passes OpenCode session attribution to every auxiliary stream without leaking it to unrelated providers", async () => {
		const warnings: WatchdogWarning[] = [];
		const openCode = model("opencode", "review");
		const customOpenCode = model("custom", "review", { baseUrl: "https://opencode.ai/v1" });
		const unrelated = model("custom", "review", { baseUrl: "https://not-opencode.ai/v1" });
		for (const selected of [openCode, customOpenCode, unrelated]) {
			const { streamFn, calls } = createStreamFn([fauxAssistantMessage("done", { stopReason: "stop" })]);
			const ctx = createCtx({ current: selected, sessionId: "stable-session" });
			await createMainWatchdogReview(ctx, { streamFn })(request(enabledConfig(), warnings));
			const options = calls[0]?.options;
			if (selected === unrelated) {
				assert.equal(options?.sessionId, undefined);
				assert.equal(Object.keys(options?.headers ?? {}).some((name) => name.toLowerCase() === "x-opencode-session"), false);
			} else {
				assert.equal(options?.sessionId, "stable-session");
				assert.equal(options?.headers?.["x-opencode-session"], "stable-session");
				assert.equal(options?.headers?.["x-opencode-client"], "pi");
			}
		}
	});

	it("uses the current session for each review, omits absent identity, and honors case-insensitive auth header overrides", async () => {
		const current = model("opencode-go", "review");
		const warnings: WatchdogWarning[] = [];
		const { streamFn, calls } = createStreamFn([
			fauxAssistantMessage("done", { stopReason: "stop" }),
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);
		const ctx = createCtx({ current, sessionId: "session-one", authHeaders: { "X-OpenCode-Session": "auth-override", "X-OpenCode-Client": "auth-client" } });
		await createMainWatchdogReview(ctx, { streamFn })(request(enabledConfig(), warnings));
		(ctx as any).sessionManager.getSessionId = () => "session-two";
		await createMainWatchdogReview(ctx, { streamFn })(request(enabledConfig(), warnings));
		assert.equal(calls[0]?.options?.sessionId, "session-one");
		assert.equal(calls[0]?.options?.headers?.["X-OpenCode-Session"], "auth-override");
		assert.equal(calls[0]?.options?.headers?.["X-OpenCode-Client"], "auth-client");
		assert.equal(Object.keys(calls[0]?.options?.headers ?? {}).filter((key) => key.toLowerCase() === "x-opencode-session").length, 1);
		assert.equal(Object.keys(calls[0]?.options?.headers ?? {}).filter((key) => key.toLowerCase() === "x-opencode-client").length, 1);
		assert.equal(calls[1]?.options?.sessionId, "session-two");

		const noSessionCtx = createCtx({ current, sessionId: null });
		const noSession = createStreamFn([fauxAssistantMessage("done", { stopReason: "stop" })]);
		await createMainWatchdogReview(noSessionCtx, { streamFn: noSession.streamFn })(request(enabledConfig(), warnings));
		assert.equal(noSession.calls[0]?.options?.sessionId, undefined);
		assert.equal(Object.keys(noSession.calls[0]?.options?.headers ?? {}).some((name) => name.toLowerCase() === "x-opencode-session"), false);

		const modelHeaderModel = model("opencode", "model-header", { headers: { "X-OpenCode-Session": "model-override", "X-OpenCode-Client": "model-client" } });
		const modelHeader = createStreamFn([fauxAssistantMessage("done", { stopReason: "stop" })]);
		const modelHeaderCtx = createCtx({
			current: modelHeaderModel,
			authHeaders: { "x-OPENCode-session": "auth-model-override", "x-OPENCode-client": "auth-model-client" },
		});
		await createMainWatchdogReview(modelHeaderCtx, { streamFn: modelHeader.streamFn })(request(enabledConfig(), warnings));
		assert.equal(modelHeader.calls[0]?.options?.sessionId, "parent-session-1");
		assert.notEqual(modelHeader.calls[0]?.model, modelHeaderModel);
		assert.equal(modelHeader.calls[0]?.model.headers, undefined);
		assert.deepEqual(modelHeaderModel.headers, { "X-OpenCode-Session": "model-override", "X-OpenCode-Client": "model-client" });
		assert.equal(modelHeader.calls[0]?.options?.headers?.["x-OPENCode-session"], "auth-model-override");
		assert.equal(modelHeader.calls[0]?.options?.headers?.["x-OPENCode-client"], "auth-model-client");
		assert.equal(Object.keys(modelHeader.calls[0]?.options?.headers ?? {}).filter((key) => key.toLowerCase() === "x-opencode-session").length, 1);
		assert.equal(Object.keys(modelHeader.calls[0]?.options?.headers ?? {}).filter((key) => key.toLowerCase() === "x-opencode-client").length, 1);
	});

	it("falls back to the current session model and thinking when no watchdog model is configured", async () => {
		const current = model("github-copilot", "gpt-session");
		const ctx = createCtx({ current });
		const { streamFn, calls } = createStreamFn([fauxAssistantMessage("clean", { stopReason: "stop" })]);
		const warnings: WatchdogWarning[] = [];

		await createMainWatchdogReview(ctx, { streamFn, getThinkingLevel: () => "high" })(request(enabledConfig(), warnings));

		assert.equal(calls[0]?.model, current);
		assert.equal(calls[0]?.options?.apiKey, "key-github-copilot-gpt-session");
		assert.equal(calls[0]?.options?.reasoning, "high");
		assert.deepEqual(calls[0]?.options?.env, { WATCHDOG_PROVIDER: "github-copilot" });
	});

	it("resolves configured model suffixes and thinking deterministically", async () => {
		const current = model("openai", "gpt-current");
		const dated = model("openai", "gpt-5-20260707");
		const ctx = createCtx({ current, models: [current, dated] });

		const suffixWins = await resolveWatchdogReviewModel(ctx, enabledConfig({ model: "openai.gpt_5:high", thinking: "low" }));
		const explicitOff = await resolveWatchdogReviewModel(ctx, enabledConfig({ model: "openai/gpt-5-20260707", thinking: false }));
		const suffixBeatsFalse = await resolveWatchdogReviewModel(ctx, enabledConfig({ model: "openai/gpt-5-20260707:medium", thinking: false }));

		assert.equal(suffixWins.model, dated);
		assert.equal(suffixWins.thinkingLevel, "high");
		assert.equal(explicitOff.model, dated);
		assert.equal(explicitOff.thinkingLevel, "off");
		assert.equal(suffixBeatsFalse.model, dated);
		assert.equal(suffixBeatsFalse.thinkingLevel, "medium");
	});
});
