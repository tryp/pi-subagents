/**
 * Scenario runner for structured-output typebox resolution unit tests.
 *
 * Runs in a fresh node process (spawned by test/unit/structured-output.test.ts)
 * so the structured-output module's cached typebox loader starts clean, which
 * mirrors how the detached async runner boots. The scenario is selected via
 * the SCENARIO environment variable:
 *
 *   - "host-root": resolve typebox/compile from the pi host package root named
 *     by PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT (the async runner env).
 *   - "local":     fall back to the bare import (dev/CI node_modules or the
 *     in-process extension alias).
 *
 * Prints exactly one JSON line on stdout; the test asserts on it.
 */
import * as fs from "node:fs";
import {
	createStructuredOutputRuntime,
	readStructuredOutput,
	validateStructuredOutputValue,
} from "../../src/runs/shared/structured-output.ts";

const requiredIdSchema = {
	type: "object",
	required: ["id"],
	properties: { id: { type: "number" } },
} as const;

async function runBattery(): Promise<unknown> {
	const valid = await validateStructuredOutputValue({ type: "object" }, {});
	const invalid = await validateStructuredOutputValue(requiredIdSchema, {});

	const runtime = createStructuredOutputRuntime({ type: "object" });
	fs.writeFileSync(runtime.outputPath, JSON.stringify({ ok: 1 }), { encoding: "utf-8" });
	const roundTrip = await readStructuredOutput(runtime);

	const mismatch = createStructuredOutputRuntime(requiredIdSchema);
	fs.writeFileSync(mismatch.outputPath, JSON.stringify({}), { encoding: "utf-8" });
	const mismatchError = (await readStructuredOutput(mismatch)).error;

	return {
		scenario: process.env.SCENARIO,
		valid,
		invalid,
		roundTrip,
		mismatchError,
	};
}

runBattery()
	.then((result) => {
		console.log(JSON.stringify(result));
	})
	.catch((error: unknown) => {
		console.error(`structured-output scenario failed: ${error instanceof Error ? error.stack : String(error)}`);
		process.exit(1);
	});