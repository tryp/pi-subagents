/**
 * Regression for an idle parent missing a child supervisor ask.
 *
 * Harness limitation / variant: real-session-runner's child faux provider only
 * emits static text and cannot itself call contact_supervisor. This test keeps
 * the real parent AgentSession and extension poller, waits until the parent is
 * idle, then writes the same request record a child would write. The parent
 * must wake, reply through the actual subagent_supervisor tool, and record the
 * relayed acknowledgement. This directly exercises the formerly broken
 * idle-parent delivery path without a real model or API key.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tryImport } from "../support/helpers.ts";
import type { RealSessionRun } from "../support/real-session-runner.ts";
import { ensureSupervisorChannelDir, resolveSupervisorChannelDir } from "../../src/intercom/native-supervisor-channel.ts";

const piCodingAgent = await tryImport<unknown>("@earendil-works/pi-coding-agent");
const piAi = await tryImport<unknown>("@earendil-works/pi-ai");
const available = Boolean(piCodingAgent && piAi);

const ASK_MARKER = "E2E_IDLE_WAKE_ASK";
const ACK_MARKER = "E2E_IDLE_WAKE_ACK";
const ASK_TIMEOUT_MS = "45000";
const createdChannels: string[] = [];

describe("idle-parent supervisor wake E2E", { skip: !available ? "pi runtime packages not available" : undefined }, () => {
	let run: RealSessionRun | undefined;
	const previousAskTimeout = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;

	afterEach(async () => {
		await run?.dispose();
		run = undefined;
		for (const channel of createdChannels.splice(0)) fs.rmSync(channel, { recursive: true, force: true });
		if (previousAskTimeout === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
		else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = previousAskTimeout;
	});

	it("wakes an idle parent to answer a supervisor ask without another user prompt", { timeout: 120_000 }, async () => {
		const { runRealSubagentSession } = await import("../support/real-session-runner.ts");
		process.env.PI_INTERCOM_ASK_TIMEOUT_MS = ASK_TIMEOUT_MS;

		let modelCalls = 0;
		let wakeContextContainsAsk = false;
		let requestId: string | undefined;
		const syntheticRequestId = randomUUID();
		run = await runRealSubagentSession({
			prompt: "Finish this turn and wait for the incoming supervisor request.",
			childText: "The simulated child asks for a supervisor decision.",
			timeoutMs: 30_000,
			respond(context) {
				modelCalls += 1;
				if (modelCalls === 1) return "Parent idle and waiting.";

				const messages = context.messages as Array<{ role?: string; content?: unknown }>;
				const serializedContext = JSON.stringify(messages);
				if (!serializedContext.includes(ASK_MARKER)) return "idle";
				wakeContextContainsAsk = true;
				requestId = syntheticRequestId;
				if (modelCalls === 2) {
					return fauxToolCall("subagent_supervisor", {
						action: "reply",
						replyTo: requestId,
						message: ACK_MARKER,
					});
				}
				return `Parent relays: ${ACK_MARKER}`;
			},
		});

		// The initial prompt has completed and no second turn is queued: this is
		// the idle state that the old sendMessage call failed to wake.
		assert.equal(run.modelCalls, 1, "parent should be idle after its initial turn");
		assert.equal(modelCalls, 1);

		const sessionId = run.parentSession.sessionManager.getSessionId();
		assert.ok(sessionId, "real parent session must have an id");
		const runId = `idle-wake-${randomUUID()}`;
		const agent = "worker";
		const childIndex = 0;
		const channelDir = resolveSupervisorChannelDir(runId, agent, childIndex);
		createdChannels.push(channelDir);
		ensureSupervisorChannelDir(channelDir);
		const request = {
			type: "subagent.supervisor.request",
			requestId: syntheticRequestId,
			id: syntheticRequestId,
			createdAt: Date.now(),
			expiresAt: Date.now() + Number(ASK_TIMEOUT_MS),
			reason: "need_decision",
			message: `Child is blocked pending a decision: ${ASK_MARKER}`,
			expectsReply: true,
			orchestratorSessionId: sessionId,
			runId,
			agent,
			childIndex,
		};
		fs.writeFileSync(path.join(channelDir, "requests", `${syntheticRequestId}.json`), JSON.stringify(request, null, "\t"));

		const deadline = Date.now() + 45_000;
		while (modelCalls < 3 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		assert.ok(modelCalls >= 2, "idle parent should start a new model turn without another user prompt");
		assert.ok(wakeContextContainsAsk, "woken model context should include the supervisor ask text");
		const recordedRequest = run.parentSession.messages.find((message) => (message as { customType?: string }).customType === "subagent_supervisor_request") as { details?: { requestId?: string; id?: string } } | undefined;
		assert.ok(recordedRequest, "parent session should record the subagent_supervisor_request custom message");
		assert.equal(recordedRequest.details?.requestId ?? recordedRequest.details?.id, syntheticRequestId);
		assert.equal(requestId, syntheticRequestId, "parent should reply to this exact request");
		assert.ok(modelCalls >= 3, "parent should continue after replying and produce a final relay");

		const replyPath = path.join(channelDir, "replies", `${syntheticRequestId}.json`);
		assert.ok(fs.existsSync(replyPath), "child's supervisor ask should receive a persisted reply");
		const reply = JSON.parse(fs.readFileSync(replyPath, "utf-8")) as { message?: string; requestId?: string };
		assert.equal(reply.requestId, syntheticRequestId);
		assert.equal(reply.message, ACK_MARKER);
		assert.match(run.parentSession.getLastAssistantText() ?? "", new RegExp(ACK_MARKER));
	});
});
