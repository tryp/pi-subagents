import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SCRIPT = fileURLToPath(new URL("../../scripts/deploy_drift.py", import.meta.url));

type Fixture = { root: string; source: string; runtime: string; artifacts: string };

function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-deploy-drift-"));
	const source = path.join(root, "source");
	const runtime = path.join(root, "runtime");
	const artifacts = path.join(root, "artifacts");
	fs.mkdirSync(source);
	fs.writeFileSync(path.join(source, "tracked.txt"), "source contents\n");
	fs.writeFileSync(path.join(source, "doomed.txt"), "removed after deploy\n");
	fs.cpSync(source, runtime, { recursive: true });
	return { root, source, runtime, artifacts };
}

function run(args: string[], cwd?: string) {
	return spawnSync("python3", [SCRIPT, ...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
}

function preflight(f: Fixture, ...args: string[]) {
	return run(["--runtime", f.runtime, "--source", f.source, ...args]);
}

function withFixture(test: (f: Fixture) => void): void {
	const f = fixture();
	try {
		test(f);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
}

function writeStamp(f: Fixture): string {
	const result = run(["--runtime", f.runtime, "--print-tree-hash"]);
	assert.equal(result.status, 0, result.stderr);
	const tree = result.stdout.trim();
	fs.writeFileSync(path.join(f.runtime, ".deployed-commit"), `commit: fixture\ntree: ${tree}\n`);
	return tree;
}

describe("deploy drift CLI", () => {
	it("treats a missing or empty runtime directory as clean on first deploy", () => {
		withFixture((f) => {
			fs.rmSync(f.runtime, { recursive: true });
			const result = preflight(f);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /does not exist yet/);
			fs.mkdirSync(f.runtime);
			const empty = preflight(f);
			assert.equal(empty.status, 0, empty.stderr);
			assert.match(empty.stdout, /runtime is empty/);
		});
	});

	it("treats a source-only new file as a benign creation, not modified drift", () => {
		withFixture((f) => {
			fs.writeFileSync(path.join(f.source, "new-source-file.txt"), "created on source\n");
			const result = preflight(f);
			assert.equal(result.status, 0, result.stderr);
			assert.doesNotMatch(result.stdout, /new-source-file\.txt/);
			assert.match(result.stdout, /matches/);
		});
	});

	it("accepts an identical source and runtime", () => {
		withFixture((f) => {
			const result = preflight(f);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /matches/);
		});
	});

	it("rejects extra runtime files, names them, and includes their content in the saved patch", () => {
		withFixture((f) => {
			fs.writeFileSync(path.join(f.runtime, "runtime-only.txt"), "keep me\n");
			const result = preflight(f, "--save-drift", f.artifacts);
			assert.equal(result.status, 2);
			assert.match(result.stdout, /runtime-only\.txt/);
			assert.match(result.stdout, /would be lost/);
			const patch = fs.readdirSync(f.artifacts).find((name) => name.endsWith(".patch"));
			assert.ok(patch);
			assert.match(fs.readFileSync(path.join(f.artifacts, patch), "utf8"), /runtime-only\.txt/);
			assert.match(fs.readFileSync(path.join(f.artifacts, patch), "utf8"), /keep me/);
		});
	});

	it("rejects modified runtime files and preserves a patch, hashes, and itemize listing", () => {
		withFixture((f) => {
			fs.writeFileSync(path.join(f.runtime, "tracked.txt"), "edited runtime contents\n");
			const result = preflight(f, "--save-drift", f.artifacts);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stdout, /tracked\.txt/);
			const patch = fs.readdirSync(f.artifacts).find((name) => name.endsWith(".patch"));
			const hashes = fs.readdirSync(f.artifacts).find((name) => name.endsWith(".sha256"));
			const listing = fs.readdirSync(f.artifacts).find((name) => name.endsWith(".listing.txt"));
			assert.ok(patch);
			assert.ok(hashes);
			assert.ok(listing);
			assert.match(fs.readFileSync(path.join(f.artifacts, patch), "utf8"), /tracked\.txt/);
			assert.match(fs.readFileSync(path.join(f.artifacts, patch), "utf8"), /edited runtime contents/);
			assert.match(fs.readFileSync(path.join(f.artifacts, hashes), "utf8"), /tracked\.txt/);
			assert.match(fs.readFileSync(path.join(f.artifacts, listing), "utf8"), />f.*tracked\.txt/);
		});
	});

	it("allows modified files only with --allow-drift and reports a warning", () => {
		withFixture((f) => {
			fs.writeFileSync(path.join(f.runtime, "tracked.txt"), "edited runtime contents\n");
			const result = preflight(f, "--allow-drift");
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /WARNING/);
			assert.match(result.stdout, /tracked\.txt/);
		});
	});

	it("never allows extra files, even with --allow-drift", () => {
		withFixture((f) => {
			fs.writeFileSync(path.join(f.runtime, "runtime-only.txt"), "keep me\n");
			const result = preflight(f, "--allow-drift");
			assert.equal(result.status, 2);
			assert.match(result.stdout, /ERROR/);
			assert.match(result.stdout, /runtime-only\.txt/);
		});
	});

	it("ignores a permissions-only difference", () => {
		withFixture((f) => {
			fs.chmodSync(path.join(f.runtime, "tracked.txt"), 0o600);
			const result = preflight(f);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /matches/);
		});
	});

	it("checks a matching tree hash in the deploy stamp", () => {
		withFixture((f) => {
			const tree = writeStamp(f);
			const result = run(["--runtime", f.runtime, "--check-stamp"]);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, new RegExp(tree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		});
	});

	it("detects content changed since the deploy stamp", () => {
		withFixture((f) => {
			writeStamp(f);
			fs.writeFileSync(path.join(f.runtime, "tracked.txt"), "tampered after deploy\n");
			const result = run(["--runtime", f.runtime, "--check-stamp"]);
			assert.equal(result.status, 2);
			assert.match(result.stdout, /changed since deploy/);
		});
	});

	it("returns 3 when the deploy stamp is missing", () => {
		withFixture((f) => {
			const result = run(["--runtime", f.runtime, "--check-stamp"]);
			assert.equal(result.status, 3);
			assert.match(result.stdout, /no readable deploy stamp/);
		});
	});

	it("returns 3 when the deploy stamp has no valid tree hash", () => {
		withFixture((f) => {
			fs.writeFileSync(path.join(f.runtime, ".deployed-commit"), "commit: fixture\ntree: sha256:bad\n");
			const result = run(["--runtime", f.runtime, "--check-stamp"]);
			assert.equal(result.status, 3);
			assert.match(result.stdout, /no parseable tree hash/);
		});
	});

	it("produces stable hashes for identical trees at different paths and changes after content edits", () => {
		withFixture((f) => {
			const second = path.join(f.root, "second-runtime");
			fs.cpSync(f.runtime, second, { recursive: true });
			const firstHash = run(["--runtime", f.runtime, "--print-tree-hash"]);
			const secondHash = run(["--runtime", second, "--print-tree-hash"]);
			assert.equal(firstHash.status, 0);
			assert.equal(secondHash.status, 0);
			assert.match(firstHash.stdout.trim(), /^sha256:[0-9a-f]{64}$/);
			assert.equal(firstHash.stdout, secondHash.stdout);
			fs.writeFileSync(path.join(f.runtime, ".deployed-commit"), "stamp contents\n");
			fs.writeFileSync(path.join(f.runtime, ".deploy.lock"), "lock contents\n");
			fs.mkdirSync(path.join(f.runtime, "node_modules", "pkg"), { recursive: true });
			fs.writeFileSync(path.join(f.runtime, "node_modules", "pkg", "index.js"), "managed dependency\n");
			fs.mkdirSync(path.join(f.runtime, "tmp"), { recursive: true });
			fs.writeFileSync(path.join(f.runtime, "tmp", "cache"), "temporary data\n");
			fs.mkdirSync(path.join(f.runtime, ".git"), { recursive: true });
			fs.writeFileSync(path.join(f.runtime, ".git", "config"), "git metadata\n");
			const excludedHash = run(["--runtime", f.runtime, "--print-tree-hash"]);
			assert.equal(excludedHash.stdout, firstHash.stdout);
			fs.writeFileSync(path.join(second, "tracked.txt"), "different contents\n");
			const changedHash = run(["--runtime", second, "--print-tree-hash"]);
			assert.notEqual(firstHash.stdout, changedHash.stdout);
		});
	});

	it("emits a parseable JSON result object", () => {
		withFixture((f) => {
			fs.writeFileSync(path.join(f.runtime, "tracked.txt"), "edited runtime contents\n");
			const result = preflight(f, "--json", "--save-drift", f.artifacts);
			assert.equal(result.status, 2);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			assert.equal(parsed.mode, "preflight");
			assert.equal(parsed.status, "drift");
			assert.equal(parsed.exitCode, 2);
			assert.deepEqual(parsed.extraFiles, []);
			assert.deepEqual(parsed.modifiedFiles, ["tracked.txt"]);
			const artifacts = parsed.artifacts as Record<string, string>;
			assert.match(artifacts.patch, /deploy-drift-.*\.patch$/);
			assert.match(artifacts.sha256, /deploy-drift-.*\.sha256$/);
			assert.match(artifacts.listing, /deploy-drift-.*\.listing\.txt$/);
			assert.ok(fs.existsSync(artifacts.patch));
		});
	});
});

