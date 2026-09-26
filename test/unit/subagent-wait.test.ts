import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { WAIT_TOOL_ENABLED_ENV, resolveWaitToolConfig, waitForSubagents, type SubagentWaitDeps } from "../../src/runs/background/subagent-wait.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function writeStatus(asyncRoot: string, runId: string, state: string, extra: object = {}): void {
	const dir = path.join(asyncRoot, runId);
	fs.mkdirSync(dir, { recursive: true });
	// Use a recent timestamp so the stale-run reconciler doesn't mark a live
	// "running" fixture as failed for having a stale heartbeat.
	const nowMs = Date.now();
	fs.writeFileSync(
		path.join(dir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state,
			startedAt: nowMs,
			lastUpdate: nowMs,
			steps: [{ agent: "worker", status: state }],
			...extra,
		}),
		"utf-8",
	);
}

function makeState(sessionId: string | null): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

function writeStepResult(
	asyncRoot: string,
	runId: string,
	stepIndex: number,
	output: string,
	options: { state?: "complete" | "failed" | "paused" | "stopped"; agent?: string } = {},
): void {
	const dir = path.join(asyncRoot, runId, "step-results");
	fs.mkdirSync(dir, { recursive: true });
	const state = options.state ?? "complete";
	fs.writeFileSync(
		path.join(dir, `step-${stepIndex}.json`),
		JSON.stringify({
			stepResultArtifactVersion: 1,
			runId,
			stepIndex,
			agent: options.agent ?? "scout",
			state,
			startedAt: Date.now() - 1000,
			endedAt: Date.now(),
			durationMs: 1000,
			result: { agent: options.agent ?? "scout", output, success: state === "complete" },
		}),
		"utf-8",
	);
}

function stepResultsOf(result: { details?: { stepResults?: Array<{ stepIndex: number; output: string }> } }): Array<{ stepIndex: number; output: string }> {
	return result.details?.stepResults ?? [];
}

function baseDeps(root: string, state: SubagentState, overrides: Partial<SubagentWaitDeps> = {}): SubagentWaitDeps {
	return {
		state,
		asyncDirRoot: path.join(root, "runs"),
		resultsDir: path.join(root, "results"),
		// Never probe real PIDs in tests — treat every recorded pid as alive so
		// reconciliation doesn't flip a "running" fixture to failed.
		kill: () => true,
		pollIntervalMs: 250,
		...overrides,
	};
}

