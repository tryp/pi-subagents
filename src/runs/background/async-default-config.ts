import type { ExtensionConfig } from "../../shared/types.ts";

export const ASYNC_DEFAULT_ENV = "PI_SUBAGENT_ASYNC_DEFAULT";

export interface ResolvedAsyncDefaultConfig {
	/** True means an omitted `async` launches detached. */
	asyncByDefault: boolean;
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
	return { asyncByDefault: environmentValue(env[ASYNC_DEFAULT_ENV]) ?? configured ?? true };
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
 */
export function resolveLaunchAsync(input: LaunchAsyncInput): LaunchAsyncDecision {
	const explicit = input.explicit === true;
	const wanted = (input.requested ?? input.asyncByDefault) === true;
	if (!wanted) return { async: false, fallbackToForeground: false };
	if (input.asyncAvailable) return { async: true, fallbackToForeground: false };
	return explicit
		? { async: true, fallbackToForeground: false }
		: { async: false, fallbackToForeground: true };
}
