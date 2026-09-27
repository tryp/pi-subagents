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
	it("treats a missing runtime directory as clean before first deploy", () => {
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
