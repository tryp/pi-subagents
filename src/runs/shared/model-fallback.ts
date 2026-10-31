import type { ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";
import { checkModelScope, type ModelScopeConfig, type ModelScopeViolation, type ModelSource } from "./model-scope.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

/** Sentinel model value requesting that a subagent inherit the parent session's model. */
export const INHERIT_MODEL = "inherit";

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
	provider: string;
	id: string;
}

/**
 * Normalize a model id or provider segment for fuzzy comparison: case-fold,
 * treat dots/underscores as dashes (so `4.5` matches `4-5`), and collapse
 * repeated separators. Pure.
 */
export function normalizeModelSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/[._]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
	const yyyy = Number(year);
	const mm = Number(month);
	const dd = Number(day);
	return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** Drop a trailing date stamp (`-20251001` or `-2025-10-01`) so dated and undated ids match. Pure. */
function stripTrailingDateStamp(segment: string): string {
	const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
	if (dashed && isPlausibleDateStamp(dashed[2]!, dashed[3]!, dashed[4]!)) return dashed[1]!;
	const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
	if (compact && isPlausibleDateStamp(compact[2]!, compact[3]!, compact[4]!)) return compact[1]!;
	return segment;
}

function resolveBaseModelCandidate(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	if (baseModel.includes("/")) {
		const exact = availableModels.find((entry) => entry.fullId === baseModel);
		if (exact) return exact.fullId;
	} else {
		const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
		if (preferredProvider) {
			const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
			if (preferredMatch) return preferredMatch.fullId;
		}
		if (exactMatches.length === 1) return exactMatches[0]!.fullId;
	}

	return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and optional date-stamp differences so
 * users do not have to spell provider/model exactly. A qualified `provider/id`
 * query only matches within the named provider — this never silently switches
 * providers for security/cost-sensitive configs. Returns the matched `fullId`,
 * or `undefined` when there is no match or the match is ambiguous across
 * providers (and no `preferredProvider` disambiguates). Pure.
 */
export function fuzzyResolveModel(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	let queryProvider: string | undefined;
	let queryIdRaw = baseModel;
	const slashIdx = baseModel.indexOf("/");
	if (slashIdx !== -1) {
		queryProvider = normalizeModelSegment(baseModel.slice(0, slashIdx));
		queryIdRaw = baseModel.slice(slashIdx + 1);
	} else {
		const providerSeparators = [":", "."];
		for (const separator of providerSeparators) {
			const separatorIdx = baseModel.indexOf(separator);
			if (separatorIdx <= 0) continue;
			const providerPart = normalizeModelSegment(baseModel.slice(0, separatorIdx));
			if (!availableModels.some((entry) => normalizeModelSegment(entry.provider) === providerPart)) continue;
			queryProvider = providerPart;
			queryIdRaw = baseModel.slice(separatorIdx + 1);
			break;
		}
	}
	const queryId = normalizeModelSegment(queryIdRaw);
	const queryIdNoDate = stripTrailingDateStamp(queryId);

	const candidates = availableModels.filter((entry) => {
		const entryId = normalizeModelSegment(entry.id);
		if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
		if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider) return false;
		return true;
	});
	if (candidates.length === 0) return undefined;
	if (preferredProvider) {
		const preferredProviderNorm = normalizeModelSegment(preferredProvider);
		const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
		if (preferred) return preferred.fullId;
	}
	if (candidates.length === 1) return candidates[0]!.fullId;
	return undefined;
}

/**
 * Resolve a possibly-loose model id to a canonical `provider/id` (plus any
 * thinking suffix). Exact registry matches win; fuzzy normalization
 * (separator/case/date-stamp via {@link fuzzyResolveModel}) is a fallback so
 * spelling differences still resolve. Never switches providers for a qualified
 * query. Pure.
 */
export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (!availableModels || availableModels.length === 0) return model;

	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	if (!thinkingSuffix) return model;
	const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
	if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
	return model;
}

export interface ResolveSubagentModelOverrideOptions {
	/** When set with `enforce: true`, out-of-scope models are rejected. */
	scope?: ModelScopeConfig;
	/** Origin of the requested model: explicit caller-supplied (hard error) vs inherited (warn). Defaults to `"inherited"`. */
	source?: ModelSource;
	/** Called for warn-severity violations instead of `console.warn`. */
	onWarn?: (violation: ModelScopeViolation) => void;
}

