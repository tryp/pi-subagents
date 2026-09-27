import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SubagentWaitParams } from "../../extension/schemas.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.ts";

export function registerWaitTool(pi: ExtensionAPI, state: SubagentState, enabled = resolveWaitToolConfig().enabled, checkpointMs?: number): void {
	const checkpointDescription = checkpointMs === undefined
		? ""
		: ` Blocking waits return a non-error supervisor checkpoint after config.syncWakeMs (default 4 minutes; set to 0 to disable), with any published child results and handles to continue; the work keeps running, so call subagent_wait again only when its result is needed.`;
	const tool: ToolDefinition<typeof SubagentWaitParams, Details> = {
		name: "subagent_wait",
		label: "Subagent Wait",
		description: `Explicit blocking barrier for a subagent result or integration. Prefer { runId, barrier: "consume-result" | "integration" }. The default completion condition is until: "first-result": the wait returns as soon as ONE child of a parallel batch has published a result, without waiting for the stragglers, so it is cheap to check for an early result and act on a partial batch. Repeat the wait to drain the children that finish later. Pass until: "all-terminal" (or barrier: "integration") when you cannot proceed until every selected run is finished, and until: "any-change" to return at the first tracked run's completion. The result includes the finished children's output, so a wait usually replaces a follow-up status call.${checkpointDescription}${enabled ? "" : "\n\nConfigured behavior: subagent_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`,
		parameters: SubagentWaitParams,
		execute(_id, params, signal) {
			return waitForSubagents(params, signal, { state, events: pi.events, enabled, checkpointMs });
		},
	};
	pi.registerTool(tool);
}
