import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ASYNC_DEFAULT_ENV,
	resolveAsyncByDefault,
	resolveLaunchAsync,
} from "../../src/runs/background/async-default-config.ts";

describe("async default", () => {
	it("detaches when nothing is configured", () => {
		// The whole point of the default: a caller that says nothing gets the shape
		// that can overlap work, rather than a blocking call it has to remember to
		// opt out of.
		assert.deepEqual(resolveAsyncByDefault(undefined, {}), { asyncByDefault: true });
	});

	it("treats asyncByDefault false as the blocking opt-in", () => {
		assert.deepEqual(resolveAsyncByDefault({ asyncByDefault: false }, {}), { asyncByDefault: false });
		assert.deepEqual(resolveAsyncByDefault({ asyncByDefault: true }, {}), { asyncByDefault: true });
	});

	it("lets the environment override config in either direction", () => {
		assert.deepEqual(
			resolveAsyncByDefault({ asyncByDefault: false }, { [ASYNC_DEFAULT_ENV]: "true" }),
			{ asyncByDefault: true },
		);
		assert.deepEqual(
			resolveAsyncByDefault({ asyncByDefault: true }, { [ASYNC_DEFAULT_ENV]: "blocking" }),
			{ asyncByDefault: false },
		);
	});

	it("fails closed on invalid input instead of guessing", () => {
		assert.throws(
			() => resolveAsyncByDefault({ asyncByDefault: "yes" as never }, {}),
			/asyncByDefault must be a boolean/,
		);
		assert.throws(
			() => resolveAsyncByDefault(undefined, { [ASYNC_DEFAULT_ENV]: "maybe" }),
			/PI_SUBAGENT_ASYNC_DEFAULT must be one of/,
		);
	});
});

describe("launch async decision", () => {
	it("detaches an omitted async when the runner is available", () => {
		assert.deepEqual(
			resolveLaunchAsync({ requested: undefined, asyncAvailable: true, asyncByDefault: true }),
			{ async: true, fallbackToForeground: false },
		);
	});

	it("falls back to the foreground when a defaulted async has no runner", () => {
		// Before this, a missing jiti turned every default launch into a hard error.
		assert.deepEqual(
			resolveLaunchAsync({ requested: undefined, asyncAvailable: false, asyncByDefault: true }),
			{ async: false, fallbackToForeground: true },
		);
	});

	it("keeps an explicit async request an error when the runner is missing", () => {
		// The caller asked to detach; silently running inline would change its contract.
		assert.deepEqual(
			resolveLaunchAsync({ requested: true, explicit: true, asyncAvailable: false, asyncByDefault: true }),
			{ async: true, fallbackToForeground: false },
		);
	});

	it("treats a config-forced async like a default, not a request", () => {
		// forceTopLevelAsync sets async: true without the caller asking for it.
		assert.deepEqual(
			resolveLaunchAsync({ requested: true, explicit: false, asyncAvailable: false, asyncByDefault: true }),
			{ async: false, fallbackToForeground: true },
		);
	});

	it("honors the blocking opt-in in every environment", () => {
		for (const asyncAvailable of [true, false]) {
			assert.deepEqual(
				resolveLaunchAsync({ requested: false, asyncAvailable, asyncByDefault: true }),
				{ async: false, fallbackToForeground: false },
			);
			assert.deepEqual(
				resolveLaunchAsync({ requested: undefined, asyncAvailable, asyncByDefault: false }),
				{ async: false, fallbackToForeground: false },
			);
		}
	});
});
