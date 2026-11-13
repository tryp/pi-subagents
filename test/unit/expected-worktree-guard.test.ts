import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import guard from "../../src/extensions/expected-worktree-guard.ts";
import { ALLOW_CROSS_PROJECT_WRITES_ENV, EXPECTED_WORKTREE_ROOT_ENV } from "../../src/runs/shared/pi-args.ts";

const oldExpected = process.env[EXPECTED_WORKTREE_ROOT_ENV];
const oldCrossProject = process.env[ALLOW_CROSS_PROJECT_WRITES_ENV];
const roots: string[] = [];

function gitRepo(parent: string, name: string): string {
	const repo = path.join(parent, name);
	fs.mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q", repo]);
	return repo;
}

function handler(): (event: { toolName: string; input: unknown }, ctx: { cwd: string }) => unknown {
	let registered: ((event: never, ctx: never) => unknown) | undefined;
	guard({ on(eventName: string, fn: (event: never, ctx: never) => unknown) {
		assert.equal(eventName, "tool_call");
		registered = fn;
	} } as never);
	assert.ok(registered, "the extension must register Pi's real pre-execution tool_call hook");
	return registered as unknown as (event: { toolName: string; input: unknown }, ctx: { cwd: string }) => unknown;
}

const originalCwd = process.cwd();

afterEach(() => {
	process.chdir(originalCwd);
	if (oldExpected === undefined) delete process.env[EXPECTED_WORKTREE_ROOT_ENV];
	else process.env[EXPECTED_WORKTREE_ROOT_ENV] = oldExpected;
	if (oldCrossProject === undefined) delete process.env[ALLOW_CROSS_PROJECT_WRITES_ENV];
	else process.env[ALLOW_CROSS_PROJECT_WRITES_ENV] = oldCrossProject;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("expected worktree tool boundary", () => {
	it("blocks write, edit, and bash when a child is assigned lane A but Pi reports master as ctx.cwd", () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "expected-lane-"));
		roots.push(fixture);
		const assignedLane = gitRepo(fixture, "assigned-lane");
		const misroutedMaster = gitRepo(fixture, "master");
		process.env[EXPECTED_WORKTREE_ROOT_ENV] = assignedLane;
		process.env[ALLOW_CROSS_PROJECT_WRITES_ENV] = "0";
		const toolCall = handler();

		for (const toolName of ["write", "edit", "custom_extension_tool"]) {
			const result = toolCall({ toolName, input: { path: "notes.md" } }, { cwd: misroutedMaster });
			assert.deepEqual(result, { block: true, reason: `blocked ${toolName}: actual child worktree root ${misroutedMaster} does not match assigned worktree root ${assignedLane}` });
		}
		assert.deepEqual(toolCall({ toolName: "bash", input: { command: "git status" } }, { cwd: misroutedMaster }), {
			block: true,
			reason: `blocked bash: actual child worktree root ${misroutedMaster} does not match assigned worktree root ${assignedLane}`,
		});
	});

	it("allows in-worktree mutations and explicit cross-project write/edit paths, but never waives cwd identity", () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "expected-lane-exception-"));
		roots.push(fixture);
		const assignedLane = gitRepo(fixture, "assigned-lane");
		const otherWorktree = gitRepo(fixture, "other-worktree");
		const outsideDir = path.join(fixture, "outside");
		fs.mkdirSync(outsideDir);
		const crossProject = path.join(outsideDir, "shared-project.md");
		fs.symlinkSync(outsideDir, path.join(assignedLane, "linked-outside"), "dir");
		process.env[EXPECTED_WORKTREE_ROOT_ENV] = assignedLane;
		const toolCall = handler();

		assert.equal(toolCall({ toolName: "write", input: { path: "notes.md" } }, { cwd: assignedLane }), undefined);
		assert.equal(toolCall({ toolName: "bash", input: { command: "git status" } }, { cwd: assignedLane }), undefined);
		assert.deepEqual(toolCall({ toolName: "write", input: { path: crossProject } }, { cwd: assignedLane }), {
			block: true,
			reason: `blocked write: target ${crossProject} resolves outside assigned worktree ${assignedLane}; set allowCrossProjectWrites only for deliberate cross-project writes`,
		});
		assert.match(String((toolCall({ toolName: "edit", input: { path: "linked-outside/escape.md" } }, { cwd: assignedLane }) as { reason: string }).reason), /resolves outside assigned worktree/);
		fs.symlinkSync(path.join(fixture, "missing-target"), path.join(assignedLane, "dangling-outside"));
		assert.match(String((toolCall({ toolName: "write", input: { path: "dangling-outside/file.md" } }, { cwd: assignedLane }) as { reason: string }).reason), /cannot safely resolve/);
		process.env[ALLOW_CROSS_PROJECT_WRITES_ENV] = "1";
		assert.equal(toolCall({ toolName: "edit", input: { path: crossProject } }, { cwd: assignedLane }), undefined);
		assert.match(String((toolCall({ toolName: "bash", input: { command: "pwd" } }, { cwd: otherWorktree }) as { reason: string }).reason), /does not match assigned worktree root/);
	});

	it("does not change unbound sessions", () => {
		delete process.env[EXPECTED_WORKTREE_ROOT_ENV];
		const toolCall = handler();
		assert.equal(toolCall({ toolName: "write", input: { path: "/outside/file" } }, { cwd: "/" }), undefined);
		assert.equal(toolCall({ toolName: "bash", input: { command: "true" } }, { cwd: "/" }), undefined);
		process.env[EXPECTED_WORKTREE_ROOT_ENV] = "   ";
		assert.deepEqual(toolCall({ toolName: "read", input: { path: "README.md" } }, { cwd: "/" }), {
			block: true,
			reason: "assigned worktree root must be a non-empty absolute path; refusing all tool calls",
		});
		process.env[EXPECTED_WORKTREE_ROOT_ENV] = "relative/root";
		assert.match(String((toolCall({ toolName: "read", input: { path: "README.md" } }, { cwd: "/" }) as { reason: string }).reason), /non-empty absolute path/);
	});
});
