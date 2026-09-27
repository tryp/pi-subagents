import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorktreeSetup {
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
	runId: string;
	salvageStartedAtMs: number;
	salvageDir?: string;
}

interface WorktreeInfo {
	path: string;
	agentCwd: string;
	branch: string;
	index: number;
	nodeModulesLinked: boolean;
	syntheticPaths: string[];
}

interface WorktreeTaskCwdConflict {
	index: number;
	agent: string;
	cwd: string;
}

interface WorktreeSetupHookConfig {
	hookPath: string;
	timeoutMs?: number;
}

interface CreateWorktreesOptions {
	agents?: string[];
	setupHook?: WorktreeSetupHookConfig;
	baseDir?: string;
	artifactDir?: string;
}

interface ResolvedWorktreeSetupHook {
	hookPath: string;
	timeoutMs: number;
}

interface WorktreeSetupHookInput {
	version: 1;
	repoRoot: string;
	worktreePath: string;
	agentCwd: string;
	branch: string;
	index: number;
	runId: string;
	baseCommit: string;
	agent?: string;
}

interface WorktreeSetupHookOutput {
	syntheticPaths?: string[];
}

interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

interface RepoState {
	toplevel: string;
	cwdRelative: string;
	baseCommit: string;
}

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;

function runGit(cwd: string, args: string[], env?: Record<string, string>): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf-8",
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
	};
}

function runGitChecked(cwd: string, args: string[], env?: Record<string, string>): string {
	const result = runGit(cwd, args, env);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

function resolveRepoState(cwd: string): RepoState {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const toplevel = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();

	const status = runGitChecked(toplevel, ["status", "--porcelain"]);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	}

	const baseCommit = runGitChecked(toplevel, ["rev-parse", "HEAD"]).trim();
	return { toplevel, cwdRelative, baseCommit };
}

function normalizeComparableCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	try {
		return fs.realpathSync(resolved);
	} catch {
		// Use the unresolved absolute path when realpath resolution is unavailable.
		return resolved;
	}
}

export function findWorktreeTaskCwdConflict(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): WorktreeTaskCwdConflict | undefined {
	const normalizedSharedCwd = normalizeComparableCwd(sharedCwd);
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index]!;
		if (!task.cwd) continue;
		const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
		if (normalizeComparableCwd(taskCwd) === normalizedSharedCwd) continue;
		return { index, agent: task.agent, cwd: task.cwd };
	}
	return undefined;
}

export function formatWorktreeTaskCwdConflict(
	conflict: WorktreeTaskCwdConflict,
	sharedCwd: string,
): string {
	return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}

function safeArtifactName(value: string): string {
	return value.replace(/[^\w.-]/g, "_");
}

function buildWorktreeBranch(runId: string, index: number): string {
	return `pi-parallel-${runId}-${index}`;
}

