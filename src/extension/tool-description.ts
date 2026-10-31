import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;

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
• Optional context: { context: "fresh" | "fork" } (explicit value overrides every child; when omitted, each requested agent uses its own defaultContext, otherwise "fresh"; inspect agent defaults via { action: "list" })
• Fork thinking: model strings accept a thinking suffix (provider/model:off|minimal|low|medium|high|xhigh|max). Forking over a parent transcript that carries signed Anthropic thinking blocks forces thinking off only when a child's effective primary or fallback model resolves to the Anthropic provider or anthropic-messages API; unresolved models are treated conservatively. The result notes affected children, including on failures. Use fresh context when an Anthropic child needs thinking.
• Optional timeout: { timeoutMs } sets a run-level max runtime for foreground and async/background runs
• Optional OS limits: { rlimits: { cpuSeconds?, fileSizeMb?, openFiles?, coreSizeMb? } } applies Linux process limits through util-linux prlimit. These do not bound memory or process count; CPU is per-process, not process-tree aggregate. A configured limit on macOS/Windows is rejected rather than silently ignored, and limits are inherited by nested agents, which can only lower them. CPU uses a higher hard limit than its configured soft limit; SIGXCPU is attributed to the CPU limit, file-size failures are heuristic, and SIGKILL is never attributed to a limit. See the README for details.
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

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents or manage definitions. Use exactly one mode per call.

EXECUTE:
• Before execution, call { action: "list" }; run only listed, enabled agents/chains.
• SINGLE {agent,task?}; PARALLEL {tasks:[{agent,task,count?,output?,reads?,progress?}],concurrency?,worktree?}; CHAIN {chain:[{agent,task?},{parallel:[...]}]}.
• context "fresh"/"fork"; omitted uses each agent's defaultContext. timeoutMs caps runtime. rlimits: cpuSeconds,fileSizeMb,openFiles,coreSizeMb (Linux only; no memory/process cap; inherited, only reducible; macOS/Windows limits are rejected).
• turnBudget {maxTurns,graceTurns?} caps assistant turns: at maxTurns the child is asked to wrap up; after graceTurns more turns it is aborted with partial output.
• toolBudget {soft,hard,block?} caps tool calls: soft nudges; hard blocks named tools (default read/grep/find/ls, or "*" for all) so the child can finalize.
• syncWakeMs is an interactive parent wake/checkpoint while child work continues, not a runtime limit. Chain templates: {task}, {previous}, {chain_dir}; parallel worktree isolation requires a clean git repo.
• Chain example: { chain: [{agent:"agent-a", task:"Analyze {task}"}, {parallel: [{agent:"agent-b", task:"Check {previous}", count: 3}]}] }. Use proactive skill suggestions for broad tasks where they materially help.

MANAGE:
• Use action without execution fields: list, get, models, create, update, delete, eject, disable, enable, reset, grant-spawn-budget, doctor, watchdog.status, watchdog.check, watchdog.recommend-model, watchdog.configure.
• get reads full agent config; models lists requestable provider IDs and effective model resolution. watchdog.configure accepts model, scope?, target?, agent?, thinking?.
• create config keys include name, package, systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, acceptance, acceptanceRole; update merges. acceptanceRole (read-only/writer) affects inferred acceptance, never tools; explicit task intent wins; omission keeps name heuristics. Update with false/empty string clears it.
• eject/disable/enable/reset accept agentScope?; chain operations use chainName. grant-spawn-budget takes additional and requires user confirmation.
• CONTROL actions: status, interrupt, stop, resume, steer, append-step. status takes id and optional view:"fleet" or view:"transcript" (index?,lines?); resume/steer take message and optional index; append-step takes chain. Stop only current-session top-level async runs; stopped runs cannot resume. Steering confirms Pi accepted input, not model compliance.
• Opt-in SCHEDULE actions: schedule, schedule-list, schedule-status, schedule-cancel; requires scheduledRuns.enabled. schedule takes agent, task?, schedule, scheduleName? and also tasks[]/chain[]. Only schedule explicit delayed runs the user asked for.
• doctor is a read-only runtime/discovery/session/intercom report. If list shows proactive skill suggestions, use a small fresh-context fanout only for broad tasks where a skill helps.

