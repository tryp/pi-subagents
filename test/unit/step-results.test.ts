import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	STEP_RESULT_ARTIFACT_VERSION,
	listStepResultArtifacts,
	readStepResultArtifact,
	stepResultArtifactPath,
	stepResultState,
	writeStepResultArtifact,
} from "../../src/runs/shared/step-results.ts";

type Payload = { agent: string; output: string; success: boolean };

function fixture(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-step-results-"));
}

function write(
	asyncDir: string,
	stepIndex: number,
	output: string,
	options: { state?: "complete" | "failed" | "paused" | "stopped"; runId?: string } = {},
): string | undefined {
	const state = options.state ?? "complete";
	return writeStepResultArtifact<Payload>({
		asyncDir,
		runId: options.runId ?? "run-a",
		stepIndex,
		agent: "scout",
		state,
		startedAt: 1000,
		endedAt: 2000,
		durationMs: 1000,
		result: { agent: "scout", output, success: state === "complete" },
	});
}

describe("step result artifacts", () => {
	it("writes one artifact per child and reads them back in index order", () => {
		const root = fixture();
		try {
			write(root, 1, "BETA");
			write(root, 0, "ALPHA");

			const artifacts = listStepResultArtifacts<Payload>(root);
			assert.deepEqual(artifacts.map((a) => a.stepIndex), [0, 1]);
			assert.deepEqual(artifacts.map((a) => a.result.output), ["ALPHA", "BETA"]);
			assert.equal(artifacts[0]?.stepResultArtifactVersion, STEP_RESULT_ARTIFACT_VERSION);
			assert.equal(artifacts[0]?.runId, "run-a");
			assert.equal(artifacts[0]?.agent, "scout");
			assert.equal(artifacts[0]?.durationMs, 1000);
			assert.equal(stepResultArtifactPath(root, 0), path.join(root, "step-results", "step-0.json"));
			assert.equal(readStepResultArtifact<Payload>(root, 1)?.result.output, "BETA");
			assert.equal(readStepResultArtifact<Payload>(root, 2), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("derives success from the state so it cannot disagree with status.json", () => {
		const root = fixture();
		try {
			// The payload claims success; a failed child must still be a failure.
			writeStepResultArtifact<Payload>({
				asyncDir: root,
				runId: "run-a",
				stepIndex: 0,
				agent: "scout",
				state: "failed",
				startedAt: 1000,
				endedAt: 2000,
				durationMs: 1000,
				result: { agent: "scout", output: "boom", success: true },
			});

			const [artifact] = listStepResultArtifacts<Payload>(root);
			assert.equal(artifact?.state, "failed");
			assert.equal(artifact?.result.success, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("is idempotent for the same child", () => {
		const root = fixture();
		try {
			write(root, 0, "first");
			write(root, 0, "second");
			const artifacts = listStepResultArtifacts<Payload>(root);
			assert.equal(artifacts.length, 1);
			assert.equal(artifacts[0]?.result.output, "second");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns nothing for a missing or unreadable results directory", () => {
		const root = fixture();
		try {
			assert.deepEqual(listStepResultArtifacts(path.join(root, "nope")), []);
			// A file where the directory should be must not throw either.
			fs.writeFileSync(path.join(root, "step-results"), "not a directory", "utf-8");
			assert.deepEqual(listStepResultArtifacts(root), []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips malformed, foreign, and mismatched artifacts instead of guessing", () => {
		const root = fixture();
		try {
			const dir = path.join(root, "step-results");
			fs.mkdirSync(dir, { recursive: true });
			write(root, 0, "GOOD");

			const valid = JSON.parse(fs.readFileSync(path.join(dir, "step-0.json"), "utf-8")) as Record<string, unknown>;
			// stepIndex always matches the file being written, so each case below
			// exercises exactly one rejection reason.
			const withPatch = (stepIndex: number, patch: Record<string, unknown> = {}): string =>
				JSON.stringify({ ...valid, stepIndex, ...patch });

			fs.writeFileSync(path.join(dir, "step-1.json"), "{ not json", "utf-8");
			fs.writeFileSync(path.join(dir, "step-2.json"), withPatch(2, { stepResultArtifactVersion: 99 }), "utf-8");
			fs.writeFileSync(path.join(dir, "step-3.json"), withPatch(7), "utf-8");
			fs.writeFileSync(path.join(dir, "step-4.json"), withPatch(4, { state: "cancelled" }), "utf-8");
			fs.writeFileSync(path.join(dir, "step-5.json"), withPatch(5, { result: null }), "utf-8");
			fs.writeFileSync(path.join(dir, "step-6.json"), withPatch(6, { runId: "run-b" }), "utf-8");
			fs.writeFileSync(path.join(dir, "step-7.json"), withPatch(7), "utf-8");
			// Non-artifact files a run directory can accumulate.
			fs.writeFileSync(path.join(dir, "notes.json"), JSON.stringify(valid), "utf-8");
			fs.writeFileSync(path.join(dir, ".step-8.json.123.456.abc.tmp"), withPatch(8), "utf-8");

			const invalid: string[] = [];
			const artifacts = listStepResultArtifacts<Payload>(root, { onInvalid: (file, reason) => invalid.push(`${path.basename(file)}: ${reason}`) });
			// step-0, step-6 (a different run, still valid without a runId filter)
			// and step-7 survive; the five broken files are rejected.
			assert.deepEqual(artifacts.map((a) => a.stepIndex), [0, 6, 7]);
			assert.equal(invalid.length, 5, `expected 5 rejected artifacts, got: ${invalid.join(" | ")}`);
			assert.match(invalid.join(" | "), /unsupported stepResultArtifactVersion 99/);
			assert.match(invalid.join(" | "), /does not match file name/);
			assert.match(invalid.join(" | "), /unknown state cancelled/);
			assert.match(invalid.join(" | "), /missing result payload/);

			// A runId filter reports only that run.
			assert.deepEqual(listStepResultArtifacts<Payload>(root, { runId: "run-a" }).map((a) => a.stepIndex), [0, 7]);
			assert.deepEqual(listStepResultArtifacts<Payload>(root, { runId: "run-b" }).map((a) => a.stepIndex), [6]);
			assert.deepEqual(listStepResultArtifacts<Payload>(root, { runId: "run-c" }), []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the state vocabulary aligned with the outcome it describes", () => {
		assert.equal(stepResultState({ stopped: true, timedOut: true, interrupted: true, exitCode: 1 }), "stopped");
		assert.equal(stepResultState({ stopped: false, timedOut: true, interrupted: false, exitCode: 0 }), "failed");
		assert.equal(stepResultState({ stopped: false, timedOut: false, interrupted: true, exitCode: 0 }), "paused");
		assert.equal(stepResultState({ stopped: false, timedOut: false, interrupted: false, exitCode: 0 }), "complete");
		assert.equal(stepResultState({ stopped: false, timedOut: false, interrupted: false, exitCode: 1 }), "failed");
		assert.equal(stepResultState({ stopped: false, timedOut: false, interrupted: false, exitCode: null }), "failed");
		assert.equal(stepResultState({ stopped: false, timedOut: false, interrupted: false, exitCode: undefined }), "failed");
	});
});
