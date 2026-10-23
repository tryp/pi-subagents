import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { withOpenCodeSession } from "../../src/shared/opencode-session-headers.ts";

function model(provider: string, baseUrl: string, headers?: Record<string, string>): Model<any> {
	return {
		id: "test",
		name: "test",
		api: "faux",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 1_000,
		...(headers ? { headers } : {}),
	};
}

function matchingHeaders(headers: Record<string, string | null> | undefined, name: string): Array<[string, string | null]> {
	return Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === name);
}

describe("OpenCode session headers", () => {
	it("adds client and session defaults and respects case-insensitive model and stream precedence", () => {
		const modelHeaders: Record<string, string> = Object.freeze({ "X-OpenCode-Session": "model-session", "X-OpenCode-Client": "model-client", "x-model": "v" });
		const requestHeaders: Record<string, string | null> = Object.freeze({ "x-opencode-session": "stream-session", "x-opencode-client": "stream-client" });
		const options: { headers: Record<string, string | null>; sessionId?: string; cacheRetention: "none" } = Object.freeze({ headers: requestHeaders, cacheRetention: "none" as const });
		const frozenModel = Object.freeze(model("opencode", "https://opencode.ai/v1", modelHeaders));
		const result = withOpenCodeSession(
			frozenModel,
			"current-session",
			options,
		);
		assert.equal(result.sessionId, "current-session");
		assert.equal(result.cacheRetention, "none");
		assert.deepEqual(matchingHeaders(result.headers, "x-opencode-session"), [["x-opencode-session", "stream-session"]]);
		assert.deepEqual(matchingHeaders(result.headers, "x-opencode-client"), [["x-opencode-client", "stream-client"]]);
		assert.equal(result.headers?.["x-model"], "v");
		assert.deepEqual(modelHeaders, { "X-OpenCode-Session": "model-session", "X-OpenCode-Client": "model-client", "x-model": "v" });
		assert.equal(frozenModel.headers, modelHeaders);
		assert.deepEqual(requestHeaders, { "x-opencode-session": "stream-session", "x-opencode-client": "stream-client" });
	});

	it("preserves null suppression and does not invent identity when absent", () => {
		const headers: Record<string, string | null> = Object.freeze({ "X-OpenCode-Session": null, "X-OpenCode-Client": null });
		const options: { headers: Record<string, string | null>; sessionId?: string } = Object.freeze({ headers });
		const result = withOpenCodeSession(model("opencode-go", "https://opencode.ai"), "session", options);
		assert.equal(result.sessionId, "session");
		assert.deepEqual(matchingHeaders(result.headers, "x-opencode-session"), [["X-OpenCode-Session", null]]);
		assert.deepEqual(matchingHeaders(result.headers, "x-opencode-client"), [["X-OpenCode-Client", null]]);

		const absent = withOpenCodeSession(model("opencode", "https://opencode.ai"), undefined, options);
		assert.equal(absent, options);
	});

	it("rejects lookalike and malformed hosts without adding tracking", () => {
		for (const baseUrl of ["https://not-opencode.ai/v1", "https://opencode.ai.example/v1", "https://opencode.ai@evil.example/v1", "not a URL"]) {
			const options = { headers: { "x-existing": "kept" }, cacheRetention: "none" as const };
			const result = withOpenCodeSession(model("custom", baseUrl), "session", options);
			assert.equal(result, options);
			assert.deepEqual(result.headers, { "x-existing": "kept" });
		}
	});
});
