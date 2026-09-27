import type { ExtensionConfig } from "../../shared/types.ts";

export const ASYNC_DEFAULT_ENV = "PI_SUBAGENT_ASYNC_DEFAULT";

export interface ResolvedAsyncDefaultConfig {
	/** True means an omitted `async` launches detached. */
	asyncByDefault: boolean;
	/**
	 * True when the user set this themselves (`asyncByDefault` in config or the env
	 * var) rather than inheriting the built-in default. Informational: it is not a
	 * per-call request, so it never authorizes a detach that would lose the result.
	 */
	asyncByDefaultExplicit: boolean;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "async"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "sync", "blocking"]);

function environmentValue(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	throw new Error(`${ASYNC_DEFAULT_ENV} must be one of true/false, 1/0, yes/no, on/off, async/sync, or blocking.`);
}

/**
 * Resolve whether an omitted `async` detaches.
 *
 * Detaching is the default because it is the shape that can overlap work: a parent
 * that blocks cannot start its next step while a child runs, and a foreground batch
 * cannot overlap its own children's wall clock with anything else. Blocking is the
 * opt-in (`async: false`, `config.asyncByDefault: false`, or
 * `PI_SUBAGENT_ASYNC_DEFAULT=false`) for the cases that need the result inline.
 *
 * `forceTopLevelAsync` predates this default and only ever applied at depth 0; it is
 * still honored so an explicit `true` keeps overriding a nested block.
 */
export function resolveAsyncByDefault(
	config: Pick<ExtensionConfig, "asyncByDefault"> = {},
	env: Record<string, string | undefined> = process.env,
): ResolvedAsyncDefaultConfig {
	const configured = config.asyncByDefault;
	if (configured !== undefined && typeof configured !== "boolean") {
		throw new Error("config.asyncByDefault must be a boolean.");
	}
	const fromEnvironment = environmentValue(env[ASYNC_DEFAULT_ENV]);
	const resolved = fromEnvironment ?? configured;
	return { asyncByDefault: resolved ?? true, asyncByDefaultExplicit: resolved !== undefined };
}

export interface LaunchAsyncInput {
	/** What the caller effectively passed as `async` (after config-applied defaults like forceTopLevelAsync). */
	requested?: boolean;
	/** True when the caller literally wrote `async: true`, rather than a default supplying it. */
	explicit?: boolean;
	/** Whether the background runner can actually run in this process. */
	asyncAvailable: boolean;
	/** Whether an omitted `async` means detach. */
	asyncByDefault: boolean;
	/** Whether the user set `asyncByDefault` themselves (see `ResolvedAsyncDefaultConfig`). */
	asyncByDefaultExplicit?: boolean;	/**
	 * Whether a later turn can still deliver a detached child's result.
	 *
	 * True for interactive and RPC sessions, which have a live session after the turn
	 * ends, and false for `print`/`json` single-shot runs, where `agent_end` is the end
	 * of the process. Omitted means "assume yes" so callers that never had this
	 * information keep the previous behavior.
	 *
	 * This guards every *defaulted* detach, including one configured through
	 * `asyncByDefault`. A config flag chooses between the two safe defaults; it is not
	 * a per-call request, so it cannot turn a launch into one that loses its output.
	 * Use `async: true` to detach in a single-shot run.
	 */
	canDeliverResult?: boolean;
}

export interface LaunchAsyncDecision {
	/** Whether the launch takes the async path. */
	async: boolean;
	/**
	 * Async was the intended shape but the runner is unavailable and the caller never
	 * asked for it, so the launch runs in the foreground instead of failing.
	 */
	fallbackToForeground: boolean;
}

/**
 * Decide whether one launch detaches.
 *
 * Only an explicit `async: true` is a request that must be satisfied or fail: it says
 * the caller relies on detaching. An async value that came from a default - config,
 * environment, or `forceTopLevelAsync` - carries no such intent, so an unavailable
 * runner degrades to a foreground run rather than turning every default launch into a
 * hard error on a machine without the background runner installed.
 *
 * A defaulted detach additionally needs somewhere for the result to land. In a
 * single-shot `print`/`json` run the process ends at `agent_end`, so a detached child
 * whose output the parent never waits for is output the parent never sees - measured
 * live, not assumed: a headless run that launched detached ended with the
 * acknowledgement as the last parent message and no child result in the transcript.
 * Blocking cannot lose a result, and in that mode it also cannot overlap anything, so
 * an omitted `async` stays inline there. This holds for every defaulted detach,
 * including one enabled by `asyncByDefault` - a config flag picks between safe
 * defaults rather than authorizing output loss. An explicit `async: true` always
 * detaches, which is the way to ask for it in a single-shot run.
 */
export function resolveLaunchAsync(input: LaunchAsyncInput): LaunchAsyncDecision {
	const explicit = input.explicit === true;
	let wanted: boolean;
	if (input.requested === true) {
		wanted = true;
	} else if (input.requested === false) {
		wanted = false;
	} else {
		wanted = input.asyncByDefault && input.canDeliverResult !== false;
	}
	if (!wanted) return { async: false, fallbackToForeground: false };
	if (input.asyncAvailable) return { async: true, fallbackToForeground: false };
	return explicit
		? { async: true, fallbackToForeground: false }
		: { async: false, fallbackToForeground: true };
}
