import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ASYNC_DEFAULT_ENV,
	resolveAsyncByDefault,
	resolveLaunchAsync,
} from "../../src/runs/background/async-default-config.ts";

describe("async default", () => {
	it("detaches when nothing is configured, and marks that as inherited", () => {
		// The built-in default is the shape that can overlap work. The `Explicit: false`
		// flag matters: an inherited default may still decline to detach where the
		// result could not be delivered, while a configured one is intent.
		assert.deepEqual(resolveAsyncByDefault(undefined, {}), {
			asyncByDefault: true,
			asyncByDefaultExplicit: false,
		});
	});

	it("treats asyncByDefault false as the blocking opt-in", () => {
		assert.deepEqual(resolveAsyncByDefault({ asyncByDefault: false }, {}), {
			asyncByDefault: false,
			asyncByDefaultExplicit: true,
		});
		assert.deepEqual(resolveAsyncByDefault({ asyncByDefault: true }, {}), {
			asyncByDefault: true,
			asyncByDefaultExplicit: true,
		});
	});

	it("lets the environment override config in either direction", () => {
		assert.deepEqual(resolveAsyncByDefault({ asyncByDefault: false }, { [ASYNC_DEFAULT_ENV]: "true" }), {
			asyncByDefault: true,
			asyncByDefaultExplicit: true,
		});
		assert.deepEqual(resolveAsyncByDefault({ asyncByDefault: true }, { [ASYNC_DEFAULT_ENV]: "blocking" }), {
			asyncByDefault: false,
			asyncByDefaultExplicit: true,
		});
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

	it("keeps a single-shot run inline, because a detached result has nowhere to land", () => {
		// Measured live: a headless `print` run that launched detached ended with the
		// acknowledgement as its last message and no child result in the transcript.
		// Blocking cannot lose a result, so the built-in default stays inline there.
		assert.deepEqual(
			resolveLaunchAsync({
				requested: undefined,
				asyncAvailable: true,
				asyncByDefault: true,
				canDeliverResult: false,
			}),
			{ async: false, fallbackToForeground: false },
		);
	});

	it("still detaches a single-shot run when the user configured asyncByDefault", () => {
		// An explicit setting is intent, so it overrides the delivery guard; the user
		// asked for detaching everywhere and may be reading the artifacts themselves.
		assert.deepEqual(
			resolveLaunchAsync({
				requested: undefined,
				asyncAvailable: true,
				asyncByDefault: true,
				asyncByDefaultExplicit: true,
				canDeliverResult: false,
			}),
			{ async: true, fallbackToForeground: false },
		);
	});

	it("detaches an explicit async request even where a result cannot be delivered", () => {
		// The caller asked to detach; the drain still waits for the child, so nothing
		// is abandoned and the run artifacts hold the output.
		assert.deepEqual(
			resolveLaunchAsync({
				requested: true,
				explicit: true,
				asyncAvailable: true,
				asyncByDefault: true,
				canDeliverResult: false,
			}),
			{ async: true, fallbackToForeground: false },
		);
	});

	it("keeps blocking opt-in working in a delivery-capable session too", () => {
		assert.deepEqual(
			resolveLaunchAsync({
				requested: false,
				asyncAvailable: true,
				asyncByDefault: true,
				canDeliverResult: true,
			}),
			{ async: false, fallbackToForeground: false },
		);
	});
});
