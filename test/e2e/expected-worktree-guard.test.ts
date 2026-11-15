import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tryImport } from "../support/helpers.ts";

const piCodingAgent = await tryImport<unknown>("@earendil-works/pi-coding-agent");
const piAi = await tryImport<unknown>("@earendil-works/pi-ai");
const available = Boolean(piCodingAgent && piAi);
const scratch = mkdtempSync(path.join(os.tmpdir(), "expected-worktree-guard-e2e-"));

function createCommittedProject(repo: string): void {
	mkdirSync(path.join(repo, ".pi", "agents"), { recursive: true });
	execFileSync("git", ["init", "--quiet", repo]);
	execFileSync("git", ["-C", repo, "config", "user.email", "e2e@example.com"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Subagent E2E"]);
	writeFileSync(path.join(repo, ".pi", "agents", "writer.md"), `---
name: writer
description: Reports child cwd
completionGuard: false
tools: write
---
Report your exact process cwd.
`, "utf-8");
	writeFileSync(path.join(repo, "tracked.txt"), "fixture\n", "utf-8");
	execFileSync("git", ["-C", repo, "add", "-A"]);
	execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "E2E fixture"]);
}

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

	it("uses the assigned cwd for a real worktree child and rejects a mismatched policy before spawning", async () => {
		const { runRealSubagentSession, subagentCall, subagentToolResults } = await import("../support/real-session-runner.ts");
		const projectRepo = path.join(scratch, "child-cwd-project");
		const wrongPolicyRepo = path.join(scratch, "child-cwd-wrong-policy");
		mkdirSync(projectRepo, { recursive: true });
		mkdirSync(wrongPolicyRepo, { recursive: true });
		createCommittedProject(projectRepo);
		execFileSync("git", ["init", "--quiet", wrongPolicyRepo]);
		const originalReportCwd = process.env.PI_SUBAGENTS_E2E_REPORT_CHILD_CWD;
		const originalWritePath = process.env.PI_SUBAGENTS_E2E_CHILD_WRITE_PATH;
		process.env.PI_SUBAGENTS_E2E_REPORT_CHILD_CWD = "1";
		process.env.PI_SUBAGENTS_E2E_CHILD_WRITE_PATH = path.join(projectRepo, "outside-worktree-marker.txt");
		const runWorktreeTask = (expectedWorktreeRoot?: string) => runRealSubagentSession({
			cwd: projectRepo,
			prompt: "Run the assigned worktree task and report its result.",
			childText: "unused",
			respond(context) {
				const called = (context.messages as Array<{ role?: string; toolName?: string }>).some((message) => message.role === "toolResult" && message.toolName === "subagent");
				if (called) return "Child finished.";
				return subagentCall({
					tasks: [{ agent: "writer", task: "Report your exact process.cwd().", ...(expectedWorktreeRoot ? { expectedWorktreeRoot } : {}) }],
					worktree: true,
					async: false,
					agentScope: "project",
					context: "fresh",
				}, expectedWorktreeRoot ? "call-mismatched-worktree" : "call-matched-worktree");
			},
			timeoutMs: 90_000,
		});

		try {
			const launched = await runWorktreeTask();
			try {
				const launchedResult = subagentToolResults(launched.parentSession).join("\n");
				const cwdMatch = launchedResult.match(/CHILD_PROCESS_CWD:([^\s\]]+)/);
				assert.ok(cwdMatch, `real child should report process.cwd(): ${launchedResult}`);
				assert.notEqual(path.resolve(cwdMatch![1]!), projectRepo);
				assert.match(cwdMatch![1]!, /pi-worktree-/);
				assert.match(launchedResult, /resolves outside assigned worktree/);
				assert.equal(existsSync(path.join(projectRepo, "outside-worktree-marker.txt")), false);
			} finally {
				await launched.dispose();
			}

			const rejected = await runWorktreeTask(wrongPolicyRepo);
			try {
				const rejectedResult = subagentToolResults(rejected.parentSession).join("\n");
				assert.match(rejectedResult, /Blocked before implementation: root mismatch/);
				assert.match(rejectedResult, /Retry without worktree/);
				assert.doesNotMatch(rejectedResult, /CHILD_PROCESS_CWD:/, "mismatched policy must fail before a child process starts");
			} finally {
				await rejected.dispose();
			}
		} finally {
			if (originalReportCwd === undefined) delete process.env.PI_SUBAGENTS_E2E_REPORT_CHILD_CWD;
			else process.env.PI_SUBAGENTS_E2E_REPORT_CHILD_CWD = originalReportCwd;
			if (originalWritePath === undefined) delete process.env.PI_SUBAGENTS_E2E_CHILD_WRITE_PATH;
			else process.env.PI_SUBAGENTS_E2E_CHILD_WRITE_PATH = originalWritePath;
		}
	});
});