type GitFixture = Fixture & { commit: string };

function gitFixture(): GitFixture {
	const f = fixture();
	const git = (...args: string[]) =>
		spawnSync("git", ["-C", f.source, "-c", "user.email=deploy@example.com", "-c", "user.name=deploy", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
			encoding: "utf8",
		});
	const init = git("init", "-q", "-b", "main");
	assert.equal(init.status, 0, init.stderr);
	const add = git("add", "-A");
	assert.equal(add.status, 0, add.stderr);
	const commit = git("commit", "-q", "-m", "deployed baseline");
	assert.equal(commit.status, 0, commit.stderr);
	const sha = git("rev-parse", "HEAD");
	assert.equal(sha.status, 0, sha.stderr);
	return { ...f, commit: sha.stdout.trim() };
}

function withGitFixture(test: (f: GitFixture) => void): void {
	const f = gitFixture();
	try {
		test(f);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
}

function gitInSource(f: GitFixture, ...args: string[]) {
	const result = spawnSync("git", ["-C", f.source, "-c", "user.email=deploy@example.com", "-c", "user.name=deploy", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return result;
}

/** Run preflight with no stamp at all and return the result. */
function withMissingStamp(f: GitFixture) {
	fs.rmSync(path.join(f.runtime, ".deployed-commit"));
	return preflight(f);
}

function headOf(f: GitFixture): string {
	return gitInSource(f, "rev-parse", "HEAD").stdout.trim();
}

/** Stamp the runtime the way `make deploy` does: commit plus the runtime tree hash. */
function stampDeployed(f: GitFixture, commit = headOf(f)): void {
	const tree = run(["--runtime", f.runtime, "--print-tree-hash"]);
	assert.equal(tree.status, 0, tree.stderr);
	fs.writeFileSync(path.join(f.runtime, ".deployed-commit"), `commit: ${commit}\ntree: ${tree.stdout.trim()}\n`);
}

function baselineTempDirs(): string[] {
	return fs.readdirSync(os.tmpdir()).filter((name: string) => name.startsWith("pi-deploy-baseline-"));
}

describe("deploy drift preflight baseline", () => {
	it("treats a checkout that advanced past the deployed commit as clean", () => {
		withGitFixture((f) => {
			stampDeployed(f);
			fs.writeFileSync(path.join(f.source, "tracked.txt"), "checkout moved on\n");
			fs.writeFileSync(path.join(f.source, "added-after-deploy.txt"), "new file\n");
			fs.rmSync(path.join(f.source, "doomed.txt"));
			const result = preflight(f);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /matches deployed baseline/);
			assert.doesNotMatch(result.stdout, /tracked\.txt/);
		});
	});

	it("still rejects a tracked file hand-edited in the runtime after the stamp", () => {
		withGitFixture((f) => {
			stampDeployed(f);
			fs.writeFileSync(path.join(f.runtime, "tracked.txt"), "edited by hand in the runtime\n");
			fs.writeFileSync(path.join(f.source, "tracked.txt"), "checkout moved on\n");
			const result = preflight(f);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stdout, /tracked\.txt/);
			assert.match(result.stdout, /were edited in the runtime after deployed baseline/);
			assert.match(result.stdout, /ALLOW_DRIFT/);
			const allowed = preflight(f, "--allow-drift");
			assert.equal(allowed.status, 0, allowed.stderr);
			assert.match(allowed.stdout, /WARNING/);
		});
	});

	it("treats gitignored content the checkout still mirrors as deployable, not drift", () => {
		withGitFixture((f) => {
			fs.writeFileSync(path.join(f.source, ".gitignore"), ".pi-subagents/\n");
			gitInSource(f, "add", "-A");
			gitInSource(f, "commit", "-q", "-m", "ignore scratch artifacts");
			const artifacts = path.join(f.source, ".pi-subagents", "artifacts");
			fs.mkdirSync(artifacts, { recursive: true });
			fs.writeFileSync(path.join(artifacts, "run_1_output.md"), "scratch output\n");
			fs.cpSync(path.join(f.source, ".pi-subagents"), path.join(f.runtime, ".pi-subagents"), { recursive: true });
			stampDeployed(f);
			const result = preflight(f);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /matches deployed baseline/);
			assert.doesNotMatch(result.stdout, /pi-subagents/);
		});
	});

	it("rejects runtime content the checkout no longer provides, even with --allow-drift", () => {
		withGitFixture((f) => {
			stampDeployed(f);
			fs.writeFileSync(path.join(f.runtime, "orphan-artifact.md"), "only in the runtime\n");
			const result = preflight(f);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stdout, /orphan-artifact\.md/);
			assert.match(result.stdout, /no longer provided by the checkout/);
			const allowed = preflight(f, "--allow-drift");
			assert.equal(allowed.status, 2, allowed.stderr);
			assert.match(allowed.stdout, /ERROR/);
		});
	});

	it("rejects gitignored runtime content the checkout dropped or changed", () => {
		withGitFixture((f) => {
			fs.writeFileSync(path.join(f.source, ".gitignore"), ".pi-subagents/\n");
			gitInSource(f, "add", "-A");
			gitInSource(f, "commit", "-q", "-m", "ignore scratch artifacts");
			const artifacts = path.join(f.source, ".pi-subagents");
			fs.mkdirSync(artifacts, { recursive: true });
			fs.writeFileSync(path.join(artifacts, "run_1_output.md"), "scratch output\n");
			fs.cpSync(artifacts, path.join(f.runtime, ".pi-subagents"), { recursive: true });
			stampDeployed(f);
			fs.writeFileSync(path.join(f.source, ".pi-subagents", "run_1_output.md"), "regenerated locally\n");
			const changed = preflight(f);
			assert.equal(changed.status, 2, changed.stderr);
			assert.match(changed.stdout, /run_1_output\.md/);
			fs.rmSync(path.join(f.source, ".pi-subagents"), { recursive: true, force: true });
			const dropped = preflight(f);
			assert.equal(dropped.status, 2, dropped.stderr);
			assert.match(dropped.stdout, /run_1_output\.md/);
		});
	});

	it("falls back to the checkout comparison when the stamped commit is not resolvable", () => {
		withGitFixture((f) => {
			stampDeployed(f, "0123456789abcdef0123456789abcdef01234567");
			fs.writeFileSync(path.join(f.source, "tracked.txt"), "checkout moved on\n");
			const result = preflight(f, "--json");
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stdout, /not resolvable here/);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			assert.equal(parsed.baselineCommit, null);
			assert.match(String(parsed.baseline), /^checkout /);
			assert.deepEqual(parsed.modifiedFiles, ["tracked.txt"]);
		});
	});

	it("reports the resolved baseline commit in JSON output", () => {
		withGitFixture((f) => {
			stampDeployed(f);
			const result = preflight(f, "--json");
			assert.equal(result.status, 0, result.stderr);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			assert.equal(parsed.baselineCommit, f.commit);
			assert.equal(parsed.baseline, `deployed baseline ${f.commit.slice(0, 12)}`);
		});
	});

	it("names the deployed baseline in the saved drift patch header", () => {
		withGitFixture((f) => {
			stampDeployed(f);
			fs.writeFileSync(path.join(f.runtime, "tracked.txt"), "edited by hand in the runtime\n");
			const result = preflight(f, "--save-drift", f.artifacts);
			assert.equal(result.status, 2, result.stderr);
			const patch = fs.readdirSync(f.artifacts).find((name: string) => name.endsWith(".patch"));
			assert.ok(patch);
			const header = fs.readFileSync(path.join(f.artifacts, patch), "utf8").split("\n", 1)[0];
			assert.match(header, new RegExp(`^# Runtime drift patch: deployed baseline ${f.commit.slice(0, 12)} -> runtime\\.`));
		});
	});

	it("detects a symlink whose target changed after the stamp", () => {
		withGitFixture((f) => {
			const target = path.join(f.root, "target-a");
			fs.writeFileSync(target, "a\n");
			fs.symlinkSync(target, path.join(f.source, "link.txt"));
			gitInSource(f, "add", "-A");
			gitInSource(f, "commit", "-q", "-m", "add symlink");
			fs.cpSync(path.join(f.source, "link.txt"), path.join(f.runtime, "link.txt"), { verbatimSymlinks: true });
			stampDeployed(f);
			const before = run(["--runtime", f.runtime, "--check-stamp"]);
			assert.equal(before.status, 0, before.stderr);
			fs.unlinkSync(path.join(f.runtime, "link.txt"));
			fs.symlinkSync("/nowhere", path.join(f.runtime, "link.txt"));
			const result = preflight(f);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stdout, /link\.txt/);
			assert.match(result.stdout, /were edited in the runtime/);
			const stamp = run(["--runtime", f.runtime, "--check-stamp"]);
			assert.equal(stamp.status, 2, stamp.stderr);
			assert.match(stamp.stdout, /changed since deploy/);
		});
	});

	it("still treats a deployed directory missing from the runtime as a benign recreation", () => {
		withGitFixture((f) => {
			fs.mkdirSync(path.join(f.source, "nested"));
			fs.writeFileSync(path.join(f.source, "nested", "inner.txt"), "inner\n");
			gitInSource(f, "add", "-A");
			gitInSource(f, "commit", "-q", "-m", "add nested dir");
			fs.cpSync(path.join(f.source, "nested"), path.join(f.runtime, "nested"), { recursive: true });
			stampDeployed(f);
			fs.rmSync(path.join(f.runtime, "nested"), { recursive: true });
			// rsync reports an absent runtime directory as `cd+++++++++`, the
			// same code it uses for a replaced one; only the runtime's object
			// type tells them apart.
			const result = preflight(f);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /matches deployed baseline/);
		});
	});

	it("detects a deployed symlink the runtime replaced with a directory", () => {
		withGitFixture((f) => {
			fs.mkdirSync(path.join(f.source, "actual"));
			fs.writeFileSync(path.join(f.source, "actual", "inner.txt"), "inner\n");
			fs.symlinkSync("actual", path.join(f.source, "link"));
			gitInSource(f, "add", "-A");
			gitInSource(f, "commit", "-q", "-m", "add symlinked dir");
			fs.symlinkSync("actual", path.join(f.runtime, "link"));
			stampDeployed(f);
			fs.unlinkSync(path.join(f.runtime, "link"));
			fs.mkdirSync(path.join(f.runtime, "link"));
			const result = preflight(f, "--json");
			assert.equal(result.status, 2, result.stderr);
			assert.deepEqual((JSON.parse(result.stdout) as Record<string, unknown>).modifiedFiles, ["link"]);
		});
	});

	it("detects a symlink to a directory whose target changed after the stamp", () => {
		withGitFixture((f) => {
			// Both link targets must be real directories in the runtime: a link
			// whose target is missing is listed by os.walk as a file, a link to
			// an existing directory is listed under dirs, and only the latter
			// exercises the directory branch of tree_hash.
			for (const name of ["one", "two"]) {
				fs.mkdirSync(path.join(f.source, name));
				fs.writeFileSync(path.join(f.source, name, "inner.txt"), `${name}\n`);
			}
			fs.symlinkSync("one", path.join(f.source, "link"));
			gitInSource(f, "add", "-A");
			gitInSource(f, "commit", "-q", "-m", "add dir symlink");
			fs.cpSync(path.join(f.source, "one"), path.join(f.runtime, "one"), { recursive: true });
			fs.cpSync(path.join(f.source, "two"), path.join(f.runtime, "two"), { recursive: true });
			fs.symlinkSync("one", path.join(f.runtime, "link"));
			stampDeployed(f);
			assert.equal(run(["--runtime", f.runtime, "--check-stamp"]).status, 0);
			fs.unlinkSync(path.join(f.runtime, "link"));
			fs.symlinkSync("two", path.join(f.runtime, "link"));
			assert.equal(run(["--runtime", f.runtime, "--check-stamp"]).status, 2);
			const result = preflight(f);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stdout, /link/);
		});
	});

	it("reports a file replaced by a symlink once, so --allow-drift can authorize it", () => {
		withGitFixture((f) => {
			stampDeployed(f);
			fs.unlinkSync(path.join(f.runtime, "tracked.txt"));
			fs.symlinkSync("/nowhere", path.join(f.runtime, "tracked.txt"));
			const result = preflight(f, "--json");
			assert.equal(result.status, 2, result.stderr);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			assert.deepEqual(parsed.extraFiles, []);
			assert.deepEqual(parsed.modifiedFiles, ["tracked.txt"]);
			const allowed = preflight(f, "--allow-drift");
			assert.equal(allowed.status, 0, allowed.stderr);
		});
	});

	it("still resolves the baseline when the commit tracks an absolute symlink", () => {
		withGitFixture((f) => {
			fs.symlinkSync("/etc/hostname", path.join(f.source, "absolute-link"));
			gitInSource(f, "add", "-A");
			gitInSource(f, "commit", "-q", "-m", "add absolute symlink");
			fs.cpSync(path.join(f.source, "absolute-link"), path.join(f.runtime, "absolute-link"), { verbatimSymlinks: true });
			stampDeployed(f);
			// `data` extraction rejects absolute links; falling back to the
			// checkout would mask the baseline behind a checkout comparison.
			const result = preflight(f, "--json");
			assert.equal(result.status, 0, result.stderr);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			assert.match(String(parsed.baseline), /^deployed baseline /);
			assert.equal(parsed.baselineCommit, headOf(f));
		});
	});

	it("detects a deployed file the runtime replaced with a directory", () => {
		withGitFixture((f) => {
			stampDeployed(f);
			fs.unlinkSync(path.join(f.runtime, "tracked.txt"));
			// An empty directory is the case rsync reports with the same
			// `>f+++++++++` code it uses for a genuinely absent file, so this
			// test fails unless preflight inspects the runtime's object type.
			fs.mkdirSync(path.join(f.runtime, "tracked.txt"));
			const result = preflight(f);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stdout, /tracked\.txt/);
			const withContents = preflight(f, "--json");
			assert.equal(withContents.status, 2, withContents.stderr);
			const parsed = JSON.parse(withContents.stdout) as Record<string, unknown>;
			assert.deepEqual(parsed.modifiedFiles, ["tracked.txt"]);
		});
	});

	it("detects a deployed directory the runtime replaced with a file", () => {
		withGitFixture((f) => {
			fs.mkdirSync(path.join(f.source, "nested"));
			fs.writeFileSync(path.join(f.source, "nested", "inner.txt"), "inner\n");
			gitInSource(f, "add", "-A");
			gitInSource(f, "commit", "-q", "-m", "add nested dir");
			fs.cpSync(path.join(f.source, "nested"), path.join(f.runtime, "nested"), { recursive: true });
			stampDeployed(f);
			fs.rmSync(path.join(f.runtime, "nested"), { recursive: true, force: true });
			fs.writeFileSync(path.join(f.runtime, "nested"), "now a file\n");
			const result = preflight(f);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stdout, /nested/);
		});
	});

	it("still treats a deployed file missing from the runtime as a benign recreation", () => {
		withGitFixture((f) => {
			stampDeployed(f);
			fs.rmSync(path.join(f.runtime, "tracked.txt"));
			const result = preflight(f);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /matches deployed baseline/);
		});
	});

	it("says why it fell back to the checkout when the stamp cannot be parsed", () => {
		withGitFixture((f) => {
			stampDeployed(f);
			fs.writeFileSync(path.join(f.runtime, ".deployed-commit"), "deployed from: nowhere\n");
			const result = preflight(f);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /no parseable commit/);
			const missing = withMissingStamp(f);
			assert.match(missing.stdout, /no deploy stamp/);
		});
	});

	it("cleans up its temporary baseline export", () => {
		withGitFixture((f) => {
			stampDeployed(f);
			const before = baselineTempDirs();
			fs.writeFileSync(path.join(f.runtime, "tracked.txt"), "edited by hand in the runtime\n");
			const result = preflight(f, "--save-drift", f.artifacts);
			assert.equal(result.status, 2, result.stderr);
			assert.deepEqual(baselineTempDirs(), before);
		});
	});
});