/**
 * Where a child's effective model came from, in precedence order.
 *
 * The two "gap filler" sources (`user-default` and `parent-session`) both mean
 * "the agent never asked for a model", but they are kept apart on purpose: a
 * user-wide `subagents.defaultModel` is applied when agents are *discovered*,
 * which happens before a run's context mode is known, so it cannot tell a fresh
 * child from a forked one. Recording which of the two filled the gap is what
 * lets a receipt (and a later investigation) see the difference instead of
 * having to re-derive it.
 */
export type SubagentModelSource =
	/** Caller-supplied (`task.model` / `params.model`); always wins. */
	| "explicit"
	/** Declared on the agent itself (`model:` in frontmatter, or a settings override); always wins, fork or fresh. */
	| "agent"
	/** `subagents.defaultModel` filled the gap for a fresh child. */
	| "user-default"
	/** A defaulted model lost to the parent session model because the child forks the parent session. */
	| "fork-parent"
	/** Nothing set: the child inherits the parent session model, as it always has. */
	| "parent-session";

export interface SubagentModelResolution {
	/** The model the caller or the agent asked for, verbatim, before resolution. */
	requested?: string;
	/** The model the child will actually run, after resolution. */
	model?: string;
	source: SubagentModelSource;
}

/** True when `subagents.defaultModel` filled this agent's model rather than the agent declaring one. */
export function isDefaultedAgentModel(modelSource: { type: string } | undefined): boolean {
	return modelSource?.type === "subagents.defaultModel";
}

function defaultScopeWarn(violation: ModelScopeViolation): void {
	console.warn(`[pi-subagents] ${violation.message}`);
}

/**
 * Resolve the `--model` override passed to a spawned subagent.
 *
 * When no model is requested (`undefined`, `false`, empty, or the `"inherit"`
 * sentinel), the child must inherit the parent session's *in-memory* model
 * (`provider/id`) instead of being left to resolve its own model. Without an
 * explicit `provider/id`, the child falls back to the global
 * `~/.pi/agent/settings.json` default, which is shared across every open PI
 * session — so a different session that last changed its model in the TUI would
 * silently contaminate this session's subagents (see issue #266). Passing an
 * explicit `provider/id` keeps each session's children isolated to that
 * session's model.
 *
 * An explicitly requested model string is resolved via {@link resolveModelCandidate}.
 * When `options.scope.enforce` is on, an out-of-scope resolved model throws for
 * an explicit (`source: "explicit"`) request and warns for an inherited one.
 */
export function resolveSubagentModelOverride(
	requestedModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
	const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
	let resolved: string | undefined;
	if (explicit === undefined) {
		resolved = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
	} else {
		resolved = resolveModelCandidate(explicit, availableModels, preferredProvider);
	}
	if (resolved && options?.scope?.enforce) {
		const source: ModelSource = explicit === undefined ? "inherited" : (options.source ?? "inherited");
		const violation = checkModelScope(resolved, options.scope, source);
		if (violation) {
			if (violation.severity === "error") throw new Error(violation.message);
			(options.onWarn ?? defaultScopeWarn)(violation);
		}
	}
	return resolved;
}

export interface ResolveEffectiveSubagentModelOptions extends Omit<ResolveSubagentModelOverrideOptions, "source"> {
	/**
	 * True when this child forks the parent session. A *defaulted* model must not
	 * outrank the parent's: the fork continues the parent conversation, so the
	 * model the user picked for it is the one that applies. A *declared* model is
	 * unaffected — naming a model is a decision about that agent, not a gap filler.
	 */
	forked?: boolean;
	/** True when `agentModel` came from `subagents.defaultModel` (see {@link isDefaultedAgentModel}). */
	agentModelFromDefault?: boolean;
}

/** A model string that actually requests something (not `inherit`, not blank). */
function requestedModelOf(model: string | boolean | undefined): string | undefined {
	const trimmed = typeof model === "string" ? model.trim() : "";
	return trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
}

/**
 * Resolve a subagent's effective model together with *why* it got that model.
 *
 * Precedence, highest first:
 *
 * 1. caller-supplied model (`task.model` / `params.model`) — always wins
 * 2. model declared on the agent (frontmatter `model:`, or a settings override) —
 *    always wins, fork or fresh
 * 3. fork child — the parent session model, even when `subagents.defaultModel`
 *    filled the gap (see {@link ResolveEffectiveSubagentModelOptions.forked})
 * 4. fresh child — `subagents.defaultModel`
 * 5. nothing set — the parent session model, as it always has been
 *
 * Rows 1, 2, 4 and 5 are today's behaviour; row 3 is the one rule a user-wide
 * default cannot express on its own. The result carries its source so a launch
 * receipt can name the branch that fired instead of guessing from the string.
 */