ASYNC:
• async defaults true in interactive/RPC sessions and stays inline in single-shot 'pi -p'; async:false blocks only when an inline result is needed. Do not sleep/poll to wait: subagent_wait can return the first child result or until:"all-terminal"/barrier:"integration" when all work is required. Interactive runs can return control; Non-interactive runs (pi -p) auto-drain current-session work at agent_end. Status/artifacts use asyncId/asyncDir, status.json, events.jsonl, output logs, session files, and {action:"status",id:"..."}.`;

function isToolDescriptionMode(value: unknown): value is ToolDescriptionMode {
	return value === "full" || value === "compact" || value === "custom";
}

function warn(options: ToolDescriptionOptions | undefined, message: string): void {
	(options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	warn?: (message: string) => void;
}

export function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode {
	const mode = config.toolDescriptionMode;
	if (mode === undefined) return "full";
	if (isToolDescriptionMode(mode)) return mode;
	warn(options, `Ignoring invalid toolDescriptionMode ${JSON.stringify(mode)}; expected "full", "compact", or "custom".`);
	return "full";
}

function customDescriptionPaths(options?: ToolDescriptionOptions): string[] {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	return [
		path.join(getProjectConfigDir(cwd), CUSTOM_TOOL_DESCRIPTION_FILE),
		path.join(agentDir, CUSTOM_TOOL_DESCRIPTION_FILE),
	];
}

function renderCustomTemplate(template: string, options?: ToolDescriptionOptions): string {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	const projectConfigDir = getProjectConfigDir(cwd);
	const variables: Record<string, () => string> = {
		fullDescription: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		full: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		compactDescription: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		compact: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		safetyGuidance: () => SUBAGENT_SAFETY_GUIDANCE,
		safety: () => SUBAGENT_SAFETY_GUIDANCE,
		agentDir: () => agentDir,
		projectConfigDir: () => projectConfigDir,
	};
	return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
		const replacement = variables[name];
		if (replacement) return replacement();
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE}: unknown placeholder ${raw} left unchanged.`);
		return raw;
	});
}

function loadCustomToolDescription(options?: ToolDescriptionOptions): string | undefined {
	for (const filePath of customDescriptionPaths(options)) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			warn(options, `Failed to inspect custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!stat.isFile()) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is not a file.`);
			continue;
		}
		if (stat.size > CUSTOM_TOOL_DESCRIPTION_MAX_BYTES) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is larger than ${CUSTOM_TOOL_DESCRIPTION_MAX_BYTES} bytes.`);
			continue;
		}
		try {
			const template = fs.readFileSync(filePath, "utf-8").trim();
			if (!template) {
				warn(options, `Ignoring empty custom tool description '${filePath}'.`);
				continue;
			}
			const rendered = renderCustomTemplate(template, options).trim();
			if (!rendered) {
				warn(options, `Ignoring custom tool description '${filePath}' because it rendered empty.`);
				continue;
			}
			return rendered;
		} catch (error) {
			warn(options, `Failed to read custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return undefined;
}

function withMandatorySafetyGuidance(description: string): string {
	const customDescription = description
		.split(SUBAGENT_SAFETY_GUIDANCE)
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	return customDescription
		? `${customDescription}\n\n${SUBAGENT_SAFETY_GUIDANCE}`
		: SUBAGENT_SAFETY_GUIDANCE;
}

export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	const mode = resolveToolDescriptionMode(config, options);
	if (mode === "compact") return withMandatorySafetyGuidance(COMPACT_SUBAGENT_TOOL_DESCRIPTION);
	if (mode === "custom") {
		const custom = loadCustomToolDescription(options);
		if (custom) return withMandatorySafetyGuidance(custom);
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE} was not found or valid for toolDescriptionMode "custom"; using full description.`);
	}
	return withMandatorySafetyGuidance(FULL_SUBAGENT_TOOL_DESCRIPTION);
}
