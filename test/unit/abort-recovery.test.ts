import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ABORT_RECOVERY_PROMPT,
	CompactionSettlementTracker,
	DEFAULT_COMPACTION_SETTLEMENT_WINDOW_MS,
	planAbortRecovery,
	recoverAbortOnce,
} from "../../src/runs/shared/abort-recovery.ts";
import type { Message } from "@earendil-works/pi-ai";

const progress: Message = {
	role: "assistant",
	content: [{ type: "text", text: "Implemented and committed the core changes." }],
	stopReason: "stop",
	usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 520, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} as Message;
const aborted: Message = {
	role: "assistant",
	content: [],
	stopReason: "aborted",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} as Message;

function tracker() {
	return new CompactionSettlementTracker();
}

function tracked(...events: Array<{ type: string; at: number; willRetry?: boolean; reason?: string }>): boolean {
	const value = tracker();
	for (const { at, ...event } of events) value.record(event, at);
	return value.afterCompactionSettlement;
}

function base(overrides: Partial<Parameters<typeof planAbortRecovery>[0]> = {}) {
	return planAbortRecovery({
		messages: [progress, aborted],
		error: "This operation was aborted",
		sessionAvailable: true,
		alreadyResumed: false,
		afterCompactionSettlement: true,
		...overrides,
	});
}

describe("CompactionSettlementTracker", () => {
	it("recognizes the observed settle-then-manual-compaction order at +12ms with willRetry false", () => {
		assert.equal(DEFAULT_COMPACTION_SETTLEMENT_WINDOW_MS, 5000);
		assert.equal(tracked(
			{ type: "agent_settled", at: 1_794_019_388_624 },
			{ type: "compaction_start", at: 1_794_019_388_636, reason: "manual" },
			{ type: "compaction_end", at: 1_794_019_388_700, willRetry: false },
		), true);
	});

	it("recognizes compaction-before-settlement and uses the nearest compaction to the last settlement", () => {
		assert.equal(tracked(
			{ type: "compaction_start", at: 100 },
			{ type: "agent_settled", at: 120 },
			{ type: "agent_settled", at: 7_000 },
		), false);
		assert.equal(tracked(
			{ type: "compaction_start", at: 100 },
			{ type: "compaction_start", at: 190 },
			{ type: "agent_settled", at: 200 },
		), true);
	});

	it("does not associate a compaction from an unrelated earlier turn outside the window", () => {
		assert.equal(tracked(
			{ type: "compaction_start", at: 1_000 },
			{ type: "compaction_end", at: 1_100, willRetry: false },
			{ type: "agent_start", at: 6_000 },
			{ type: "agent_settled", at: 7_000 },
		), false);
		assert.equal(tracked(
			{ type: "compaction_start", at: 1_000 },
			{ type: "agent_settled", at: 7_001 },
		), false);
	});

	it("resets on a new agent turn, auto-retry, and a retrying compaction end, but not a non-retrying end", () => {
		for (const reset of ["agent_start", "auto_retry_start"] as const) {
			assert.equal(tracked(
				{ type: "compaction_start", at: 100 },
				{ type: reset, at: 110 },
				{ type: "agent_settled", at: 120 },
			), false, reset);
		}
		assert.equal(tracked(
			{ type: "agent_settled", at: 100 },
			{ type: "compaction_start", at: 110 },
			{ type: "compaction_end", at: 120, willRetry: true },
		), false);
	});
});