export function resolveEffectiveSubagentModelWithSource(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveEffectiveSubagentModelOptions,
): SubagentModelResolution {
	const requestedExplicit = requestedModelOf(explicitModel);
	const requestedAgent = requestedModelOf(agentModel);
	const inheritFromParent = () =>
		resolveSubagentModelOverride(undefined, parentModel, availableModels, preferredProvider, options);

	// Row 3: a defaulted model loses to the parent on a fork.
	if (requestedExplicit === undefined && requestedAgent !== undefined && options?.forked === true && options.agentModelFromDefault === true) {
		return { requested: requestedAgent, model: inheritFromParent(), source: "fork-parent" };
	}

	const resolved = resolveSubagentModelOverride(
		explicitModel ?? agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source: explicitModel !== undefined ? "explicit" : "inherited" },
	);
	if (resolved === undefined && explicitModel !== undefined) {
		const fallback = resolveSubagentModelOverride(
			agentModel,
			parentModel,
			availableModels,
			preferredProvider,
			{ ...options, source: "inherited" },
		);
		return { requested: requestedAgent, model: fallback, source: agentSourceOf(requestedAgent, options) };
	}
	return {
		requested: requestedExplicit ?? requestedAgent,
		model: resolved,
		source: requestedExplicit !== undefined ? "explicit" : agentSourceOf(requestedAgent, options),
	};
}

function agentSourceOf(
	requestedAgent: string | undefined,
	options: ResolveEffectiveSubagentModelOptions | undefined,
): SubagentModelSource {
	if (requestedAgent === undefined) return "parent-session";
	return options?.agentModelFromDefault === true ? "user-default" : "agent";
}

/**
 * Backwards-compatible projection of {@link resolveEffectiveSubagentModelWithSource}.
 * Existing callers that do not care about provenance keep calling this; a caller
 * that launches a possible fork must call the `...WithSource` form and pass
 * `forked` so row 3 can fire, and should render the source with
 * {@link formatModelResolutionReceipt}.
 */
export function resolveEffectiveSubagentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveEffectiveSubagentModelOptions,
): string | undefined {
	return resolveEffectiveSubagentModelWithSource(
		explicitModel,
		agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		options,
	).model;
}

/** Human-readable provenance, as it appears in a launch receipt. */
const MODEL_SOURCE_LABELS: Record<SubagentModelSource, string> = {
	"explicit": "caller request",
	"agent": "agent frontmatter",
	"user-default": "user defaultModel",
	"fork-parent": "fork: parent session",
	"parent-session": "parent session",
};

/**
 * One compact launch line per child: `worker -> model (provenance)`.
 *
 * The provenance is taken from the resolver's own record, never re-derived
 * here, so this line cannot disagree with the model that was actually launched.
 */
export function formatModelResolutionReceipt(agent: string, resolution: SubagentModelResolution): string {
	return `${agent} -> ${resolution.model ?? "provider default"} (${MODEL_SOURCE_LABELS[resolution.source]})`;
}

export interface BuildModelCandidatesOptions {
	/** Fallback models are inherited agent config and warn, rather than error, when out of scope. */
	scope?: ModelScopeConfig;
	onWarn?: (violation: ModelScopeViolation) => void;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: BuildModelCandidatesOptions,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
	for (let index = 0; index < rawCandidates.length; index++) {
		const raw = rawCandidates[index];
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		if (index > 0 && options?.scope?.enforce) {
			const violation = checkModelScope(normalized, options.scope, "inherited");
			if (violation) (options.onWarn ?? defaultScopeWarn)(violation);
		}
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/stream ended without finish_reason/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
	/cold.?start/i,
	/empty response/i,
	/no output/i,
	/model.*(?:load|fail|error)/i,
];

/**
 * Failures reported as `<tool> failed (exit N): ...` or `<tool> failed with
 * exit code N` come from a tool call inside the child's task, not from the
 * provider/model, however network-flavored their details read. Retrying a
 * different model cannot fix them and would rerun the whole task. Tool names
 * include namespaced forms like `mcp.server/write`.
 */
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