describe("subagent_wait tool", () => {
	it("resolves waitTool config and environment overrides strictly", () => {
		assert.deepEqual(resolveWaitToolConfig(undefined, {}), { enabled: true });
		assert.deepEqual(resolveWaitToolConfig(false, {}), { enabled: false });
		assert.deepEqual(resolveWaitToolConfig({ enabled: false }, {}), { enabled: false });
		assert.deepEqual(resolveWaitToolConfig({ enabled: false }, { [WAIT_TOOL_ENABLED_ENV]: "true" }), { enabled: true });
		assert.deepEqual(resolveWaitToolConfig(true, { [WAIT_TOOL_ENABLED_ENV]: "off" }), { enabled: false });
		assert.throws(() => resolveWaitToolConfig("false" as never, {}), /config\.waitTool/);
		assert.throws(() => resolveWaitToolConfig({ enabled: "false" } as never, {}), /config\.waitTool\.enabled/);
		assert.throws(() => resolveWaitToolConfig(undefined, { [WAIT_TOOL_ENABLED_ENV]: "maybe" }), /PI_SUBAGENT_WAIT_TOOL_ENABLED/);
	});

	it("returns immediately without polling when waitTool is disabled", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-disabled-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			let slept = false;
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				enabled: false,
				sleep: async () => {
					slept = true;
					throw new Error("disabled subagent_wait should not sleep");
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /disabled/i);
			assert.match(textOf(result), /without blocking/i);
			assert.equal(slept, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns immediately when there is nothing to wait for", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-empty-"));
		try {
			const state = makeState("sess-1");
			const result = await waitForSubagents({}, undefined, baseDeps(root, state));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /nothing to wait for/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("with all:true, resolves once every active run reaches a terminal state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-resolve-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-b", "queued", { sessionId: "sess-1", pid: 999998 });

			// Flip one run terminal on the first poll, the other on the second — so
			// all:true must keep waiting past the first completion.
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
				if (polls === 2) writeStatus(asyncRoot, "run-b", "failed", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /done/i);
			assert.match(text, /1 complete/);
			assert.match(text, /1 failed/);
			assert.ok(polls >= 2, "all:true should wait for both completions");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces failed terminal runs as errors only for internal auto-drain", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-drain-failure-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-failed", "running", { sessionId: "sess-1", pid: 999999 });
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				failOnFailedRuns: true,
				sleep: async () => writeStatus(asyncRoot, "run-failed", "failed", { sessionId: "sess-1" }),
			}));
			assert.equal(result.isError, true);
			assert.match(textOf(result), /1 failed/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes when a run needs attention, not only on completion", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-attn-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			// Two runs, all:true so it would normally block until both finish.
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-b", "running", { sessionId: "sess-1", pid: 999998 });

			// Neither completes; run-a flags needs_attention (blocked for a decision).
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) {
					writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999, activityState: "needs_attention" });
				}
			};

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /need attention/i, "should report the attention run");
			assert.match(text, /steer a top-level live async child, resume a paused\/completed\/failed child, or interrupt explicitly/);
			assert.match(text, /run-a/, "should name the attention run");
			assert.ok(polls <= 2, `should break on attention promptly, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports runs that already need attention before waiting starts", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-initial-attn-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-blocked", "running", { sessionId: "sess-1", pid: 999999, activityState: "needs_attention" });

			let polls = 0;
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				sleep: async () => { polls += 1; },
			}));

			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.doesNotMatch(text, /nothing to wait for/i);
			assert.match(text, /need attention/i);
			assert.match(text, /run-blocked/);
			assert.equal(polls, 0, "initial attention should return without polling");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("by default returns as soon as the FIRST run finishes, leaving the rest in flight", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-first-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-b", "running", { sessionId: "sess-1", pid: 999998 });
			writeStatus(asyncRoot, "run-c", "running", { sessionId: "sess-1", pid: 999997 });

			// Only run-a finishes; b and c stay running forever.
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({}, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /1 of 3 run\(s\) finished/);
			assert.match(text, /1 complete/);
			assert.match(text, /2 run\(s\) still in flight/);
			// Must not have blocked on b and c: a bounded number of polls.
			assert.ok(polls <= 2, `first-completion should return promptly, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("only waits for runs belonging to the current session", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			// A run from another session must be ignored.
			writeStatus(asyncRoot, "run-other", "running", { sessionId: "sess-2", pid: 999999 });
			const result = await waitForSubagents({}, undefined, baseDeps(root, state));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /nothing to wait for/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("summarizes only runs that were active when waiting began", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-summary-scope-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "old-complete", "complete", { sessionId: "sess-1" });
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });

			const sleep = async () => {
				writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /1 complete/);
			assert.doesNotMatch(text, /2 complete/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("waits for a remembered detached foreground run by id and ignores other sessions", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-foreground-"));
		try {
			const state = makeState("sess-1");
			state.foregroundRuns = new Map([
				["foreground-alpha", {
					runId: "foreground-alpha",
					mode: "single",
					cwd: root,
					sessionId: "sess-1",
					updatedAt: 1,
					children: [{ agent: "reviewer", index: 0, status: "detached", updatedAt: 1 }],
				}],
				["foreground-other", {
					runId: "foreground-other",
					mode: "single",
					cwd: root,
					sessionId: "sess-2",
					updatedAt: 1,
					children: [{ agent: "worker", index: 0, status: "detached", updatedAt: 1 }],
				}],
			]);
			let polls = 0;
			const result = await waitForSubagents({ id: "foreground-al" }, undefined, baseDeps(root, state, {
				sleep: async () => {
					polls += 1;
					state.foregroundRuns!.get("foreground-alpha")!.children[0] = {
						agent: "reviewer",
						index: 0,
						status: "completed",
						finalOutput: "Recovered review",
						updatedAt: 2,
					};
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /remembered detached foreground run "foreground-alpha"/i);
			assert.match(textOf(result), /1 completed/);
			assert.equal(polls, 1);

			const otherSession = await waitForSubagents({ id: "foreground-other" }, undefined, baseDeps(root, state));
			assert.match(textOf(otherSession), /No active run matched/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses sync-wake guidance when a detached foreground run times out", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-sync-wake-"));
		try {
			const state = makeState("sess-1");
			state.foregroundRuns = new Map([["foreground-sync-wake", {
				runId: "foreground-sync-wake",
				mode: "single",
				cwd: root,
				sessionId: "sess-1",
				updatedAt: 1,
				children: [{ agent: "reviewer", index: 0, status: "detached", detachedReason: "sync runtime wake", updatedAt: 1 }],
			}]]);
			let clock = 0;
			const result = await waitForSubagents({ id: "foreground-sync-wake", timeoutMs: 1 }, undefined, baseDeps(root, state, {
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
			}));

			assert.equal(result.isError, true);
			const text = textOf(result);
			assert.match(text, /sync wake/);
			assert.doesNotMatch(text, /Reply to any pending supervisor request/);
			assert.match(text, /Do not resume or launch a replacement/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not claim completion when a detached foreground run disappears or the active session changes", async () => {
		for (const scenario of ["missing", "session-change"] as const) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-wait-foreground-${scenario}-`));
			try {
				const state = makeState("sess-1");
				state.foregroundRuns = new Map([["foreground-still-live", {
					runId: "foreground-still-live",
					mode: "single",
					cwd: root,
					sessionId: "sess-1",
					updatedAt: 1,
					children: [{ agent: "reviewer", index: 0, status: "detached", updatedAt: 1 }],
				}]]);
				const result = await waitForSubagents({ id: "foreground-still", timeoutMs: 5000 }, undefined, baseDeps(root, state, {
					sleep: async () => {
						if (scenario === "missing") state.foregroundRuns!.delete("foreground-still-live");
						else state.currentSessionId = "sess-2";
					},
				}));

				assert.equal(result.isError, true);
				assert.doesNotMatch(textOf(result), /; done\./);
				assert.match(textOf(result), scenario === "missing" ? /disappeared before a terminal child result/ : /active session changed/);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("rejects ambiguous prefixes across async and remembered foreground runs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-cross-kind-"));
		try {
			const state = makeState("sess-1");
			writeStatus(path.join(root, "runs"), "shared-async", "running", { sessionId: "sess-1", pid: 999999 });
			state.foregroundRuns = new Map([["shared-foreground", {
				runId: "shared-foreground",
				mode: "single",
				cwd: root,
				sessionId: "sess-1",
				updatedAt: 1,
				children: [{ agent: "reviewer", index: 0, status: "detached", updatedAt: 1 }],
			}]]);

			const result = await waitForSubagents({ id: "shared" }, undefined, baseDeps(root, state));
			assert.equal(result.isError, true);
			assert.match(textOf(result), /Ambiguous subagent run id prefix "shared"/);
			assert.match(textOf(result), /shared-async/);
			assert.match(textOf(result), /shared-foreground/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("can target a single run by id prefix", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-alpha", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-beta", "running", { sessionId: "sess-1", pid: 999998 });

			let polls = 0;
			const sleep = async () => {
				polls += 1;
				// Only alpha finishes; beta stays running but we're not waiting on it.
				if (polls === 1) writeStatus(asyncRoot, "run-alpha", "complete", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents(
				// all-terminal keeps the run-level summary this test asserts on; the
				// default (first-result) reports child results instead of naming the run.
				{ id: "run-al", until: "all-terminal" },
				undefined,
				baseDeps(root, state, { sleep }),
			);
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /run "run-al".*done/is);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous id prefixes but lets exact ids win", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-ambiguous-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-alpha", "running", { sessionId: "sess-1", pid: 999998 });

			const ambiguous = await waitForSubagents({ id: "ru" }, undefined, baseDeps(root, state));
			assert.equal(ambiguous.isError, true);
			assert.match(textOf(ambiguous), /Ambiguous subagent run id prefix "ru"/);
			assert.match(textOf(ambiguous), /run-alpha/);

			let polls = 0;
			const exact = await waitForSubagents({ id: "run", until: "all-terminal" }, undefined, baseDeps(root, state, {
				sleep: async () => {
					polls += 1;
					writeStatus(asyncRoot, "run", "complete", { sessionId: "sess-1" });
				},
			}));

			assert.equal(exact.isError, undefined);
			assert.match(textOf(exact), /run "run".*done/is);
			assert.equal(polls, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("times out while runs are still active and reports them", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-timeout-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-stuck", "running", { sessionId: "sess-1", pid: 999999 });

			// Virtual clock that jumps past the timeout on the first sleep.
			let clock = 0;
			const now = () => clock;
			const sleep = async (ms: number) => {
				clock += ms + 10_000;
			};

			const result = await waitForSubagents({ timeoutMs: 5_000 }, undefined, baseDeps(root, state, { now, sleep }));
			assert.equal(result.isError, true);
			const text = textOf(result);
			assert.match(text, /timed out/i);
			assert.match(text, /run-stuck \(running\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves early when the turn is aborted", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-abort-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-x", "running", { sessionId: "sess-1", pid: 999999 });

			const controller = new AbortController();
			const sleep = async () => {
				controller.abort();
			};

			const result = await waitForSubagents({}, controller.signal, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, true);
			assert.match(textOf(result), /aborted/i);
			assert.match(textOf(result), /run-x \(running\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes immediately on an event bus emission instead of waiting the poll interval", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-event-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });

			// Fake bus. Emitting on a wake channel should end wait's sleep early.
			const handlers = new Map<string, Array<(d: unknown) => void>>();
			const events = {
				on(channel: string, handler: (d: unknown) => void) {
					const list = handlers.get(channel) ?? [];
					list.push(handler);
					handlers.set(channel, list);
					return () => {
						const l = handlers.get(channel) ?? [];
						handlers.set(channel, l.filter((h) => h !== handler));
					};
				},
				emit(channel: string, data: unknown) {
					for (const h of handlers.get(channel) ?? []) h(data);
				},
			};

			// A real timer-based sleep with a LONG poll interval; if wait waited for
			// the poll it would take ~10s. The event should wake it in ~10ms.
			let sleepCalls = 0;
			const realSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
				sleepCalls += 1;
				const t = setTimeout(resolve, ms);
				signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
			});

			const startedAt = Date.now();
			const p = waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				events,
				pollIntervalMs: 10_000,
				sleep: realSleep,
			}));

			// After a short delay, flip the run terminal and emit a completion event.
			setTimeout(() => {
				writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
				events.emit("subagent:async-complete", { id: "run-a" });
			}, 15);

			const result = await p;
			const elapsed = Date.now() - startedAt;
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /done/i);
			assert.ok(elapsed < 5_000, `should wake via event, not the 10s poll; took ${elapsed}ms`);
			assert.ok(sleepCalls >= 1, "poll-interval sleep still armed as fallback");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still resolves via poll when no event bus is provided (fallback)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-nobus-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};
			// No `events` in deps → pure poll path.
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /done/i);
			assert.ok(polls >= 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("returns finished children's output instead of only a status line", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-results-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStepResult(asyncRoot, "run-a", 0, "ALPHA");

			// The child result is already on disk; the run only finishes on the poll.
			const sleep = async () => writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			const result = await waitForSubagents({ runId: "run-a" }, undefined, baseDeps(root, state, { sleep }));

			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /step 0 \(scout\) \[complete\]/);
			assert.match(text, /ALPHA/);
			assert.deepEqual(stepResultsOf(result).map((view) => view.output), ["ALPHA"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("defaults to first-result on a targeted multi-child run", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-default-first-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			// Only child 0 is done; child 1 never finishes during the call.
			writeStepResult(asyncRoot, "run-a", 0, "ALPHA");

			let polls = 0;
			const sleep = async () => {
				polls += 1;
			};
			const result = await waitForSubagents({ runId: "run-a" }, undefined, baseDeps(root, state, { sleep }));

			assert.equal(result.isError, undefined);
			assert.deepEqual(stepResultsOf(result).map((view) => view.output), ["ALPHA"]);
			// Returning at the first child means no blocking for the straggler: the
			// default must not behave like all-terminal.
			assert.ok(polls <= 1, `default wait should return at the first child, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("all: true still waits for every child, which is what headless auto-drain relies on", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-all-invariant-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			// Both children are done but the run has not reached a terminal state yet.
			writeStepResult(asyncRoot, "run-a", 0, "ALPHA");
			writeStepResult(asyncRoot, "run-a", 1, "BETA");

			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 2) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));

			assert.equal(result.isError, undefined);
			assert.deepEqual(stepResultsOf(result).map((view) => view.output), ["ALPHA", "BETA"]);
			assert.ok(polls >= 2, `all:true must keep waiting for the run to finish, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("barrier integration implies waiting for the whole batch", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-integration-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStepResult(asyncRoot, "run-a", 0, "ALPHA");
			writeStepResult(asyncRoot, "run-a", 1, "BETA");

			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 2) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};
			const result = await waitForSubagents(
				{ runId: "run-a", barrier: "integration" },
				undefined,
				baseDeps(root, state, { sleep }),
			);

			assert.equal(result.isError, undefined);
			assert.deepEqual(stepResultsOf(result).map((view) => view.output), ["ALPHA", "BETA"]);
			assert.ok(polls >= 2, `an integration barrier must wait for the batch, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects first-result combined with an integration barrier", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-contradiction-"));
		try {
			const state = makeState("sess-1");
			const result = await waitForSubagents(
				{ runId: "run-a", until: "first-result", barrier: "integration" },
				undefined,
				baseDeps(root, state),
			);
			assert.equal(result.isError, true);
			assert.match(textOf(result), /specify different completion conditions/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("explicit any-change still returns at the first tracked run, not the first child", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-any-change-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			// A finished child is available immediately, so this fixture can tell the
			// two modes apart: first-result has something to report, any-change does not.
			writeStepResult(asyncRoot, "run-a", 0, "ALPHA");

			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};
			const result = await waitForSubagents({ until: "any-change" }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			// any-change returns at the run level: it must not use the first-result
			// header, and it must actually wait for the run to finish.
			assert.doesNotMatch(text, /child result\(s\) finished before the rest of the batch/);
			assert.match(text, /1 of 1 run\(s\) finished/);
			assert.ok(polls >= 1, `any-change must wait for the run, polled ${polls}`);
			// The terminal path still reports the child's output in either mode.
			assert.deepEqual(stepResultsOf(result).map((view) => view.output), ["ALPHA"]);

			// Same fixture shape on a second run: the first wait consumed run-a's child,
			// so first-result needs its own unconsumed artifact to fire on.
			writeStatus(asyncRoot, "run-b", "running", { sessionId: "sess-1", pid: 999998 });
			writeStepResult(asyncRoot, "run-b", 0, "GAMMA");
			let earlyPolls = 0;
			const early = await waitForSubagents({ runId: "run-b" }, undefined, baseDeps(root, state, {
				sleep: async () => {
					earlyPolls += 1;
				},
			}));
			assert.match(textOf(early), /child result\(s\) finished before the rest of the batch/);
			assert.deepEqual(stepResultsOf(early).map((view) => view.output), ["GAMMA"]);
			assert.ok(earlyPolls <= 1, `first-result should not block on the straggler, polled ${earlyPolls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("a first-result wait on a run that never publishes artifacts still returns", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-no-artifacts-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			// No step-results directory at all. A short timeout keeps a regression
			// failing fast instead of hanging the suite for 30 minutes.
			const result = await waitForSubagents({ runId: "run-a", timeoutMs: 1_000 }, undefined, baseDeps(root, state));
			assert.equal(result.isError, undefined);
			assert.deepEqual(stepResultsOf(result), []);
			assert.match(textOf(result), /complete/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("bounds the total output of a many-child batch and points at the omitted artifacts", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-budget-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			// 40 children x 64 KiB each: without a batch budget this inlines 2.5 MB.
			const children = 40;
			for (let index = 0; index < children; index++) {
				writeStepResult(asyncRoot, "run-a", index, `CHILD-${index}\n${"x".repeat(64 * 1024)}`);
			}

			const sleep = async () => writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			// Explicitly all-terminal: the default (first-result) would report only the
			// first child, which is a different test.
			const result = await waitForSubagents({ runId: "run-a", until: "all-terminal" }, undefined, baseDeps(root, state, { sleep }));

			const text = textOf(result);
			const views = stepResultsOf(result);
			assert.equal(views.length, children, "every child is still reported");
			// Per-child truncation (8 KiB) plus block headers, under a 32 KiB shared budget.
			assert.ok(
				Buffer.byteLength(text, "utf-8") < 48 * 1024,
				`content should stay near the shared budget, got ${Buffer.byteLength(text, "utf-8")} bytes`,
			);
			// Later children are named with a path instead of inlined.
			assert.match(text, /output omitted: wait result budget reached; read .*step-\d+\.json/);
			// The early children keep their output, so the budget spent where it was useful.
			assert.match(text, /CHILD-0/);
			const omitted = text.match(/output omitted/g) ?? [];
			assert.ok(omitted.length > 0, "expected some children to be referenced by path only");
			assert.ok(omitted.length < children, "expected some children to still have output");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the consumed-result set bounded across many waits", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-consumed-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			// 520 distinct runs, each a single finished child, so each wait consumes one key
			// (just past the 512-key cap).
			for (let index = 0; index < 520; index++) {
				const runId = `run-${index}`;
				writeStatus(asyncRoot, runId, "complete", { sessionId: "sess-1" });
				writeStepResult(asyncRoot, runId, 0, `OUT-${index}`);
			}

			// A 1 ms poll keeps the 600-call loop fast; these runs are terminal.
			const deps = () => baseDeps(root, state, { pollIntervalMs: 1 });
			const first = await waitForSubagents({ runId: "run-0", until: "first-result" }, undefined, deps());
			assert.deepEqual(stepResultsOf(first).map((view) => view.output), ["OUT-0"]);

			for (let index = 1; index < 520; index++) {
				await waitForSubagents({ runId: `run-${index}`, until: "first-result" }, undefined, deps());
			}

			const consumed = (state as SubagentState & { consumedStepResults?: Set<string> }).consumedStepResults;
			assert.ok(consumed, "expected the consumption set to exist");
			assert.ok(
				consumed.size <= 512,
				`consumption state should stay bounded, got ${consumed.size} keys`,
			);
			// The most recent child is still remembered, so no immediate duplicate.
			assert.ok(consumed.has("run-519:0"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("until:first-result returns before the rest of the batch finishes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-first-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			// The batch stays running for the whole call: only child 0 is done.
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStepResult(asyncRoot, "run-a", 0, "ALPHA");

			let slept = false;
			const result = await waitForSubagents({ runId: "run-a", until: "first-result" }, undefined, baseDeps(root, state, {
				sleep: async () => {
					slept = true;
					throw new Error("first-result should return without polling while a child result exists");
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /ALPHA/);
			assert.match(textOf(result), /before the rest of the batch/);
			assert.equal(slept, false, "must not wait for the straggler once a child result exists");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("until:first-result consumes each child once so repeated calls drain the batch", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-drain-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStepResult(asyncRoot, "run-a", 0, "ALPHA");
			const deps = baseDeps(root, state, { sleep: async () => {} });

			const first = await waitForSubagents({ runId: "run-a", until: "first-result" }, undefined, deps);
			assert.match(textOf(first), /ALPHA/);
			assert.deepEqual(stepResultsOf(first).map((view) => view.stepIndex), [0]);

			// Child 1 finishes later; the second call must report it, not replay ALPHA.
			writeStepResult(asyncRoot, "run-a", 1, "BETA");
			const second = await waitForSubagents({ runId: "run-a", until: "first-result" }, undefined, deps);
			assert.doesNotMatch(textOf(second), /ALPHA/);
			assert.match(textOf(second), /BETA/);
			assert.deepEqual(stepResultsOf(second).map((view) => view.stepIndex), [1]);

			// Both children have been reported; a third call reports nothing and says so.
			writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			const third = await waitForSubagents({ runId: "run-a", until: "first-result" }, undefined, deps);
			assert.equal(third.isError, undefined);
			assert.match(textOf(third), /no unconsumed per-child results/i);
			assert.deepEqual(stepResultsOf(third), []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("until:first-result still delivers results when the batch already finished", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-done-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			// Terminal, so it is not an "active" run and the old code answered
			// "No active run matched" while the child's output sat on disk.
			writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			writeStepResult(asyncRoot, "run-a", 0, "ALPHA");
			writeStepResult(asyncRoot, "run-a", 1, "BETA");

			const result = await waitForSubagents({ runId: "run-a", until: "first-result" }, undefined, baseDeps(root, state));

			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /no longer active/);
			assert.match(text, /ALPHA/);
			assert.match(text, /BETA/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports failed children as failures rather than successes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-failed-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStepResult(asyncRoot, "run-a", 0, "boom", { state: "failed" });
			const sleep = async () => writeStatus(asyncRoot, "run-a", "failed", { sessionId: "sess-1" });

			const result = await waitForSubagents({ runId: "run-a" }, undefined, baseDeps(root, state, { sleep }));

			assert.match(textOf(result), /step 0 \(scout\) \[failed\]/);
			const [view] = stepResultsOf(result) as Array<{ success: boolean; state: string }>;
			assert.equal(view?.success, false);
			assert.equal(view?.state, "failed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