function resolveWorktreeBaseDir(configuredBaseDir: string | undefined, repoRoot: string): string {
	const rawBaseDir = configuredBaseDir ?? process.env.PI_SUBAGENTS_WORKTREE_DIR;
	if (rawBaseDir === undefined) return os.tmpdir();

	const trimmed = rawBaseDir.trim();
	if (!trimmed) throw new Error("worktree base directory cannot be empty");

	const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
	try {
		fs.mkdirSync(resolved, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to create worktree base directory ${resolved}: ${message}`);
	}
	return resolved;
}

function buildWorktreePath(baseDir: string, runId: string, index: number): string {
	return path.join(baseDir, `pi-worktree-${runId}-${index}`);
}

function resolveRepoCwdRelative(cwd: string): string {
	const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
	const normalizedPrefix = rawPrefix
		? path.normalize(rawPrefix.replace(/[\\/]+$/, ""))
		: "";
	return normalizedPrefix === "." ? "" : normalizedPrefix;
}

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number, baseDir?: string): string {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const repoRoot = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
	const worktreePath = buildWorktreePath(resolveWorktreeBaseDir(baseDir, repoRoot), runId, index);
	return cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string): boolean {
	const nodeModulesPath = path.join(toplevel, "node_modules");
	const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
	if (!fs.existsSync(nodeModulesPath) || fs.existsSync(nodeModulesLinkPath)) return false;
	try {
		fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath);
		return true;
	} catch {
		// Symlink creation is optional (e.g., unsupported filesystems on CI runners).
		return false;
	}
}

function parseHookTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("worktree setup hook timeout must be an integer greater than 0");
	}
	return timeoutMs;
}

function resolveWorktreeSetupHook(
	repoRoot: string,
	config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
	if (!config) return undefined;
	const hookPath = config.hookPath.trim();
	if (!hookPath) {
		throw new Error("worktree setup hook path cannot be empty");
	}

	const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
	let resolvedPath: string;
	if (path.isAbsolute(expandedHookPath)) {
		resolvedPath = expandedHookPath;
	} else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
		resolvedPath = path.resolve(repoRoot, expandedHookPath);
	} else {
		throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
	}

	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`worktree setup hook not found: ${resolvedPath}`);
	}
	if (fs.statSync(resolvedPath).isDirectory()) {
		throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
	}

	return {
		hookPath: resolvedPath,
		timeoutMs: parseHookTimeout(config.timeoutMs),
	};
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) throw new Error("synthetic path cannot be empty");
	if (path.isAbsolute(trimmed)) throw new Error(`synthetic path must be relative: ${rawPath}`);

	const resolved = path.resolve(worktreePath, trimmed);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === ".") {
		throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
	}
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
	}
	return path.normalize(relative);
}

function hasTrackedEntries(worktreePath: string, relativePath: string): boolean {
	const result = runGit(worktreePath, ["ls-files", "--", relativePath]);
	return result.status === 0 && result.stdout.trim().length > 0;
}

function parseWorktreeSetupHookOutput(rawStdout: string): WorktreeSetupHookOutput {
	const trimmed = rawStdout.trim();
	if (!trimmed) {
		throw new Error("worktree setup hook returned empty stdout; expected JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`worktree setup hook returned invalid JSON: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("worktree setup hook stdout must be a JSON object");
	}
	return parsed as WorktreeSetupHookOutput;
}

function runWorktreeSetupHook(
	hook: ResolvedWorktreeSetupHook,
	input: WorktreeSetupHookInput,
): string[] {
	const result = spawnSync(hook.hookPath, [], {
		cwd: input.worktreePath,
		encoding: "utf-8",
		input: JSON.stringify(input),
		timeout: hook.timeoutMs,
		shell: false,
	});

	if (result.error) {
		const code = "code" in result.error ? result.error.code : undefined;
		if (code === "ETIMEDOUT") {
			throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
		}
		throw new Error(`worktree setup hook failed: ${result.error.message}`);
	}

	if (result.status !== 0) {
		const details = result.stderr.trim() || result.stdout.trim() || "no output";
		throw new Error(`worktree setup hook failed with exit code ${result.status}: ${details}`);
	}

	const output = parseWorktreeSetupHookOutput(result.stdout);
	if (output.syntheticPaths === undefined) return [];
	if (!Array.isArray(output.syntheticPaths)) {
		throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
	}

	const uniquePaths = new Set<string>();
	for (const candidate of output.syntheticPaths) {
		if (typeof candidate !== "string") {
			throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
		}
		const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
		if (hasTrackedEntries(input.worktreePath, normalizedPath)) {
			throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
		}
		uniquePaths.add(normalizedPath);
	}
	return [...uniquePaths];
}

function createSingleWorktree(
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	baseDir: string,
): WorktreeInfo {
	const branch = buildWorktreeBranch(runId, index);
	const worktreePath = buildWorktreePath(baseDir, runId, index);
	const add = runGit(toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
	if (add.status !== 0) {
		const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
		throw new Error(message);
	}

	const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
	try {
		const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktreePath);
		const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];

		if (setupHook) {
			const hookSyntheticPaths = runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: toplevel,
				worktreePath,
				agentCwd,
				branch,
				index,
				runId,
				baseCommit,
				agent,
			});
			syntheticPaths.push(...hookSyntheticPaths);
		}

		return {
			path: worktreePath,
			agentCwd,
			branch,
			index,
			nodeModulesLinked,
			syntheticPaths,
		};
	} catch (error) {
		try { runGitChecked(toplevel, ["worktree", "remove", "--force", worktreePath]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		try { runGitChecked(toplevel, ["branch", "-D", branch]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		throw error;
	}
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
	const resolved = path.resolve(worktree.path, syntheticPath);
	const relative = path.relative(worktree.path, resolved);
	if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return;
	}

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolved);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}

	if (stat.isSymbolicLink()) {
		fs.unlinkSync(resolved);
		return;
	}
	if (stat.isDirectory()) {
		fs.rmSync(resolved, { recursive: true, force: true });
		return;
	}
	fs.rmSync(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): void {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree, syntheticPath);
	}
}

