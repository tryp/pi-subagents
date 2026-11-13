import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tryImport } from "../support/helpers.ts";

const piCodingAgent = await tryImport<unknown>("@earendil-works/pi-coding-agent");
const piAi = await tryImport<unknown>("@earendil-works/pi-ai");
const available = Boolean(piCodingAgent && piAi);
const scratch = mkdtempSync(path.join(os.tmpdir(), "expected-worktree-guard-e2e-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

describe("expected worktree guard real-child E2E", { skip: !available ? "pi runtime packages not available" : undefined }, () => {
	it("blocks a real write in the wrong repo and permits the matching-root control", async () => {
		const { runRealSubagentSession, subagentCall, subagentToolResults } = await import("../support/real-session-runner.ts");
		const wrongRepo = path.join(scratch, "wrong-repo");
		const expectedRepo = path.join(scratch, "expected-repo");
		for (const repo of [wrongRepo, expectedRepo]) {
			execFileSync("git", ["init", "--quiet", repo]);
		}

		const agent = `---
name: writer
description: Writes one marker through Pi's built-in write tool
tools: write
completionGuard: false
---
Write the requested marker file using the write tool.`;
		const projectFiles = { ".pi/agents/writer.md": agent };
		const originalWritePath = process.env.PI_SUBAGENTS_E2E_CHILD_WRITE_PATH;
		const runCase = async (expectedWorktreeRoot: string, marker: string) => {
			const markerPath = path.join(wrongRepo, marker);
			process.env.PI_SUBAGENTS_E2E_CHILD_WRITE_PATH = markerPath;
			return runRealSubagentSession({
				cwd: wrongRepo,
				projectFiles,
				prompt: "Ask the writer agent to create the marker file, then report the tool result.",
				childText: "unused",
				respond(context) {
					const called = (context.messages as Array<{ role?: string; toolName?: string }>).some((message) => message.role === "toolResult" && message.toolName === "subagent");
					return called
						? "Child write attempt completed."
						: subagentCall({ agent: "writer", task: `Create ${markerPath}`, context: "fresh", agentScope: "project", expectedWorktreeRoot }, `call-${marker}`);
				},
				timeoutMs: 60_000,
			});
		};

		try {
			const blocked = await runCase(expectedRepo, "blocked-marker.txt");
			try {
				assert.equal(existsSync(path.join(wrongRepo, "blocked-marker.txt")), false, "wrong-repo marker must not be written");
				const blockedResult = subagentToolResults(blocked.parentSession).join("\n");
				assert.match(blockedResult, /actual child worktree root .* does not match assigned worktree root/);
				await blocked.dispose();
			} finally {
				await blocked.dispose();
			}

			const allowed = await runCase(wrongRepo, "allowed-marker.txt");
			try {
				assert.equal(readFileSync(path.join(wrongRepo, "allowed-marker.txt"), "utf-8"), "EXPECTED_WORKTREE_WRITE_MARKER");
				assert.match(subagentToolResults(allowed.parentSession).join("\n"), /WRITE_TOOL_RESULT:/);
			} finally {
				await allowed.dispose();
			}
		} finally {
			if (originalWritePath === undefined) delete process.env.PI_SUBAGENTS_E2E_CHILD_WRITE_PATH;
			else process.env.PI_SUBAGENTS_E2E_CHILD_WRITE_PATH = originalWritePath;
		}
	});
});
