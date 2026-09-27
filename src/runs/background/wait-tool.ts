import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SubagentWaitParams } from "../../extension/schemas.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.ts";

export function registerWaitTool(pi: ExtensionAPI, state: SubagentState, enabled = resolveWaitToolConfig().enabled, checkpointMs?: number): void {
	const checkpointDescription = checkpointMs === undefined
		? ""
		: ` In an interactive session a blocking wait returns a non-error supervisor checkpoint after config.syncWakeMs (default 4 minutes; set to 0 to disable), with any published child results and handles to continue, while the work keeps running; single-shot runs have no later turn to land in, so they block until the work is terminal or the timeout elapses. This is the same budget and the same 0-means-off switch that foreground sync wakes use.`;
	const tool: ToolDefinition<typeof SubagentWaitParams, Details> = {
		name: "subagent_wait",
		label: "Subagent Wait",
		description: `Explicit blocking barrier for a subagent result or integration. Prefer { runId, barrier: "consume-result" | "integration" }. The default completion condition is until: "first-result": the wait returns as soon as ONE child of a parallel batch has published a result, without waiting for the stragglers, so it is cheap to check for an early result and act on a partial batch. Repeat the wait to drain the children that finish later. Pass until: "all-terminal" (or barrier: "integration") when you cannot proceed until every selected run is finished, and until: "any-change" to return at the first tracked run's completion. The result includes the finished children's output, so a wait usually replaces a follow-up status call.${checkpointDescription}${enabled ? "" : "\n\nConfigured behavior: subagent_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`,
		parameters: SubagentWaitParams,
		execute(_id, params, signal, _onUpdate, ctx) {
			return waitForSubagents(params, signal, {
				state,
				events: pi.events,
				enabled,
				checkpointMs: interactiveCheckpointMs(checkpointMs, ctx),
			});
		},
	};
	pi.registerTool(tool);
}

/**
 * Keep the supervisor checkpoint only where another turn can receive it.
 *
 * `ExtensionContext.hasUI` is true in the tui and rpc modes and false in the
 * single-shot json/print modes. A single-shot parent has no later turn to land
 * in, so a checkpoint there would hand it an unfinished batch it cannot collect
 * (`auto-drain` is what finishes that work, and it deliberately runs
 * uncheckpointed). This mirrors how interactive async launches are gated on the
 * same flag.
 */
export function interactiveCheckpointMs(
	checkpointMs: number | undefined,
	ctx: { hasUI?: boolean } | undefined,
): number | undefined {
	return ctx?.hasUI === true ? checkpointMs : undefined;
}
