import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ALLOW_CROSS_PROJECT_WRITES_ENV, EXPECTED_WORKTREE_ROOT_ENV } from "../runs/shared/pi-args.ts";

function resolveTarget(root: string, requestedPath: string): string {
	const absolute = resolve(root, requestedPath);
	let probe = absolute;
	const suffix: string[] = [];
	while (true) {
		let exists = true;
		try {
			lstatSync(probe);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			exists = false;
		}
		if (exists) return resolve(realpathSync(probe), ...suffix);
		const parent = dirname(probe);
		if (parent === probe) throw new Error(`no existing ancestor for ${absolute}`);
		suffix.unshift(basename(probe));
		probe = parent;
	}
}

function isWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function gitRoot(cwd: string): string {
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	return realpathSync(root);
}

function cwdMismatchReason(actualCwd: string, expectedRoot: string): string | undefined {
	try {
		const actual = gitRoot(actualCwd);
		const expected = gitRoot(expectedRoot);
		return actual === expected ? undefined : `actual child worktree root ${actual} does not match assigned worktree root ${expected}`;
	} catch (error) {
		return `cannot verify assigned worktree root: ${(error as Error).message}`;
	}
}

function pathViolation(cwd: string, expectedRoot: string, requestedPath: unknown, allowCrossProjectWrites: boolean): string | undefined {
	if (typeof requestedPath !== "string" || !requestedPath) return "write/edit target is missing";
	try {
		const root = gitRoot(expectedRoot);
		const target = resolveTarget(cwd, requestedPath);
		if (!isWithin(root, target) && !allowCrossProjectWrites) {
			return `target ${requestedPath} resolves outside assigned worktree ${root}; set allowCrossProjectWrites only for deliberate cross-project writes`;
		}
		return undefined;
	} catch (error) {
		return `cannot safely resolve write/edit target ${requestedPath}: ${(error as Error).message}`;
	}
}

/**
 * Enforce the subagent runner's independent worktree assignment at Pi's real
 * pre-execution tool boundary. This is a tool-call guard, not an OS sandbox:
 * shell commands may still change directory or invoke external write tools.
 */
export default function (pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		const expectedRoot = process.env[EXPECTED_WORKTREE_ROOT_ENV];
		if (expectedRoot === undefined) return undefined;
		if (!expectedRoot.trim() || !isAbsolute(expectedRoot)) {
			return { block: true, reason: "assigned worktree root must be a non-empty absolute path; refusing all tool calls" };
		}

		const mismatch = cwdMismatchReason(ctx.cwd, expectedRoot);
		if (mismatch) return { block: true, reason: `blocked ${event.toolName}: ${mismatch}` };
		// This validates the child's launch worktree for every Pi tool call. It
		// is not a sandbox: bash and custom tools can still mutate other roots.
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

		const input = event.input as { path?: unknown };
		const violation = pathViolation(ctx.cwd, expectedRoot, input.path, process.env[ALLOW_CROSS_PROJECT_WRITES_ENV] === "1");
		return violation ? { block: true, reason: `blocked ${event.toolName}: ${violation}` } : undefined;
	});
}
