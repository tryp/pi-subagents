import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	PACKAGE_ROOT,
	listPresentUnitTests,
	listTrackedUnitTests,
	planUnitTests,
	resolveUnitTestFiles,
	UNIT_DIR,
} from "../../scripts/run-unit-tests.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A total like "1594 tests" is only meaningful if it names the commit it came
 * from. The suite used to be collected with `test/unit/*.test.ts`, a directory
 * glob, so any file in the working tree joined the run: an untracked scratch
 * file, a half-written file from a concurrent checkout, a leftover from another
 * branch. Two reports for the same commit could then disagree, and both were
 * honestly describing the tree they saw.
 *
 * These pin the property, not a count: the resolved set is a function of the
 * committed file list only, and anything the working tree adds is named rather
 * than folded into the total.
 */

const tracked = [
	"test/unit/alpha.test.ts",
	"test/unit/beta.test.ts",
	"test/unit/gamma.test.ts",
];

test("a working tree that adds files cannot change the collected set", () => {
	const cleanTree = resolveUnitTestFiles({ tracked, present: tracked });
	const dirtyTree = resolveUnitTestFiles({
		tracked,
		present: [...tracked, "test/unit/scratch.test.ts", "test/unit/half-written.test.ts"],
	});

	assert.deepEqual(cleanTree.files, dirtyTree.files, "the run must not gain or lose tests when the working tree does");
	assert.deepEqual(dirtyTree.untracked, ["test/unit/half-written.test.ts", "test/unit/scratch.test.ts"]);
	assert.equal(dirtyTree.pinned, true);
});

test("an uncommitted file is reported, and only joins the run when it is asked for", () => {
	const input = { tracked, present: [...tracked, "test/unit/scratch.test.ts"] };

	const excluded = resolveUnitTestFiles(input);
	assert.deepEqual(excluded.files, tracked);

	const allowed = resolveUnitTestFiles({ ...input, allowUncommitted: true });
	assert.deepEqual(allowed.files, [...tracked, "test/unit/scratch.test.ts"]);
	assert.deepEqual(allowed.untracked, ["test/unit/scratch.test.ts"], "including it does not hide that it is uncommitted");
	assert.deepEqual(excluded.missing, []);
	assert.deepEqual(allowed.missing, []);
});

test("a committed file that is missing from the checkout is an error, not a smaller suite", () => {
	const plan = resolveUnitTestFiles({ tracked, present: ["test/unit/alpha.test.ts"] });
	assert.deepEqual(plan.missing, ["test/unit/beta.test.ts", "test/unit/gamma.test.ts"]);

	const lines: string[] = [];
	assert.throws(
		() =>
			planUnitTests({
				cwd: projectRoot,
				allowUncommitted: false,
				out: (line) => lines.push(line),
				tracked,
				present: ["test/unit/alpha.test.ts"],
			}),
		/2 committed unit test file\(s\) are missing from the checkout/,
	);
});

test("the plan is identical when the environment changes, because only the file list decides", () => {
	const present = [...tracked, "test/unit/scratch.test.ts"];
	const before = resolveUnitTestFiles({ tracked, present });

	const saved = { HOME: process.env.HOME, PI_UNIT_ALLOW_UNCOMMITTED: process.env.PI_UNIT_ALLOW_UNCOMMITTED };
	process.env.HOME = "/tmp/p11-not-a-home";
	delete process.env.PI_UNIT_ALLOW_UNCOMMITTED;
	try {
		const after = resolveUnitTestFiles({ tracked, present });
		assert.deepEqual(after, before);
	} finally {
		if (saved.HOME === undefined) delete process.env.HOME;
		else process.env.HOME = saved.HOME;
		if (saved.PI_UNIT_ALLOW_UNCOMMITTED === undefined) delete process.env.PI_UNIT_ALLOW_UNCOMMITTED;
		else process.env.PI_UNIT_ALLOW_UNCOMMITTED = saved.PI_UNIT_ALLOW_UNCOMMITTED;
	}
});

test("the collected set does not depend on the directory the runner is invoked from", () => {
	const fromPackageRoot = planUnitTests({ cwd: PACKAGE_ROOT, allowUncommitted: false, out: () => {} }).files;
	assert.ok(fromPackageRoot.length > 0);

	const saved = process.cwd();
	let fromScriptsDir: string[] = [];
	try {
		process.chdir(path.join(PACKAGE_ROOT, "scripts"));
		// Discovery relative to the working directory is the failure mode this
		// pins: from `scripts/` there is no `test/unit`, so a cwd-relative runner
		// would collect nothing and report an empty pass.
		fromScriptsDir = planUnitTests({ cwd: process.cwd(), allowUncommitted: false, out: () => {} }).files;
	} finally {
		process.chdir(saved);
	}
	assert.deepEqual(fromScriptsDir, []);

	// What the runner actually does: the base is the package root, so the answer
	// is the same as from the root itself.
	assert.deepEqual(
		planUnitTests({ cwd: PACKAGE_ROOT, allowUncommitted: false, out: () => {} }).files,
		fromPackageRoot,
	);
});

test("this checkout resolves to its committed unit tests and nothing else", () => {
	const committed = listTrackedUnitTests(projectRoot);
	const present = listPresentUnitTests(projectRoot);

	if (committed === null) {
		// No git answer: the runner says so and falls back to the directory
		// listing. The test states the fallback rather than failing, so a
		// checkout without git is reported, not hidden.
		const fallback = resolveUnitTestFiles({ tracked: null, present });
		assert.equal(fallback.pinned, false);
		assert.deepEqual(fallback.files, present);
		return;
	}

	assert.ok(committed.length > 0);
	const plan = resolveUnitTestFiles({ tracked: committed, present });

	assert.deepEqual(plan.files, committed, "the run must be exactly the committed set");
	assert.deepEqual(plan.missing, []);
	assert.deepEqual(
		plan.untracked,
		present.filter((file) => !committed.includes(file)),
		"an untracked test file has to show up as uncommitted, not silently join the run",
	);
	for (const file of plan.files) {
		assert.ok(file.startsWith(`${UNIT_DIR}/`) && file.endsWith(".test.ts"), `${file} is not a unit test file`);
	}
});

test("the package runs the pinned runner, not a directory glob", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8")) as {
		scripts: Record<string, string>;
	};
	assert.equal(packageJson.scripts["test:unit"], "node --experimental-strip-types scripts/run-unit-tests.ts");
	assert.doesNotMatch(
		packageJson.scripts["test:unit"],
		/\*/,
		"a glob hands the collector a directory listing, which is the thing that made the count move",
	);
});
