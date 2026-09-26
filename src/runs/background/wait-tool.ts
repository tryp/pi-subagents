import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SubagentWaitParams } from "../../extension/schemas.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.ts";

export function registerWaitTool(pi: ExtensionAPI, state: SubagentState, enabled = resolveWaitToolConfig().enabled): void {
	const tool: ToolDefinition<typeof SubagentWaitParams, Details> = {
		name: "subagent_wait",
		label: "Subagent Wait",
		description: `Explicit blocking barrier for a subagent result or integration. Prefer { runId, barrier: "consume-result" | "integration" }; use until: "all-terminal" to wait for every selected run. The result includes the finished children's output, so a wait usually replaces a follow-up status call. Use until: "first-result" to act on the first child of a batch that finishes without waiting for stragglers. A four-minute supervisor checkpoint automatically returns control for long foreground work, so do not call this merely to keep the session alive.${enabled ? "" : "\n\nConfigured behavior: subagent_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`,
		parameters: SubagentWaitParams,
		execute(_id, params, signal) {
			return waitForSubagents(params, signal, { state, events: pi.events, enabled });
		},
	};
	pi.registerTool(tool);
}
