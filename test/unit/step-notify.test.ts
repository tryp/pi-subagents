import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveStepNotifyConfig, STEP_NOTIFY_ENABLED_ENV } from "../../src/runs/background/step-notify-config.ts";
import {
	MAX_STEP_NOTIFICATIONS_PER_RUN,
	STEP_NOTIFY_MESSAGE_MAX_BYTES,
	registerStepNotifications,
	shouldNotifyStepResult,
	type RegisterStepNotifyOptions,
	type StepNotifyEnvelope,
} from "../../src/runs/background/step-notify.ts";
import { CONSUMED_STEP_RESULTS_MAX, consumedStepResultSet, markStepResultConsumed, stepResultKey, writeStepResultArtifact } from "../../src/runs/shared/step-results.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "../../src/shared/types.ts";

interface SentMessage {
	message: { customType: string; content: string; details?: unknown };
	options?: { triggerTurn?: boolean };
}

class FakeTimers {
	private nextId = 0;
	private readonly timeouts = new Map<number, { handler: () => void; delay: number }>();
	private readonly intervals = new Map<number, () => void>();
	setTimeout = (handler: () => void, delay: number): number => {
		const id = ++this.nextId;
		this.timeouts.set(id, { handler, delay });
		return id;
	};
	clearTimeout = (handle: unknown): void => { this.timeouts.delete(handle as number); };
	setInterval = (handler: () => void, _delay: number): number => {
		const id = ++this.nextId;
		this.intervals.set(id, handler);
		return id;
	};
	clearInterval = (handle: unknown): void => { this.intervals.delete(handle as number); };
	poll(): void { for (const handler of this.intervals.values()) handler(); }
	flushTimeouts(): void {
		while (this.timeouts.size > 0) {
			const [id, timeout] = this.timeouts.entries().next().value as [number, { handler: () => void; delay: number }];
			this.timeouts.delete(id);
			timeout.handler();
		}
	}
}

function makeHarness(options: { idle?: boolean; hasUI?: boolean; jobs?: number; batchConfig?: RegisterStepNotifyOptions["batchConfig"] } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "step-notify-test-"));
	const timers = new FakeTimers();
	const messages: SentMessage[] = [];
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	let subscriptions = 0;
	const events = {
		on(event: string, handler: (data: unknown) => void) {
			subscriptions += 1;
			const existing = handlers.get(event) ?? new Set();
			existing.add(handler);
			handlers.set(event, existing);
			return () => existing.delete(handler);
		},
		emit(event: string, data: unknown) { for (const handler of handlers.get(event) ?? []) handler(data); },
	};
	const jobs = new Map<string, any>();
	for (let i = 0; i < (options.jobs ?? 1); i++) {
		const runId = `run-${i}`;
		const asyncDir = path.join(root, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		jobs.set(runId, { asyncId: runId, asyncDir, status: "running" });
	}
	let idle = options.idle ?? true;
	const state = {
		asyncJobs: jobs,
		currentSessionId: "session-1",
		consumedStepResults: new Set<string>(),
		lastUiContext: options.hasUI === undefined ? { hasUI: true, isIdle: () => idle } : { hasUI: options.hasUI, isIdle: () => idle },
	} as unknown as SubagentState;
	const pi = {
		events,
		sendMessage(message: SentMessage["message"], sendOptions?: SentMessage["options"]) {
			messages.push({ message, options: sendOptions });
		},
	};
	const registrationOptions: RegisterStepNotifyOptions = {
		timers,
		batchConfig: options.batchConfig ?? { enabled: true, debounceMs: 150, maxWaitMs: 1000, stragglerDebounceMs: 75, stragglerMaxWaitMs: 400, stragglerWindowMs: 2000 },
		logSuppression: (_runId, _stepIndex, reason) => suppressions.push(reason),
	};
	const suppressions: string[] = [];
	const dispose = registerStepNotifications(pi as any, state, true, registrationOptions);
	return {
		root, timers, messages, events, state, jobs, suppressions, dispose,
		setIdle(value: boolean) { idle = value; },
		get subscriptions() { return subscriptions; },
		addArtifact(runId: string, stepIndex: number, output = `output-${stepIndex}`, stateName: "complete" | "failed" | "paused" | "stopped" = "complete") {
			const job = jobs.get(runId)!;
			const artifactPath = writeStepResultArtifact({
				asyncDir: job.asyncDir, runId, stepIndex, agent: `agent-${stepIndex}`, state: stateName,
				startedAt: 1, endedAt: 1001, durationMs: 1000,
				result: { success: stateName === "complete", output },
			});
			assert.ok(artifactPath);
			return artifactPath;
		},
		cleanup() { dispose(); fs.rmSync(root, { recursive: true, force: true }); },
	};
}