function captureWorkingTreePatch(setup: WorktreeSetup, worktree: WorktreeInfo): string | undefined {
	const artifactPaths = salvageArtifactPaths(setup, worktree);
	if (!artifactPaths) return undefined;

	const tempIndex = path.join(os.tmpdir(), `pi-salvage-index-${process.pid}-${Date.now()}-${worktree.index}`);
	try {
		// Capture uncommitted (staged, unstaged, untracked) changes against the
		// worktree branch HEAD using a throwaway index, so the agent's real
		// index is never mutated. Committed work is covered by format-patch.
		removeSyntheticPathsBeforeDiff(worktree);
		const env = { GIT_INDEX_FILE: tempIndex };
		runGitChecked(worktree.path, ["read-tree", "HEAD"], env);
		runGitChecked(worktree.path, ["add", "-A"], env);
		const patch = runGitChecked(worktree.path, ["diff", "--binary", "--cached", "HEAD"], env);
		if (!patch.trim()) return undefined;
		fs.mkdirSync(setup.salvageDir!, { recursive: true });
		fs.writeFileSync(artifactPaths.workingTreePatchPath, patch, "utf-8");
		return path.basename(artifactPaths.workingTreePatchPath);
	} catch {
		// Best-effort; committed-work salvage is unaffected.
		return undefined;
	} finally {
		try { fs.rmSync(tempIndex, { force: true }); } catch {
			// Best-effort temp cleanup.
		}
	}
}

export interface SalvagedCommit {
	sha: string;
	subject: string;
	authorDate: string;
}

export interface WorktreeSalvageOutcome {
	index: number;
	branch: string;
	commits: SalvagedCommit[];
	salvageRef?: string;
	artifactDir?: string;
	inspectionError?: string;
	workingTreePatch?: string;
}

export interface WorktreeCleanupSummary {
	outcomes: WorktreeSalvageOutcome[];
}

function collectUniqueCommits(repoCwd: string, baseCommit: string, branch: string): SalvagedCommit[] {
	const range = `${baseCommit}..${branch}`;
	const count = Number.parseInt(runGitChecked(repoCwd, ["rev-list", "--count", range]).trim(), 10);
	if (!Number.isFinite(count) || count === 0) return [];
	const shas = runGitChecked(repoCwd, ["rev-list", range]).trim().split("\n").filter(Boolean);
	return shas.map((sha) => {
		const fields = runGitChecked(repoCwd, ["show", "-s", "--format=%H%x00%s%x00%aI", sha]).split("\0");
		return {
			sha: fields[0]?.trim() || sha,
			subject: fields[1] ?? "",
			authorDate: fields[2]?.trim() ?? "",
		};
	});
}

function salvageArtifactPaths(setup: WorktreeSetup, worktree: WorktreeInfo): { recordPath: string; patchPath: string; workingTreePatchPath: string } | undefined {
	if (!setup.salvageDir) return undefined;
	return {
		recordPath: path.join(setup.salvageDir, `worktree-${worktree.index}.json`),
		patchPath: path.join(setup.salvageDir, `worktree-${worktree.index}.patch`),
		workingTreePatchPath: path.join(setup.salvageDir, `worktree-${worktree.index}-working-tree.patch`),
	};
}

