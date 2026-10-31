import type { WaitToolConfig } from "../../shared/types.ts";

export const WAIT_TOOL_ENABLED_ENV = "PI_SUBAGENT_WAIT_TOOL_ENABLED";

export interface ResolvedWaitToolConfig {
	enabled: boolean;
	yieldOnUserInput: boolean;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

function environmentValue(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	throw new Error(`${WAIT_TOOL_ENABLED_ENV} must be one of true/false, 1/0, yes/no, on/off, or enabled/disabled.`);
}

function configuredValue(config: unknown): boolean | undefined {
	if (config === undefined) return undefined;
	if (typeof config === "boolean") return config;
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("config.waitTool must be a boolean or an object with optional enabled boolean.");
	}
	const enabled = (config as { enabled?: unknown }).enabled;
	if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("config.waitTool.enabled must be a boolean.");
	return enabled;
}

/**
 * Why an interactive wait ended.
 *
 * The epoch advances on any input that will be delivered to the agent, whatever
 * its source. The case it was built for is a person submitting a message, but an
 * extension-injected message ends the wait too: the message is queued work, and
 * blocking through the checkpoint while it sits undelivered is idle time the
 * caller did not ask for. Only the wording differs, and naming the source keeps
 * the checkpoint honest about what ended it.
 */
export const describeWaitSubmitSource = (source: string | undefined): string =>
	source === "extension" ? "an extension injected input" : "the user submitted input";

export function resolveWaitToolConfig(config?: WaitToolConfig, env: Record<string, string | undefined> = process.env): ResolvedWaitToolConfig {
	const objectConfig = config && typeof config === "object" ? config : undefined;
	const yieldOnUserInput = objectConfig?.yieldOnUserInput;
	if (yieldOnUserInput !== undefined && typeof yieldOnUserInput !== "boolean") {
		throw new Error("config.waitTool.yieldOnUserInput must be a boolean.");
	}
	return {
		enabled: environmentValue(env[WAIT_TOOL_ENABLED_ENV]) ?? configuredValue(config) ?? true,
		yieldOnUserInput: yieldOnUserInput ?? true,
	};
}
