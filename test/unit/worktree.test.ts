import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	cleanupWorktrees,
	createWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeSalvageNotice,
	pruneExpiredSalvageRefs,
	resolveExpectedWorktreeAgentCwd,
	type WorktreeSetup,
} from "../../src/runs/shared/worktree.ts";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(message);
	}
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Worktree Tests"]);
	fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n", "utf-8");
	fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
}

function cleanupRepo(repoDir: string): void {
	try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
}

function createHookScript(_repoDir: string, fileName: string, source: string): string {
	const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-hook-script-"));
	const hookPath = path.join(hooksDir, fileName);
	fs.writeFileSync(hookPath, `#!/usr/bin/env node\n${source}\n`, "utf-8");
	fs.chmodSync(hookPath, 0o755);
	return hookPath;
}

const hookScriptSkip = process.platform === "win32"
	? "Hook script execution differs on Windows CI environments."
	: undefined;

describe("worktree", () => {
	it("createWorktrees returns expected structure", () => {
		const repoDir = createRepo("pi-worktree-structure-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "structure", 2);
			assert.equal(setup.worktrees.length, 2);
			assert.equal(setup.cwd, git(repoDir, ["rev-parse", "--show-toplevel"]));
			for (let i = 0; i < setup.worktrees.length; i++) {
				const worktree = setup.worktrees[i]!;
				assert.equal(worktree.branch, `pi-parallel-structure-${i}`);
				assert.equal(worktree.index, i);
				assert.equal(worktree.agentCwd, worktree.path);
				assert.equal(worktree.nodeModulesLinked, false);
				assert.deepEqual(worktree.syntheticPaths, []);
				assert.ok(fs.existsSync(worktree.path), `worktree path missing: ${worktree.path}`);
			}
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees maps subdirectory cwd to each agentCwd", () => {
		const repoDir = createRepo("pi-worktree-subdir-");
		const nestedDir = path.join(repoDir, "packages", "app");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "index.ts"), "export const value = 1;\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "add nested dir"]);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(nestedDir, "subdir", 1);
			assert.equal(setup.worktrees[0]!.agentCwd, path.join(setup.worktrees[0]!.path, "packages", "app"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("previews expected worktree agent cwd for repository subdirectories", () => {
		const repoDir = createRepo("pi-worktree-preview-");
		const nestedDir = path.join(repoDir, "packages", "app");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "index.ts"), "export const value = 1;\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "add nested dir"]);

		try {
			assert.equal(
				resolveExpectedWorktreeAgentCwd(nestedDir, "preview", 2),
				path.join(os.tmpdir(), "pi-worktree-preview-2", "packages", "app"),
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("creates worktrees under a configured base directory", () => {
		const repoDir = createRepo("pi-worktree-base-dir-");
		const baseDir = path.join(os.tmpdir(), `pi-worktree-base-${Date.now().toString(36)}`, "nested");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "base-dir", 1, { baseDir });
			assert.equal(setup.worktrees[0]!.path, path.join(baseDir, "pi-worktree-base-dir-0"));
			assert.ok(fs.existsSync(baseDir), "configured base directory should be created");
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
			fs.rmSync(path.dirname(baseDir), { recursive: true, force: true });
		}
	});

	it("uses PI_SUBAGENTS_WORKTREE_DIR when no base directory is configured", () => {
		const repoDir = createRepo("pi-worktree-env-base-dir-");
		const previous = process.env.PI_SUBAGENTS_WORKTREE_DIR;
		const baseDir = path.join(os.tmpdir(), `pi-worktree-env-base-${Date.now().toString(36)}`);
		let setup: WorktreeSetup | undefined;
		try {
			process.env.PI_SUBAGENTS_WORKTREE_DIR = baseDir;
			setup = createWorktrees(repoDir, "env-base-dir", 1);
			assert.equal(setup.worktrees[0]!.path, path.join(baseDir, "pi-worktree-env-base-dir-0"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			if (previous === undefined) {
				delete process.env.PI_SUBAGENTS_WORKTREE_DIR;
			} else {
				process.env.PI_SUBAGENTS_WORKTREE_DIR = previous;
			}
			cleanupRepo(repoDir);
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("createWorktrees rejects dirty repositories", () => {
		const repoDir = createRepo("pi-worktree-dirty-");
		try {
			fs.writeFileSync(path.join(repoDir, "tracked.txt"), "dirty\n", "utf-8");
			assert.throws(
				() => createWorktrees(repoDir, "dirty", 1),
				/worktree isolation requires a clean git working tree/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("findWorktreeTaskCwdConflict allows omitted or matching task cwd values", () => {
		const sharedCwd = path.join("/tmp", "repo");
		assert.equal(
			findWorktreeTaskCwdConflict(
				[
					{ agent: "worker-a" },
					{ agent: "worker-b", cwd: sharedCwd },
				],
				sharedCwd,
			),
			undefined,
		);
	});

	it("findWorktreeTaskCwdConflict treats relative task cwd values as relative to the shared cwd", () => {
		const sharedCwd = path.join("/tmp", "repo");
		assert.equal(
			findWorktreeTaskCwdConflict(
				[{ agent: "worker-a", cwd: "." }],
				sharedCwd,
			),
			undefined,
		);
	});

	it("findWorktreeTaskCwdConflict returns the first conflicting task cwd", () => {
		const sharedCwd = path.join("/tmp", "repo");
		const conflict = findWorktreeTaskCwdConflict(
			[
				{ agent: "worker-a", cwd: sharedCwd },
				{ agent: "worker-b", cwd: path.join(sharedCwd, "packages", "app") },
			],
			sharedCwd,
		);
		assert.deepEqual(conflict, {
			index: 1,
			agent: "worker-b",
			cwd: path.join(sharedCwd, "packages", "app"),
		});
	});

	it("cleanupWorktrees captures uncommitted changes as a working-tree patch", () => {
		const repoDir = createRepo("pi-worktree-dirty-");
		const artifactDir = path.join(repoDir, "artifacts", "dirty");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "dirty", 1, { artifactDir });
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "tracked.txt"), "modified\n", "utf-8");
			fs.writeFileSync(path.join(worktree.path, "new-file.ts"), "export const added = true;\n", "utf-8");
			const branch = worktree.branch;
			cleanupWorktrees(setup);
			setup = undefined;

			assert.equal(fs.existsSync(worktree.path), false);
			assert.equal(git(repoDir, ["branch", "--list", branch]), "");
			assert.equal(git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/pi-salvage"]), "");
			const recordPath = path.join(artifactDir, "run-dirty", "worktree-0.json");
			const record = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as {
				uniqueCommits: unknown[];
				salvageRef?: string;
				formatPatch?: string;
				workingTreePatch?: string;
			};
			assert.deepEqual(record.uniqueCommits, []);
			assert.equal(record.salvageRef, undefined);
			assert.equal(record.formatPatch, undefined);
			assert.equal(record.workingTreePatch, "worktree-0-working-tree.patch");
			const patch = fs.readFileSync(path.join(artifactDir, "run-dirty", record.workingTreePatch!), "utf-8");
			assert.match(patch, /tracked\.txt/);
			assert.match(patch, /new-file\.ts/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("cleanupWorktrees separates committed work from uncommitted changes", () => {
		const repoDir = createRepo("pi-worktree-mixed-");
		const artifactDir = path.join(repoDir, "artifacts", "mixed");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "mixed", 1, { artifactDir });
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "committed.ts"), "export const committed = true;\n", "utf-8");
			git(worktree.path, ["add", "committed.ts"]);
			git(worktree.path, ["commit", "-m", "committed worker change"]);
			fs.writeFileSync(path.join(worktree.path, "tracked.txt"), "modified\n", "utf-8");
			cleanupWorktrees(setup);
			setup = undefined;

			const salvageRefs = git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/pi-salvage"]).split("\n").filter(Boolean);
			assert.equal(salvageRefs.length, 1);
			assert.match(salvageRefs[0]!, /^refs\/pi-salvage\/managed\/v1\/\d{13}-mixed-0$/);
			const commitPatch = fs.readFileSync(path.join(artifactDir, "run-mixed", "worktree-0.patch"), "utf-8");
			assert.match(commitPatch, /committed worker change/);
			const recordPath = path.join(artifactDir, "run-mixed", "worktree-0.json");
			const record = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as { workingTreePatch?: string };
			assert.equal(record.workingTreePatch, "worktree-0-working-tree.patch");
			const dirtyPatch = fs.readFileSync(path.join(artifactDir, "run-mixed", record.workingTreePatch!), "utf-8");
			assert.match(dirtyPatch, /tracked\.txt/);
			assert.doesNotMatch(dirtyPatch, /committed\.ts/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("cleanupWorktrees writes no working-tree patch when the worktree is clean", () => {
		const repoDir = createRepo("pi-worktree-clean-");
		const artifactDir = path.join(repoDir, "artifacts", "clean");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "clean", 1, { artifactDir });
			git(setup.worktrees[0]!.path, ["commit", "--allow-empty", "-m", "empty commit"]);
			cleanupWorktrees(setup);
			setup = undefined;

			assert.equal(fs.existsSync(path.join(artifactDir, "run-clean", "worktree-0-working-tree.patch")), false);
			const record = JSON.parse(fs.readFileSync(path.join(artifactDir, "run-clean", "worktree-0.json"), "utf-8")) as { workingTreePatch?: string };
			assert.equal(record.workingTreePatch, undefined);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("surfaces a patch-only salvage (uncommitted work, no commits) in the notice", () => {
		const repoDir = createRepo("pi-worktree-patch-only-");
		const artifactDir = path.join(repoDir, "artifacts", "step-0");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "patch-only", 1, { artifactDir });
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "uncommitted.txt"), "dirty\n");
			const branch = worktree.branch;
			const cleanupSummary = cleanupWorktrees(setup);
			assert.equal(cleanupSummary.outcomes.length, 1);
			const outcome = cleanupSummary.outcomes[0]!;
			assert.equal(outcome.commits.length, 0);
			assert.equal(outcome.salvageRef, undefined);
			assert.ok(outcome.workingTreePatch, "expected a working-tree patch for dirty work");
			const notice = formatWorktreeSalvageNotice(cleanupSummary);
			assert.match(notice, /uncommitted work captured from branch/);
			assert.match(notice, new RegExp(branch));
			setup = undefined;
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("cleanupWorktrees removes worktrees and branches", () => {
		const repoDir = createRepo("pi-worktree-cleanup-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "cleanup", 2);
			const worktreePaths = setup.worktrees.map((worktree) => worktree.path);
			const branches = setup.worktrees.map((worktree) => worktree.branch);
			const cleanupSummary = cleanupWorktrees(setup);
			assert.equal(cleanupSummary.outcomes.length, 2);
			assert.ok(cleanupSummary.outcomes.every((outcome) => outcome.commits.length === 0 && !outcome.salvageRef));
			assert.equal(formatWorktreeSalvageNotice(cleanupSummary), "");
			setup = undefined;

			for (const worktreePath of worktreePaths) {
				assert.equal(fs.existsSync(worktreePath), false, `worktree path still exists: ${worktreePath}`);
			}
			for (const branch of branches) {
				const branchResult = git(repoDir, ["branch", "--list", branch]);
				assert.equal(branchResult.trim(), "", `branch still exists: ${branch}`);
			}
			assert.equal(git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/pi-salvage"]), "");
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("salvages unique commits before removing the worktree and branch", () => {
		const repoDir = createRepo("pi-worktree-salvage-");
		const artifactDir = path.join(repoDir, "artifacts", "step-0");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "salvage", 1, { artifactDir });
			const worktree = setup.worktrees[0]!;
			git(worktree.path, ["commit", "--allow-empty", "-m", "recoverable worker change"]);
			const commit = git(worktree.path, ["rev-parse", "HEAD"]);
			const branch = worktree.branch;
			const cleanupSummary = cleanupWorktrees(setup);
			assert.equal(cleanupSummary.outcomes.length, 1);
			assert.equal(cleanupSummary.outcomes[0]!.branch, branch);
			assert.deepEqual(cleanupSummary.outcomes[0]!.commits.map((entry) => entry.sha), [commit]);
			assert.equal(cleanupSummary.outcomes[0]!.salvageRef, `refs/pi-salvage/managed/v1/${setup.salvageStartedAtMs}-salvage-0`);
			assert.equal(cleanupSummary.outcomes[0]!.artifactDir, setup.salvageDir);
			assert.match(formatWorktreeSalvageNotice(cleanupSummary), /1 commit\(s\) pinned from branch/);
			setup = undefined;

			assert.equal(fs.existsSync(worktree.path), false);
			assert.equal(git(repoDir, ["branch", "--list", branch]), "");
			const salvageRefs = git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/pi-salvage"]).split("\n").filter(Boolean);
			assert.equal(salvageRefs.length, 1);
			assert.match(salvageRefs[0]!, /^refs\/pi-salvage\/managed\/v1\/\d{13}-salvage-0$/);
			assert.equal(git(repoDir, ["rev-parse", salvageRefs[0]!]), commit);
			const recordPath = path.join(artifactDir, "run-salvage", "worktree-0.json");
			const record = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as { uniqueCommits: Array<{ sha: string; subject: string; authorDate: string }>; salvageRef?: string; workingTreePatch?: string };
			assert.equal(record.salvageRef, salvageRefs[0]);
			assert.equal(record.workingTreePatch, undefined);
			assert.deepEqual(record.uniqueCommits[0], {
				sha: commit,
				subject: "recoverable worker change",
				authorDate: record.uniqueCommits[0]!.authorDate,
			});
			assert.match(record.uniqueCommits[0]!.authorDate, /^\d{4}-\d{2}-\d{2}T/);
			const patch = fs.readFileSync(path.join(artifactDir, "run-salvage", "worktree-0.patch"), "utf-8");
			assert.match(patch, /recoverable worker change/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("cleanupWorktrees reports inspection failures and retains the original branch", () => {
		const repoDir = createRepo("pi-worktree-inspection-error-");
		const artifactDir = path.join(repoDir, "artifacts");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "inspection-error", 1, { artifactDir });
			const worktree = setup.worktrees[0]!;
			const originalBranch = worktree.branch;
			worktree.branch = "missing-worker-branch";
			const cleanupSummary = cleanupWorktrees(setup);
			setup = undefined;

			assert.equal(cleanupSummary.outcomes.length, 1);
			assert.equal(cleanupSummary.outcomes[0]!.branch, "missing-worker-branch");
			assert.deepEqual(cleanupSummary.outcomes[0]!.commits, []);
			assert.ok(cleanupSummary.outcomes[0]!.inspectionError);
			assert.match(formatWorktreeSalvageNotice(cleanupSummary), /Worktree salvage warning: could not inspect missing-worker-branch/);
			assert.equal(git(repoDir, ["branch", "--list", originalBranch]), originalBranch);
			assert.equal(fs.existsSync(worktree.path), false);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("pruneExpiredSalvageRefs drops only expired managed salvage refs", () => {
		const repoDir = createRepo("pi-worktree-prune-");
		try {
			const head = git(repoDir, ["rev-parse", "HEAD"]);
			const now = Date.now();
			const day = 24 * 60 * 60 * 1000;
			const make = (ref: string) => git(repoDir, ["update-ref", ref, head]);
			make(`refs/pi-salvage/managed/v1/${now - 31 * day}-oldrun-0`);
			make(`refs/pi-salvage/managed/v1/${now - 30 * day}-boundary-0`);
			make(`refs/pi-salvage/managed/v1/${now}-fresh-0`);
			make(`refs/pi-salvage/manual-round4-0`);
			make(`refs/pi-salvage/legacy-0`);
			make(`refs/pi-salvage/managed/v1/notanumber-run-0`);

			pruneExpiredSalvageRefs(repoDir, now);

			const remaining = git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/pi-salvage"]).split("\n").filter(Boolean);
			assert.deepEqual(remaining.sort(), [
				"refs/pi-salvage/legacy-0",
				`refs/pi-salvage/managed/v1/${now - 30 * day}-boundary-0`,
				`refs/pi-salvage/managed/v1/${now}-fresh-0`,
				"refs/pi-salvage/managed/v1/notanumber-run-0",
				"refs/pi-salvage/manual-round4-0",
			]);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees prunes expired managed salvage refs at setup", () => {
		const repoDir = createRepo("pi-worktree-prune-setup-");
		let setup: WorktreeSetup | undefined;
		try {
			const head = git(repoDir, ["rev-parse", "HEAD"]);
			const staleEpoch = Date.now() - 31 * 24 * 60 * 60 * 1000;
			git(repoDir, ["update-ref", `refs/pi-salvage/managed/v1/${staleEpoch}-oldrun-0`, head]);
			setup = createWorktrees(repoDir, "prune-setup", 1);
			const remaining = git(repoDir, ["for-each-ref", "--format=%(refname)", "refs/pi-salvage"]).split("\n").filter(Boolean);
			assert.deepEqual(remaining, []);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees creates node_modules symlink when node_modules exists", {
		skip: process.platform === "win32" ? "Symlink behavior differs on Windows CI environments." : undefined,
	}, () => {
		const repoDir = createRepo("pi-worktree-node-modules-");
		const nodeModulesDir = path.join(repoDir, "node_modules");
		fs.mkdirSync(nodeModulesDir, { recursive: true });
		fs.writeFileSync(path.join(nodeModulesDir, "fixture.txt"), "fixture\n", "utf-8");

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "node-modules", 1);
			const symlinkPath = path.join(setup.worktrees[0]!.path, "node_modules");
			assert.equal(setup.worktrees[0]!.nodeModulesLinked, true);
			assert.deepEqual(setup.worktrees[0]!.syntheticPaths, ["node_modules"]);
			assert.ok(fs.existsSync(symlinkPath), "node_modules link should exist");
			assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true, "node_modules should be a symlink");
			assert.equal(fs.realpathSync(symlinkPath), fs.realpathSync(nodeModulesDir));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("working-tree capture preserves a tracked node_modules symlink", {
		skip: process.platform === "win32" ? "Symlink behavior differs on Windows CI environments." : undefined,
	}, () => {
		const repoDir = createRepo("pi-worktree-tracked-node-modules-");
		const vendorDir = path.join(repoDir, "vendor-modules");
		fs.mkdirSync(vendorDir, { recursive: true });
		fs.writeFileSync(path.join(vendorDir, "fixture.txt"), "fixture\n", "utf-8");
		fs.symlinkSync("vendor-modules", path.join(repoDir, "node_modules"));
		git(repoDir, ["add", "vendor-modules", "-f", "node_modules"]);
		git(repoDir, ["commit", "-m", "track node_modules symlink"]);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "tracked-node-modules", 1, { artifactDir: path.join(repoDir, "artifacts") });
			assert.equal(setup.worktrees[0]!.nodeModulesLinked, false);
			assert.deepEqual(setup.worktrees[0]!.syntheticPaths, []);
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified\n", "utf-8");
			assert.equal(fs.lstatSync(path.join(setup.worktrees[0]!.path, "node_modules")).isSymbolicLink(), true);

			cleanupWorktrees(setup);
			setup = undefined;
			const patch = fs.readFileSync(path.join(repoDir, "artifacts", "run-tracked-node-modules", "worktree-0-working-tree.patch"), "utf-8");
			assert.match(patch, /tracked\.txt/);
			assert.doesNotMatch(patch, /diff --git a\/node_modules b\/node_modules/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("runs a repo-relative worktree setup hook and records synthetic paths", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-relative-");
		const hookPath = createHookScript(repoDir, "setup-hook.mjs", `
import * as fs from "node:fs";
import * as path from "node:path";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
fs.mkdirSync(path.join(payload.worktreePath, ".venv"), { recursive: true });
fs.writeFileSync(path.join(payload.worktreePath, ".venv", "pyvenv.cfg"), "home=/tmp\\n", "utf-8");
process.stdout.write(JSON.stringify({ syntheticPaths: [".venv"] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "hook-relative", 1, {
				setupHook: { hookPath: path.relative(repoDir, hookPath) },
			});
			assert.ok(setup.worktrees[0]!.syntheticPaths.includes(".venv"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("runs an absolute worktree setup hook path", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-absolute-");
		const hookPath = createHookScript(repoDir, "setup-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "hook-absolute", 1, {
				setupHook: { hookPath },
			});
			assert.equal(setup.worktrees.length, 1);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("rejects bare command names for worktree setup hooks", () => {
		const repoDir = createRepo("pi-worktree-hook-bare-");
		try {
			assert.throws(
				() => createWorktrees(repoDir, "hook-bare", 1, { setupHook: { hookPath: "node" } }),
				/worktree setup hook must be an absolute path or a repo-relative path/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects tracked synthetic paths from hook output", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-tracked-");
		const hookPath = createHookScript(repoDir, "tracked-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: ["tracked.txt"] }));
`);
		const runId = `hook-tracked-${Date.now().toString(36)}`;
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 1, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/cannot mark tracked paths as synthetic/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects absolute synthetic paths from hook output", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-absolute-synthetic-");
		const hookPath = createHookScript(repoDir, "absolute-path-hook.mjs", `
import * as fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: [payload.worktreePath + "/.venv"] }));
`);
		const runId = `hook-absolute-synthetic-${Date.now().toString(36)}`;
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 1, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/synthetic path must be relative/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("excludes hook-created synthetic files from captured patch output", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-diff-");
		const hookPath = createHookScript(repoDir, "setup-copy-hook.mjs", `
import * as fs from "node:fs";
import * as path from "node:path";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
fs.writeFileSync(path.join(payload.worktreePath, ".env.local"), "TOKEN=secret\\n", "utf-8");
process.stdout.write(JSON.stringify({ syntheticPaths: [".env.local"] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "hook-diff", 1, {
				setupHook: { hookPath: path.relative(repoDir, hookPath) },
				artifactDir: path.join(repoDir, "artifacts"),
			});
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified-by-agent\n", "utf-8");
			cleanupWorktrees(setup);
			setup = undefined;
			const patch = fs.readFileSync(path.join(repoDir, "artifacts", "run-hook-diff", "worktree-0-working-tree.patch"), "utf-8");
			assert.match(patch, /tracked\.txt/);
			assert.doesNotMatch(patch, /\.env\.local/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("cleans up created worktrees when a later hook setup fails", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-cleanup-");
		const runId = `hook-cleanup-${Date.now().toString(36)}`;
		const hookPath = createHookScript(repoDir, "flaky-hook.mjs", `
import * as fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
if (payload.index === 1) {
	console.error("intentional failure");
	process.exit(1);
}
process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
`);
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 2, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/worktree setup hook failed with exit code 1/i,
			);
			const branchList = git(repoDir, ["branch", "--list", `pi-parallel-${runId}-*`]);
			assert.equal(branchList.trim(), "", "temporary branches should be cleaned up after setup failure");
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("fails when the hook exceeds the configured timeout", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-timeout-");
		const hookPath = createHookScript(repoDir, "slow-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
setTimeout(() => {
	process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
}, 1000);
`);
		const runId = `hook-timeout-${Date.now().toString(36)}`;
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 1, {
					setupHook: { hookPath: path.relative(repoDir, hookPath), timeoutMs: 50 },
				}),
				/timed out/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});
});