function writeSalvageRecord(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	uniqueCommits: SalvagedCommit[],
	salvageRef: string | undefined,
	inspectionError?: string,
	workingTreePatch?: string,
): void {
	const artifactPaths = salvageArtifactPaths(setup, worktree);
	if (!artifactPaths) return;
	try {
		fs.mkdirSync(setup.salvageDir!, { recursive: true });
		const record: {
			index: number;
			branch: string;
			path: string;
			baseCommit: string;
			uniqueCommits: SalvagedCommit[];
			salvageRef?: string;
			formatPatch?: string;
			workingTreePatch?: string;
			inspectionError?: string;
		} = {
			index: worktree.index,
			branch: worktree.branch,
			path: worktree.path,
			baseCommit: setup.baseCommit,
			uniqueCommits,
		};
		if (salvageRef) record.salvageRef = salvageRef;
		if (uniqueCommits.length > 0) record.formatPatch = path.basename(artifactPaths.patchPath);
		if (workingTreePatch) record.workingTreePatch = workingTreePatch;
		if (inspectionError) record.inspectionError = inspectionError;
		fs.writeFileSync(artifactPaths.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
	} catch {
		// Salvage metadata is best-effort; the ref remains the recovery guarantee.
	}
}

function writeSalvagePatch(setup: WorktreeSetup, worktree: WorktreeInfo): void {
	const artifactPaths = salvageArtifactPaths(setup, worktree);
	if (!artifactPaths) return;
	try {
		const patch = runGitChecked(setup.cwd, ["format-patch", "--stdout", `${setup.baseCommit}..${worktree.branch}`]);
		fs.mkdirSync(setup.salvageDir!, { recursive: true });
		fs.writeFileSync(artifactPaths.patchPath, patch, "utf-8");
	} catch {
		// The salvage ref and JSON metadata are retained even if patch writing fails.
	}
}

function cleanupSingleWorktree(setup: WorktreeSetup, worktree: WorktreeInfo): WorktreeSalvageOutcome {
	const outcome: WorktreeSalvageOutcome = {
		index: worktree.index,
		branch: worktree.branch,
		commits: [],
		...(setup.salvageDir ? { artifactDir: setup.salvageDir } : {}),
	};
	const salvageRef = managedSalvageRef(setup.salvageStartedAtMs, setup.runId, worktree.index);
	const workingTreePatch = captureWorkingTreePatch(setup, worktree);
	if (workingTreePatch) outcome.workingTreePatch = workingTreePatch;
	let uniqueCommits: SalvagedCommit[];
	try {
		uniqueCommits = collectUniqueCommits(setup.cwd, setup.baseCommit, worktree.branch);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outcome.inspectionError = message;
		writeSalvageRecord(setup, worktree, [], undefined, message, workingTreePatch);
		try { runGitChecked(setup.cwd, ["worktree", "remove", "--force", worktree.path]); } catch {
			// Cleanup is best-effort to avoid masking caller errors.
		}
		return outcome;
	}

	outcome.commits = uniqueCommits;
	if (uniqueCommits.length > 0) {
		try {
			runGitChecked(setup.cwd, ["update-ref", salvageRef, worktree.branch]);
		} catch {
			outcome.inspectionError = "failed to create salvage ref";
			writeSalvageRecord(setup, worktree, uniqueCommits, undefined, outcome.inspectionError, workingTreePatch);
			try { runGitChecked(setup.cwd, ["worktree", "remove", "--force", worktree.path]); } catch {
				// Cleanup is best-effort to avoid masking caller errors.
			}
			return outcome;
		}
		outcome.salvageRef = salvageRef;
		writeSalvageRecord(setup, worktree, uniqueCommits, salvageRef, undefined, workingTreePatch);
		writeSalvagePatch(setup, worktree);
	} else {
		writeSalvageRecord(setup, worktree, [], undefined, undefined, workingTreePatch);
	}

	try { runGitChecked(setup.cwd, ["worktree", "remove", "--force", worktree.path]); } catch {
		// Cleanup is best-effort to avoid masking caller errors.
	}
	try { runGitChecked(setup.cwd, ["branch", "-D", worktree.branch]); } catch {
		// Cleanup is best-effort to avoid masking caller errors.
	}
	return outcome;
}

export function createWorktrees(cwd: string, runId: string, count: number, options?: CreateWorktreesOptions): WorktreeSetup {
	const repo = resolveRepoState(cwd);
	pruneExpiredSalvageRefs(repo.toplevel);
	const salvageStartedAtMs = Date.now();
	const salvageDir = options?.artifactDir
		? path.join(options.artifactDir, `run-${safeArtifactName(runId)}`)
		: undefined;
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
	const baseDir = resolveWorktreeBaseDir(options?.baseDir, repo.toplevel);
	const worktrees: WorktreeInfo[] = [];

	try {
		for (let index = 0; index < count; index++) {
			worktrees.push(createSingleWorktree(
				repo.toplevel,
				repo.cwdRelative,
				runId,
				index,
				repo.baseCommit,
				setupHook,
				options?.agents?.[index],
				baseDir,
			));
		}
	} catch (error) {
		cleanupWorktrees({
			cwd: repo.toplevel,
			worktrees,
			baseCommit: repo.baseCommit,
			runId,
			salvageStartedAtMs,
			salvageDir,
		});
		throw error;
	}

	return {
		cwd: repo.toplevel,
		worktrees,
		baseCommit: repo.baseCommit,
		runId,
		salvageStartedAtMs,
		salvageDir,
	};
}

export function cleanupWorktrees(setup: WorktreeSetup): WorktreeCleanupSummary {
	const outcomes: WorktreeSalvageOutcome[] = [];
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		try {
			outcomes.push(cleanupSingleWorktree(setup, setup.worktrees[index]!));
		} catch (error) {
			// Preserve the cleanup API's best-effort contract even if unexpected
			// local inspection/artifact code throws.
			const worktree = setup.worktrees[index]!;
			outcomes.push({
				index: worktree.index,
				branch: worktree.branch,
				commits: [],
				...(setup.salvageDir ? { artifactDir: setup.salvageDir } : {}),
				inspectionError: error instanceof Error ? error.message : String(error),
			});
		}
	}
	try { runGitChecked(setup.cwd, ["worktree", "prune"]); } catch {
		// Pruning is best-effort cleanup.
	}
	return { outcomes };
}