describe("step notification policy", () => {
	const base = { enabled: true, hasUI: true, idle: true, consumed: false, completionSent: false, notificationsSent: 0 };
	it("notifies an unconsumed result while idle", () => {
		assert.deepEqual(shouldNotifyStepResult(base), { notify: true, reason: "ready" });
	});
	it("holds a result while a turn is active", () => {
		assert.deepEqual(shouldNotifyStepResult({ ...base, idle: false }), { notify: false, reason: "turn-active" });
	});
	it("does not notify a child already consumed by a wait", () => {
		assert.deepEqual(shouldNotifyStepResult({ ...base, consumed: true }), { notify: false, reason: "already-consumed" });
	});
	it("does not notify after run completion", () => {
		assert.deepEqual(shouldNotifyStepResult({ ...base, completionSent: true }), { notify: false, reason: "completion-already-sent" });
	});
	it("stops at the per-run cap and allows the pending third group", () => {
		assert.equal(MAX_STEP_NOTIFICATIONS_PER_RUN, 3);
		assert.deepEqual(shouldNotifyStepResult({ ...base, notificationsSent: 3 }), { notify: false, reason: "per-run-cap" });
		assert.equal(shouldNotifyStepResult({ ...base, notificationsSent: 3, hasPendingNotification: true }).notify, true);
	});
	it("headless context fails closed, while the same interactive input notifies", () => {
		assert.deepEqual(shouldNotifyStepResult({ ...base, hasUI: false }), { notify: false, reason: "headless" });
		assert.deepEqual(shouldNotifyStepResult({ ...base, hasUI: undefined }), { notify: false, reason: "headless" });
		assert.deepEqual(shouldNotifyStepResult({ ...base, hasUI: true }), { notify: true, reason: "ready" });
	});
	it("defaults the config off and validates config/environment values", () => {
		assert.deepEqual(resolveStepNotifyConfig(), { enabled: false });
		assert.deepEqual(resolveStepNotifyConfig(true), { enabled: true });
		assert.deepEqual(resolveStepNotifyConfig(undefined, { [STEP_NOTIFY_ENABLED_ENV]: "off" }), { enabled: false });
		assert.throws(() => resolveStepNotifyConfig(undefined, { [STEP_NOTIFY_ENABLED_ENV]: "sometimes" }), /must be one of/);
	});
});

