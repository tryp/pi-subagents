/**
 * The three shapes of the parent-facing `subagent` tool description, kept out
 * of `tool-description.ts` so the registration path and the `{ action: "help" }`
 * handler can share them without importing each other.
 *
 * `COMPACT` is the default (see `DEFAULT_TOOL_DESCRIPTION_MODE` in
 * `extension/tool-description.ts`): an index that names every action, every
 * execution shape and every task/chain key, and defers the prose to
 * `{ action: "help" }`, which returns `FULL`. Neither mode may drop a
 * capability -- both get `SAFETY` appended by the builder, and
 * `test/unit/tool-description.test.ts` fails if an action in
 * `SUBAGENT_ACTIONS` stops appearing in the compact index.
 */

export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• Use { action: "list" } before execution and only run listed, enabled agents or chains.
• Keep execution and management separate: omit action for SINGLE/PARALLEL/CHAIN execution; use action only for list/get/models/create/update/delete/status/grant-spawn-budget/interrupt/stop/resume/append-step/doctor.
• Async is the default: an omitted async detaches the run and returns immediately, so omit it. (In a single-shot 'pi -p' run an omitted async stays inline instead, because a detached result would have no later turn to land in.) Prefer ONE parallel batch over a series of sequential launches when the tasks do not depend on each other, and pass async:false only when you must have the result inline before the next step (a blocking launch overlaps nothing). Do not sleep or poll status just to wait. In an interactive session, normally return control and let Pi wake you; a wait is only for when you need a result now, and until:"next-event" sleeps until anything changes. A wait returns the first finished child by default, so checking for an early result is cheap: call subagent_wait when any child's result would let you start the next step, and repeat it to drain the remaining children as they finish. Ask for until:"all-terminal" (or barrier:"integration") only when the whole batch must be finished before you proceed. Headless sessions auto-drain current-session work at agent_end, so detached children are never abandoned by returning early.
• Child-safety boundary: ordinary child subagents are not orchestrators and must not run subagents. Only explicitly configured fanout children may use the child-safe subagent tool, still bounded by depth/session limits.
• Writing/review safety: keep one writer for the same cwd/worktree. Use fresh-context read-only reviewers/validators for independent review, then have the parent synthesize and apply fixes as the sole writer unless an isolated worktree was intentionally requested.
• Artifacts/status essentials: chain outputs live under {chain_dir}; async runs expose asyncId/asyncDir with status.json, events.jsonl, output logs, and status via { action: "status", id }. Include output paths and residual risks when reporting results.`;

export const FULL_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents or manage agent definitions.

EXECUTION (use exactly ONE mode):
• Before executing, use { action: "list" } to inspect configured agents/chains. Only execute agents listed and enabled.
• SINGLE: { agent, task? } - one task; omit task for self-contained agents
• CHAIN: { chain: [{agent:"agent-a"}, {parallel:[{agent:"agent-b",count:3}]}] } - sequential pipeline with optional parallel fan-out
• PARALLEL: { tasks: [{agent,task,count?,output?,reads?,progress?}, ...], concurrency?: number, worktree?: true } - concurrent execution (worktree: isolate each task in a git worktree)
• For cache-friendly PARALLEL batches, prefer one agent and one model across children (use the top-level model default). Keep shared contextFiles lists identical and ordered; sibling system prompts are batch-stable by default, with per-child directives in user messages.
• Optional context: { context: "fresh" | "fork" } (explicit value overrides every child; when omitted, each requested agent uses its own defaultContext, otherwise "fresh"; inspect agent defaults via { action: "list" })
• Fork thinking: model strings accept a thinking suffix (provider/model:off|minimal|low|medium|high|xhigh|max). Forking over a parent transcript that carries signed Anthropic thinking blocks forces thinking off only when a child's effective primary or fallback model resolves to the Anthropic provider or anthropic-messages API; unresolved models are treated conservatively. The result notes affected children, including on failures. Use fresh context when an Anthropic child needs thinking.
• Optional timeout: { timeoutMs } sets a run-level max runtime for foreground and async/background runs
• Optional OS limits: { rlimits: { cpuSeconds?, fileSizeMb?, openFiles?, coreSizeMb? } } applies Linux process limits through util-linux prlimit. These do not bound memory or process count; CPU is per-process, not process-tree aggregate. A configured limit on macOS/Windows is rejected rather than silently ignored, and limits are inherited by nested agents, which can only lower them. CPU uses a higher hard limit than its configured soft limit; SIGXCPU is attributed to the CPU limit, file-size failures are heuristic, and SIGKILL is never attributed to a limit. See the README for details.
• Optional assistant-turn cap: { turnBudget: { maxTurns, graceTurns? } } asks the child to wrap up at maxTurns and aborts it after graceTurns more turns, returning partial output.
• Optional tool-call cap: { toolBudget: { soft, hard, block? } } nudges at soft, then blocks the named tools at hard (default read/grep/find/ls, or "*" for all) so the child can finalize.
• Sync wake/checkpoint: foreground sync runs without an explicit timeout, and blocking subagent_wait calls in an interactive parent session return control after the shared budget (default 4 min, config syncWakeMs; 0 disables) while work continues — use the returned status/results and handles to continue instead of launching a replacement; headless auto-drain runs to completion
• If { action: "list" } shows proactive skill subagent suggestions, consider a small fresh-context fanout for broad tasks where one of those skills would materially help

CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/pi-subagents-<scope>/chain-runs/abc123/)

CHAIN EXAMPLES (quick reference for the nested schema):
• Sequential: { chain: [{agent:"agent-a", task:"Analyze {task}"}, {agent:"agent-b", task:"Plan based on {previous}"}] }
• Parallel fan-out: { chain: [{parallel: [{agent:"agent-a", task:"Check part of {task}", count: 3}]}] }
• Mixed: { chain: [{agent:"agent-a", task:"Research {task}"}, {parallel: [{agent:"agent-b", task:"Review {previous}", count: 2}]}, {agent:"agent-c", task:"Summarize {previous}"}] }

MANAGEMENT (use action field, omit agent/task/chain/tasks):
• { action: "list" } - discover available agents/chains
• { action: "get", agent: "name" } - full detail; packaged agents use dotted runtime names like "package.agent"
• { action: "models", agent?: "name" } - list the requestable model ids by provider with credential state; pass agent to show that agent's effective model and how a bare name resolved
• { action: "watchdog.status" | "watchdog.check" | "watchdog.recommend-model" } - inspect the opt-in subagent watchdog and its strong complementary model recommendation
• { action: "watchdog.configure", model: "recommended" | "inherit" | "provider/model[:thinking]", scope?: "session" | "user" | "project", target?: "main" | "children" | "child", agent?: "name", thinking?: "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } - configure watchdog model selection; default scope is session, use persistent scopes only when the user asks
• { action: "create", config: { name: "custom-agent", package: "code-analysis", systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, acceptance, acceptanceRole: "read-only" | "writer", ... } }
• acceptanceRole affects inferred acceptance only, never tool access. Explicit task mutation/no-edit intent wins; omission preserves name heuristics. Update with false or an empty string to clear it.
• { action: "update", agent: "code-analysis.custom-agent", config: { package: "analysis", ... } } - merge
• { action: "delete", agent: "code-analysis.custom-agent" }
• { action: "eject", agent: "reviewer", agentScope?: "user" | "project" } - copy a bundled/package agent to user/project scope as an editable custom file that shadows the original (default scope: user)
• { action: "disable", agent: "reviewer", agentScope?: "user" | "project" } - hide any agent from runtime discovery via a reversible settings override (default scope: user)
• { action: "enable", agent: "reviewer", agentScope?: "user" | "project" } - remove a disabled override and restore discovery
• { action: "reset", agent: "reviewer", agentScope?: "user" | "project" } - delete the scope's custom agent file and/or settings override, restoring the bundled default
• { action: "grant-spawn-budget", additional: 10 } - add bounded capacity from the root interactive parent after native user confirmation; grants are rejected while children are active and cumulative grants cannot exceed the original configured cap
• Use chainName for chain operations; packaged chains also use dotted runtime names

CONTROL:
• { action: "status", id: "..." } - inspect an async/background run by id or prefix
• { action: "status", view: "fleet" } - read-only active foreground/async fleet view with transcript commands
• { action: "status", id: "...", view: "transcript", index?: 0, lines?: 80 } - tail a run or child output/session transcript
• { action: "interrupt", id?: "..." } - soft-interrupt the current child turn and leave the run paused
• { action: "stop", id: "..." } - stop a current-session top-level async run; stopped runs finish with state "stopped"
• { action: "resume", id: "...", message: "...", index?: 0 } - revive a paused, completed, or failed async/foreground child from its session; stopped runs are non-resumable; routed nested runs may accept live follow-ups; use steer for a live top-level async child
• { action: "steer", id: "...", message: "...", index?: 0 } - await correlated child-Pi input acceptance for up to 3 seconds; returns delivered, scheduled, pending, partial, recovered, or failed with a request id. Only top-level single runs may recover after a further 15-second pause/revival bound; chain, parallel, and nested runs never auto-interrupt.
• { action: "append-step", id: "...", chain: [{agent:"agent-c", task:"Use {previous}"}] } - append one step to the tail of a running async chain

SCHEDULE (opt-in; requires { "scheduledRuns": { "enabled": true } } in config.json):
• { action: "schedule", agent, task?, schedule: "+10m" | "2030-01-01T09:00:00Z", scheduleName? } - defer a subagent launch until a future time. Also accepts tasks[] or chain[]. Scheduled runs always launch async with fresh context; they become normal tracked async runs once they fire. Only schedule explicit delayed runs the user asked for.
• { action: "schedule-list" } - list scheduled runs for this session
• { action: "schedule-status", id: "..." } - inspect one scheduled run
• { action: "schedule-cancel", id: "..." } - cancel a scheduled run before it fires

DIAGNOSTICS:
• { action: "doctor" } - read-only report for runtime paths, discovery, sessions, and intercom

${SUBAGENT_SAFETY_GUIDANCE}`;

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents, or manage them. One mode per call; {action:"help"} returns the full reference.