export function formatWorktreeSalvageNotice(summary: WorktreeCleanupSummary): string {
	const pinned = summary.outcomes.filter((outcome) => outcome.salvageRef && outcome.commits.length > 0);
	const warnings = summary.outcomes.filter((outcome) => outcome.inspectionError);
	if (pinned.length === 0 && warnings.length === 0) return "";

	const lines: string[] = [];
	if (pinned.length > 0) {
		const commitCount = pinned.reduce((sum, outcome) => sum + outcome.commits.length, 0);
		lines.push(`Worktree salvage: ${commitCount} commit(s) pinned across ${pinned.length} branch(es).`);
		for (const outcome of pinned) {
			const artifact = outcome.artifactDir ? ` (artifacts: ${outcome.artifactDir})` : "";
			lines.push(`- ${outcome.commits.length} commit(s) pinned from branch ${outcome.branch} as ${outcome.salvageRef}${artifact}. Review before dropping the refs.`);
		}
	}
	for (const outcome of warnings) {
		const error = outcome.inspectionError!.replace(/[\r\n]+/g, " ").slice(0, 120);
		lines.push(`Worktree salvage warning: could not inspect ${outcome.branch} (${error}); branch retained for recovery.`);
	}
	return lines.join("\n");
}

const SALVAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MANAGED_SALVAGE_PREFIX = "refs/pi-salvage/managed/v1/";
const MANAGED_SALVAGE_REF_PATTERN = /^refs\/pi-salvage\/managed\/v1\/(\d{13})-[\w.-]+-\d+$/;

function managedSalvageRef(runStartedAtMs: number, runId: string, index: number): string {
	return `${MANAGED_SALVAGE_PREFIX}${runStartedAtMs}-${safeArtifactName(runId)}-${index}`;
}

export function pruneExpiredSalvageRefs(repoCwd: string, nowMs: number = Date.now()): void {
	let output: string;
	try {
		output = runGitChecked(repoCwd, ["for-each-ref", "--format=%(refname)", MANAGED_SALVAGE_PREFIX]);
	} catch {
		// Best-effort maintenance must never block worktree creation.
		return;
	}

	const cutoff = nowMs - SALVAGE_RETENTION_MS;
	const expired = output
		.split("\n")
		.map((ref) => ref.trim())
		.filter((ref) => {
			const match = MANAGED_SALVAGE_REF_PATTERN.exec(ref);
			return match !== null && Number(match[1]) < cutoff;
		});
	if (expired.length > 0) dropSalvageRefs(repoCwd, expired);
}

export function listSalvageRefs(repoCwd: string): string[] {
	try {
		return runGitChecked(repoCwd, ["for-each-ref", "--format=%(refname)", "refs/pi-salvage"])
			.split("\n")
			.map((ref) => ref.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

export function dropSalvageRefs(repoCwd: string, refs?: string[]): void {
	const refsToDrop = refs ?? listSalvageRefs(repoCwd);
	for (const ref of refsToDrop) {
		try { runGitChecked(repoCwd, ["update-ref", "-d", ref]); } catch {
			// Dropping salvage refs is best-effort, like worktree cleanup.
		}
	}
}