describe("step notification ticker", () => {
	it("never sends in headless mode or when UI context is unavailable", () => {
		const headless = makeHarness({ hasUI: false });
		try {
			headless.addArtifact("run-0", 0);
			headless.timers.poll();
			headless.timers.flushTimeouts();
			assert.equal(headless.messages.length, 0);
		} finally { headless.cleanup(); }

		const missingContext = makeHarness();
		try {
			missingContext.state.lastUiContext = null;
			missingContext.addArtifact("run-0", 0);
			missingContext.timers.poll();
			missingContext.timers.flushTimeouts();
			assert.equal(missingContext.messages.length, 0);
		} finally { missingContext.cleanup(); }
	});

	it("holds while the turn is active and delivers exactly once once idle", () => {
		const h = makeHarness({ idle: false });
		try {
			h.addArtifact("run-0", 0);
			h.timers.poll();
			assert.equal(h.messages.length, 0);
			h.setIdle(true);
			h.timers.poll();
			h.timers.flushTimeouts();
			assert.equal(h.messages.length, 1);
			assert.match(h.messages[0]!.message.content, /output-0/);
		} finally { h.cleanup(); }
	});

	it("holds a batch if the parent becomes busy during debounce and delivers it once idle", () => {
		const h = makeHarness();
		try {
			h.addArtifact("run-0", 0);
			h.timers.poll();
			h.setIdle(false);
			h.timers.flushTimeouts();
			assert.equal(h.messages.length, 0);
			h.setIdle(true);
			h.timers.poll();
			h.timers.flushTimeouts();
			assert.equal(h.messages.length, 1);
			assert.match(h.messages[0]!.message.content, /output-0/);
		} finally { h.cleanup(); }
	});

	it("does not notify an already-consumed artifact", () => {
		const h = makeHarness();
		try {
			h.addArtifact("run-0", 0);
			consumedStepResultSet(h.state).add(stepResultKey("run-0", 0));
			h.timers.poll();
			h.timers.flushTimeouts();
			assert.equal(h.messages.length, 0);
		} finally { h.cleanup(); }
	});

	it("suppresses queued notifications when the run-completion notification arrives", () => {
		const h = makeHarness();
		try {
			h.addArtifact("run-0", 0);
			h.timers.poll();
			h.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "run-0" });
			h.timers.flushTimeouts();
			assert.equal(h.messages.length, 0);
		} finally { h.cleanup(); }
	});

	it("caps emitted groups at three and records the suppression reason", () => {
		const h = makeHarness();
		try {
			for (let i = 0; i < 4; i++) {
				h.addArtifact("run-0", i);
				h.timers.poll();
				h.timers.flushTimeouts();
			}
			assert.equal(h.messages.length, 3);
			assert.deepEqual(h.suppressions, ["per-run-cap"]);
		} finally { h.cleanup(); }
	});

	it("coalesces twelve near-simultaneous children into one receipt", () => {
		const h = makeHarness();
		try {
			for (let i = 0; i < 12; i++) h.addArtifact("run-0", i);
			h.timers.poll();
			h.timers.flushTimeouts();
			assert.equal(h.messages.length, 1);
			const details = (h.messages[0]!.message.details as { notifications: Array<{ artifactPath: string; preview: string }> }).notifications;
			assert.equal(details.length, 12);
			assert.ok(details.every((detail) => detail.artifactPath.includes("step-results/step-")));
			assert.ok(details.every((detail) => Buffer.byteLength(detail.preview) <= 1027));
			assert.ok(Buffer.byteLength(h.messages[0]!.message.content) <= STEP_NOTIFY_MESSAGE_MAX_BYTES);
		} finally { h.cleanup(); }
	});

	it("delivers failed or stopped child results immediately instead of batching them", () => {
		for (const status of ["failed", "stopped"] as const) {
			const h = makeHarness();
			try {
				h.addArtifact("run-0", 0, `${status} output`, status);
				h.timers.poll();
				assert.equal(h.messages.length, 1);
				assert.match(h.messages[0]!.message.content, new RegExp(status));
				assert.match(h.messages[0]!.message.content, new RegExp(`${status} output`));
			} finally { h.cleanup(); }
		}
	});

	it("keeps the receipt path and reports a deleted artifact", () => {
		const h = makeHarness();
		try {
			const artifactPath = h.addArtifact("run-0", 0);
			h.timers.poll();
			fs.rmSync(artifactPath);
			h.timers.flushTimeouts();
			assert.equal(h.messages.length, 1);
			assert.match(h.messages[0]!.message.content, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(h.messages[0]!.message.content, /FILE GONE/);
			assert.equal((h.messages[0]!.message.details as StepNotifyEnvelope).notifications[0]!.missing, true);
		} finally { h.cleanup(); }
	});

	it("disabled registration installs no timers or event subscriptions", () => {
		const h = makeHarness();
		try {
			h.dispose();
			const before = h.subscriptions;
			const noOp = registerStepNotifications({ sendMessage() {}, events: h.events } as any, h.state, false, { timers: h.timers });
			noOp();
			assert.equal(h.subscriptions, before);
		} finally { h.cleanup(); }
	});
});

describe("shared consumed-step helpers", () => {
	it("preserves oldest-first 512-key eviction", () => {
		const state: { consumedStepResults?: Set<string> } = {};
		for (let i = 0; i <= CONSUMED_STEP_RESULTS_MAX; i++) markStepResultConsumed(state, "run", i);
		const consumed = consumedStepResultSet(state);
		assert.equal(consumed.size, 512);
		assert.equal(consumed.has(stepResultKey("run", 0)), false);
		assert.equal(consumed.has(stepResultKey("run", 1)), true);
		assert.equal(consumed.has(stepResultKey("run", 512)), true);
	});
});