EXECUTE (omit action):
• SINGLE {agent,task?}; PARALLEL {tasks:[{agent,task,count?,output?,outputMode?,reads?,progress?}],concurrency?,worktree?}; CHAIN {chain:[{agent,task?},{parallel:[{agent,task,count?}]}]}.
• Every task also takes cwd, skill, model; chain keys beyond those shapes: as, collect, expand, outputSchema, phase, label, failFast, contextFiles. Templates: {task}, {previous}, {chain_dir}, {outputs.name}.
• Cache-friendly PARALLEL: prefer one agent/model across children; top-level model is the default. Keep shared contextFiles identical and ordered. Sibling system prompts are batch-stable; per-child directives go in user messages.
• context "fresh"|"fork" overrides the agent's defaultContext. model "provider/model[:thinking]" with thinking off|minimal|low|medium|high|xhigh|max.
• Limits: timeoutMs; rlimits {cpuSeconds,fileSizeMb,openFiles,coreSizeMb} (Linux only, inherited, only lowerable, no memory/process cap); turnBudget {maxTurns,graceTurns?}; toolBudget {soft,hard,block?}: soft nudges, hard blocks the named tools ("*" = all).

MANAGE {action}: list, get, models, create, update, delete, eject, disable, enable, reset, grant-spawn-budget, doctor, help.
• create/update take config, update merges; acceptanceRole "read-only"|"writer" shapes inferred acceptance only, never tool access. Chain actions take chainName.
• CONTROL: status (view "fleet"|"transcript", index?, lines?), interrupt, stop, resume, steer, append-step. resume and steer take message; stopped runs cannot resume; append-step takes chain.
• SCHEDULE (requires scheduledRuns.enabled): schedule {agent,task?,schedule,scheduleName?} or tasks[]/chain[], plus schedule-list, schedule-status, schedule-cancel. Only for delays the user asked for.
• WATCHDOG: watchdog.status, watchdog.check, watchdog.recommend-model, watchdog.configure (model, scope?, target?, agent?, thinking?).
• Results: asyncId/asyncDir, status.json, events.jsonl, output logs, session file.`;

/**
 * The reference returned by `{ action: "help" }`: the full description, not a
 * summary of it, so a session carrying the compact index can recover every
 * action, chain key and control semantic with one call.
 */
export function subagentHelpText(): string {
	return `${FULL_SUBAGENT_TOOL_DESCRIPTION}`;
}
