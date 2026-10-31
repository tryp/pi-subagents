/**
 * Run the unit suite over the committed test files, not over whatever happens
 * to be in `test/unit` at that moment.
 *
 * `node --test test/unit/*.test.ts` collects from a directory glob, so the set
 * of tests is a function of the working tree: an untracked scratch file, a
 * half-written file from a concurrent checkout, or a leftover from another
 * branch all join the run. That makes a reported total like "1594 tests"
 * unattributable -- two reports for the same commit can disagree and neither is
 * wrong about the tree it saw. Here the list comes from `git ls-files`, so the
 * count is a function of the commit, and anything the tree adds on top has to
 * be named out loud (`PI_UNIT_ALLOW_UNCOMMITTED=1`) instead of drifting in.
 *
 * Usage:
 *   node --experimental-strip-types scripts/run-unit-tests.ts [--allow-uncommitted] [-- <node --test args>]
 *
 * The pure resolver is exported for the regression test.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const UNIT_DIR = "test/unit";
/** The package root this script belongs to, so the run does not depend on where it was invoked from. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const UNIT_FILE_PATTERN = /\.test\.ts$/;

export interface UnitFilePlan {
	/** Paths to hand to `node --test`, sorted. */
	files: string[];
	/** Present but not committed; excluded unless uncommitted files are allowed. */
	untracked: string[];
	/** Committed but absent on disk; always an error. */
	missing: string[];
	/** True when the list came from git rather than from a directory listing. */
	pinned: boolean;
}

export interface ResolveInput {
	/** Committed unit test files, or null when git cannot answer. */
	tracked: string[] | null;
	present: string[];
	allowUncommitted?: boolean;
}

/**
 * Decide which files the unit suite should run.
 *
 * Kept pure so the guarantees can be tested without a real checkout:
 *
 * - a file that is not committed never enters the run silently. It is either
 *   rejected (`untracked` non-empty, not allowed) or reported as uncommitted.
 * - a committed file that is not on disk is never dropped silently. It is
 *   reported as missing, because dropping it shrinks the suite exactly the way
 *   a stray file grows it.
 * - with no answer from git at all (`pinned` false) the directory listing is
 *   used, and the caller says so.
 */
export function resolveUnitTestFiles({ tracked, present, allowUncommitted = false }: ResolveInput): UnitFilePlan {
	const presentSet = new Set(present);
	if (tracked === null) {
		return {
			files: [...present].sort(),
			untracked: [],
			missing: [],
			pinned: false,
		};
	}
	const trackedSet = new Set(tracked);
	const missing = tracked.filter((file) => !presentSet.has(file)).sort();
	const untracked = present.filter((file) => !trackedSet.has(file)).sort();
	const files = tracked.filter((file) => presentSet.has(file));
	if (allowUncommitted) files.push(...untracked);
	return {
		files: files.sort(),
		untracked,
		missing,
		pinned: true,
	};
}

/**
 * Committed unit test files, from git. Null when git cannot answer (no
 * repository, no git binary), which is the only case where a directory listing
 * stands in for the commit.
 */
export function listTrackedUnitTests(cwd: string): string[] | null {
	try {
		const output = execFileSync("git", ["ls-files", "-z", "--", UNIT_DIR], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output
			.split("\0")
			.filter((entry) => entry.length > 0 && UNIT_FILE_PATTERN.test(entry))
			.sort();
	} catch {
		return null;
	}
}

/** Unit test files present on disk. */
export function listPresentUnitTests(cwd: string): string[] {
	const dir = path.join(cwd, UNIT_DIR);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && UNIT_FILE_PATTERN.test(entry.name))
		.map((entry) => `${UNIT_DIR}/${entry.name}`)
		.sort();
}

export function reportPlan(
	plan: UnitFilePlan,
	options: { allowUncommitted: boolean; out: (line: string) => void },
): void {
	const { allowUncommitted, out } = options;
	out(
		plan.pinned
			? `unit files: ${plan.files.length} (pinned to git ls-files)`
			: `unit files: ${plan.files.length} (git unavailable, using the ${UNIT_DIR} listing)`,
	);
	for (const file of plan.untracked) {
		out(
			allowUncommitted
				? `  uncommitted: ${file} (included because PI_UNIT_ALLOW_UNCOMMITTED is set)`
				: `  uncommitted: ${file} (excluded; the count describes the commit)`,
		);
	}
}

export interface PlanOptions {
	cwd: string;
	allowUncommitted: boolean;
	out: (line: string) => void;
	/** Test seam: overrides for the committed list. */
	tracked?: string[] | null;
	/** Test seam: overrides for the on-disk listing. */
	present?: string[];
}

export function planUnitTests({ cwd, allowUncommitted, out, tracked, present }: PlanOptions): UnitFilePlan {
	const plan = resolveUnitTestFiles({
		tracked: tracked === undefined ? listTrackedUnitTests(cwd) : tracked,
		present: present === undefined ? listPresentUnitTests(cwd) : present,
		allowUncommitted,
	});
	reportPlan(plan, { allowUncommitted, out });
	if (plan.missing.length > 0) {
		const list = plan.missing.map((file) => `  ${file}`).join("\n");
		throw new Error(
			`${plan.missing.length} committed unit test file(s) are missing from the checkout:\n${list}\n` +
				"Restore them (git checkout -- test/unit) or commit the deletion; a silently shorter suite reads as a green run.",
		);
	}
	return plan;
}

function runNodeTest(cwd: string, files: string[], passthrough: string[]): Promise<number> {
	const child = spawn(process.execPath, ["--experimental-strip-types", "--test", ...passthrough, ...files], {
		cwd,
		stdio: "inherit",
	});
	// `spawn` returns before the child exits, so `child.status` is still null
	// here; reading it would report every run -- green or not -- as a failure.
	return new Promise((resolve) => {
		child.on("error", () => resolve(1));
		child.on("close", (code, signal) => {
			if (code !== null) return resolve(code);
			resolve(signal === null ? 1 : 128);
		});
	});
}

async function main(argv: string[]): Promise<number> {
	const allowUncommitted = process.env.PI_UNIT_ALLOW_UNCOMMITTED === "1" || argv.includes("--allow-uncommitted");
	const separator = argv.indexOf("--");
	const passthrough = separator === -1 ? [] : argv.slice(separator + 1);
	// `git ls-files` answers relative to the working directory, so resolving it
	// from the package root is what makes the collected set independent of where
	// the command was run.
	const cwd = PACKAGE_ROOT;

	let plan: UnitFilePlan;
	try {
		plan = planUnitTests({ cwd, allowUncommitted, out: (line) => console.error(line) });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (plan.files.length === 0) {
		console.error(`no unit test files resolved under ${UNIT_DIR}; refusing to report an empty suite as a pass`);
		return 1;
	}
	return runNodeTest(cwd, plan.files, passthrough);
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
			process.exitCode = 1;
		},
	);
}
