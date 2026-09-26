import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";

/**
 * Version of the per-child artifact written to
 * `<asyncDir>/step-results/step-<index>.json`.
 *
 * Deliberately a separate key from the run-level `lifecycleArtifactVersion`
 * (SUBAGENT_LIFECYCLE_ARTIFACT_VERSION) so a future generic version check
 * cannot conflate a step artifact with a run artifact.
 */
export const STEP_RESULT_ARTIFACT_VERSION = 1;

export const STEP_RESULTS_DIR_NAME = "step-results";

/** States a child can be in once it will never produce another result. */
export type StepResultState = "complete" | "failed" | "paused" | "stopped";

export const STEP_RESULT_STATES: readonly StepResultState[] = ["complete", "failed", "paused", "stopped"];

/**
 * One child's persisted outcome.
 *
 * `P` is the child result payload. The runner persists its own `StepResult`
 * shape; readers in the parent process only rely on `success` plus the optional
 * presentation fields, so the payload stays generic instead of coupling the
 * parent to the runner's internal result type.
 */
export interface StepResultArtifact<P = Record<string, unknown>> {
	stepResultArtifactVersion: number;
	runId: string;
	stepIndex: number;
	agent: string;
	state: StepResultState;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	result: P;
}

/** The subset of a child result that parent-side presentation relies on. */
export interface StepResultPresentation {
	success?: boolean;
	output?: string;
	error?: string;
	skipped?: boolean;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	outputReference?: { path?: string; [key: string]: unknown };
	truncated?: boolean;
}

/**
 * Map a child's normalized outcome onto the state vocabulary used in both
 * status.json and the per-child artifact.
 */
export function stepResultState(input: {
	stopped: boolean;
	timedOut: boolean;
	interrupted: boolean;
	exitCode?: number | null;
}): StepResultState {
	if (input.stopped) return "stopped";
	if (input.timedOut) return "failed";
	if (input.interrupted) return "paused";
	return input.exitCode === 0 ? "complete" : "failed";
}

export function stepResultArtifactPath(asyncDir: string, stepIndex: number): string {
	return path.join(asyncDir, STEP_RESULTS_DIR_NAME, `step-${stepIndex}.json`);
}

/**
 * Persist one child's result as soon as that child finishes, so a parent can
 * read a finished child's output without waiting for the whole run to join.
 *
 * The file is written atomically under `runId` + `stepIndex`, so re-running the
 * write for the same child is idempotent. Whole-run `result.json` keeps its
 * existing shape; this artifact is purely additive.
 *
 * The write is synchronous and happens inside the concurrency-limited callback,
 * which means it briefly holds that child's semaphore slot. That is acceptable:
 * the same callback already performs a strictly larger synchronous
 * `writeStatusPayload()` per child completion, so this adds a smaller write to a
 * path that already blocks. It is written here rather than at the batch join
 * because the whole point is availability before the join.
 *
 * Children that never start (pre-run timeout/stop/interrupt guards) get no
 * artifact, matching the fact that they never get a terminal status either.
 *
 * A failed write is reported and swallowed: a convenience artifact must never
 * fail the run itself.
 */
export function writeStepResultArtifact<P extends { success: boolean }>(input: {
	asyncDir: string;
	runId: string;
	stepIndex: number;
	agent: string;
	state: StepResultState;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	result: P;
}): string | undefined {
	const filePath = stepResultArtifactPath(input.asyncDir, input.stepIndex);
	try {
		writeAtomicJson(filePath, {
			stepResultArtifactVersion: STEP_RESULT_ARTIFACT_VERSION,
			runId: input.runId,
			stepIndex: input.stepIndex,
			agent: input.agent,
			state: input.state,
			startedAt: input.startedAt,
			endedAt: input.endedAt,
			durationMs: input.durationMs,
			// `success` is derived here rather than copied so the artifact agrees
			// with the same child's entry in the whole-run result.json, where the
			// join computes it from the normalized outcome.
			result: { ...input.result, success: input.state === "complete" },
		});
		return filePath;
	} catch (error) {
		console.error(`Failed to write step result ${filePath}:`, error);
		return undefined;
	}
}

const STEP_FILE_PATTERN = /^step-(\d+)\.json$/;

export interface StepResultReadOptions {
	/** Only return artifacts belonging to this run. */
	runId?: string;
	/** Diagnostics hook for files that exist but could not be used. */
	onInvalid?: (file: string, reason: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStepResultState(value: unknown): value is StepResultState {
	return typeof value === "string" && (STEP_RESULT_STATES as readonly string[]).includes(value);
}

/**
 * Validate one parsed artifact.
 *
 * Returns a reason string when the payload must not be trusted. A reader that
 * cannot validate refuses rather than guesses: the version key exists precisely
 * so a consumer never misreads a shape it does not understand.
 */
function validateArtifact(value: unknown, fileStepIndex: number, expectedRunId: string | undefined): string | undefined {
	if (!isRecord(value)) return "not a JSON object";
	if (value.stepResultArtifactVersion !== STEP_RESULT_ARTIFACT_VERSION) {
		return `unsupported stepResultArtifactVersion ${String(value.stepResultArtifactVersion)}`;
	}
	if (value.stepIndex !== fileStepIndex) return `stepIndex ${String(value.stepIndex)} does not match file name`;
	if (typeof value.runId !== "string" || value.runId.length === 0) return "missing runId";
	if (expectedRunId !== undefined && value.runId !== expectedRunId) return `runId ${value.runId} is not the requested run`;
	if (typeof value.agent !== "string") return "missing agent";
	if (!isStepResultState(value.state)) return `unknown state ${String(value.state)}`;
	if (!isRecord(value.result)) return "missing result payload";
	return undefined;
}

/**
 * Read every usable per-child artifact for a run.
 *
 * Never throws: a run directory can be missing, mid-write, or produced by a
 * different version, and none of those may break a status or wait path. Files
 * that fail validation are skipped (and reported through `onInvalid`) while the
 * rest are still returned. Results are ordered by `stepIndex`.
 */
export function listStepResultArtifacts<P = Record<string, unknown>>(
	asyncDir: string,
	options: StepResultReadOptions = {},
): Array<StepResultArtifact<P>> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path.join(asyncDir, STEP_RESULTS_DIR_NAME), { withFileTypes: true });
	} catch {
		return [];
	}

	const artifacts: Array<StepResultArtifact<P>> = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const match = STEP_FILE_PATTERN.exec(entry.name);
		if (!match) continue;
		const fileStepIndex = Number(match[1]);
		const filePath = path.join(asyncDir, STEP_RESULTS_DIR_NAME, entry.name);
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		} catch (error) {
			options.onInvalid?.(filePath, error instanceof Error ? error.message : String(error));
			continue;
		}
		const reason = validateArtifact(parsed, fileStepIndex, options.runId);
		if (reason) {
			options.onInvalid?.(filePath, reason);
			continue;
		}
		artifacts.push(parsed as StepResultArtifact<P>);
	}
	return artifacts.sort((a, b) => a.stepIndex - b.stepIndex);
}

/** Read one child's artifact by index, or undefined when it is not usable yet. */
export function readStepResultArtifact<P = Record<string, unknown>>(
	asyncDir: string,
	stepIndex: number,
	options: StepResultReadOptions = {},
): StepResultArtifact<P> | undefined {
	return listStepResultArtifacts<P>(asyncDir, options).find((artifact) => artifact.stepIndex === stepIndex);
}