describe("recoverAbortOnce", () => {
	it("resumes the same retained child session once and accepts its completion", async () => {
		const sessionFile = "/tmp/retained-child.jsonl";
		const initial = { exitCode: 1, messages: [progress, aborted], error: "This operation was aborted", processSignal: "SIGTERM", afterCompactionSettlement: true };
		let calls = 0;
		const recovered = await recoverAbortOnce({
			initial,
			planInput: (attempt, alreadyResumed) => ({
				messages: attempt.messages,
				error: attempt.error,
				processSignal: attempt.processSignal,
				sessionAvailable: sessionFile === "/tmp/retained-child.jsonl",
				alreadyResumed,
				afterCompactionSettlement: attempt.afterCompactionSettlement,
			}),
			runContinuation: async (prompt) => {
				calls++;
				assert.equal(prompt, ABORT_RECOVERY_PROMPT);
				assert.equal(sessionFile, "/tmp/retained-child.jsonl");
				return { exitCode: 0, messages: [progress], finalOutput: "finished" };
			},
			mergeAttempts: (_first, second) => second,
		});
		assert.equal(calls, 1);
		assert.equal(recovered.resumed, true);
		assert.equal(recovered.result.exitCode, 0);
		assert.equal(recovered.result.finalOutput, "finished");
	});

	it("settles a second abort once with the unsafe-recovery diagnostic", async () => {
		const initial = { exitCode: 1, messages: [progress, aborted], error: "first abort", afterCompactionSettlement: true };
		let calls = 0;
		const recovered = await recoverAbortOnce({
			initial,
			planInput: (attempt, alreadyResumed) => ({
				messages: attempt.messages,
				error: attempt.error,
				sessionAvailable: true,
				alreadyResumed,
				afterCompactionSettlement: attempt.afterCompactionSettlement,
			}),
			runContinuation: async () => {
				calls++;
				return { exitCode: 1, messages: [progress, aborted], error: "second abort" };
			},
			mergeAttempts: (first, second) => ({ ...second, afterCompactionSettlement: first.afterCompactionSettlement }),
		});
		assert.equal(calls, 1);
		assert.equal(recovered.resumed, true);
		assert.equal(recovered.plan?.action, "settle");
		assert.match(recovered.result.error ?? "", /Compaction-induced child abort could not be resumed safely: resume already attempted\./);
	});
});

describe("planAbortRecovery", () => {
	it("plans one same-session continuation after verified compaction settlement and useful progress", () => {
		assert.deepEqual(base(), { action: "resume", prompt: ABORT_RECOVERY_PROMPT });
	});

	it("keeps explicit stop authoritative even with compaction markers", () => {
		const plan = base({ stopped: true });
		assert.equal(plan.action, "settle");
		assert.equal(plan.reason, "explicit stop or interrupt");
	});

	it("requires terminal assistant abort evidence with zero output usage", () => {
		assert.equal(base({ messages: [progress] }).reason, "terminal assistant abort evidence not verified");
		assert.equal(base({ messages: [progress, { ...aborted, usage: { ...aborted.usage!, output: 1 } } as Message] }).reason, "terminal assistant abort evidence not verified");
		assert.equal(base({ messages: [progress, { ...aborted, stopReason: "error", errorMessage: "invalid schema" } as Message] }).reason, "terminal assistant abort evidence not verified");
		assert.equal(base({ messages: [progress, { ...aborted, stopReason: "error", errorMessage: "Connection reset by provider transport" } as Message] }).action, "resume");
	});

	it("fails closed for every refusal gate", () => {
		const gates: Array<[string, Partial<Parameters<typeof planAbortRecovery>[0]>, string]> = [
			["already resumed", { alreadyResumed: true }, "resume already attempted"],
			["session unavailable", { sessionAvailable: false }, "retained session unavailable"],
			["stopped", { stopped: true }, "explicit stop or interrupt"],
			["interrupted", { interrupted: true }, "explicit stop or interrupt"],
			["process signal", { processSignal: "SIGKILL", afterCompactionSettlement: false }, "process terminated by signal"],
			["timeout", { timedOut: true }, "elapsed timeout"],
			["tool budget", { toolBudgetExhausted: true }, "budget exhausted"],
			["usage budget", { usageBudgetExhausted: true }, "budget exhausted"],
			["structured output", { structuredOutputFailed: true }, "structured output failure"],
			["acceptance", { acceptanceFailed: true }, "acceptance failure"],
			["in-flight tool", { currentTool: "bash" }, "active tool 'bash' remains in flight"],
			["unresolved tool call", { messages: [progress, { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] }, aborted] as Message[] }, "unresolved tool call remains in transcript"],
			["missing settlement marker", { afterCompactionSettlement: false }, "compaction settlement not verified"],
			["no useful progress", { messages: [aborted] }, "no useful prior progress"],
		];
		for (const [name, overrides, reason] of gates) {
			const plan = base(overrides);
			assert.equal(plan.action, "settle", name);
			assert.equal(plan.reason, reason, name);
		}
	});

	it("allows the terminal drain signal only for a verified compaction abort candidate", () => {
		assert.equal(base({ processSignal: "SIGTERM" }).action, "resume");
		assert.deepEqual(base({ processSignal: "SIGTERM", afterCompactionSettlement: false }), {
			action: "settle",
			reason: "process terminated by signal",
		});
	});

	it("carries a recovery diagnostic when a verified compaction abort cannot safely resume", () => {
		assert.deepEqual(base({ sessionAvailable: false }), {
			action: "settle",
			reason: "retained session unavailable",
			diagnostic: "Compaction-induced child abort could not be resumed safely: retained session unavailable.",
		});
	});
});
