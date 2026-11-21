export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ModelInfo {
	provider: string;
	id: string;
	fullId: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

interface RegistryModelLike {
	provider: string;
	id: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

export function toModelInfo(model: RegistryModelLike): ModelInfo {
	return {
		provider: model.provider,
		id: model.id,
		fullId: `${model.provider}/${model.id}`,
		api: model.api,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
	};
}

/** Resolve the effective thinking level from a model string (which may contain a known suffix like `:high`)
 * and an explicit thinking config value. Returns `undefined` when no thinking is applicable
 * (e.g. no model was specified, or the model has no suffix and no config was provided). */
export function resolveEffectiveThinking(model: string | undefined, configThinking: string | false | undefined): string | undefined {
	if (!model) return undefined;
	const { thinkingSuffix } = splitKnownThinkingSuffix(model);
	if (thinkingSuffix) return thinkingSuffix.slice(1);
	return THINKING_LEVELS.find((level) => level === configThinking);
}

export function splitKnownThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
	if (!suffix) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: `:${suffix}`,
	};
}

export interface ModelResolutionOptions {
	enabledModels?: ModelInfo[];
	isAuthenticated?: (model: ModelInfo) => boolean;
	preferredProvider?: string;
	onWarning?: (message: string) => void;
}

/** Resolve exact qualified ids unchanged; bare ids honor enabled scope before authenticated registry fallback. */
export function resolveScopedModelInfo(
	model: string | undefined,
	availableModels: ModelInfo[] | undefined,
	options: ModelResolutionOptions = {},
): { model?: ModelInfo; thinkingSuffix: string; error?: string } {
	if (!model || !availableModels?.length) return { thinkingSuffix: "" };
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model);
	if (baseModel.includes("/")) {
		return { model: availableModels.find((entry) => entry.fullId === baseModel), thinkingSuffix };
	}

	const enabledMatches = options.enabledModels?.filter((entry) => entry.id === baseModel) ?? [];
	const allMatches = availableModels.filter((entry) => entry.id === baseModel);
	let matches = enabledMatches.length ? enabledMatches : allMatches;
	if (!enabledMatches.length && options.isAuthenticated) {
		matches = matches.filter((entry) => options.isAuthenticated!(entry));
		if (allMatches.length && !matches.length) {
			return { thinkingSuffix, error: `Model '${baseModel}' is present only under providers without configured credentials.` };
		}
	}
	if (!matches.length) return { thinkingSuffix };
	if (!enabledMatches.length && !options.isAuthenticated && !options.preferredProvider && matches.length > 1) return { thinkingSuffix };

	const preferred = options.preferredProvider ? matches.find((entry) => entry.provider === options.preferredProvider) : undefined;
	const ordered = [...matches].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	const chosen = preferred ?? ordered[0]!;
	if (matches.length > 1 && !preferred) {
		const alternatives = ordered.filter((entry) => entry.fullId !== chosen.fullId).map((entry) => entry.fullId);
		options.onWarning?.(`Ambiguous model '${baseModel}'; selected ${chosen.fullId} from ${enabledMatches.length ? "enabled scope" : "authenticated providers"}; alternatives: ${alternatives.join(", " )}.`);
	}
	return { model: chosen, thinkingSuffix };
}

export function findModelInfo(
	model: string | undefined,
	availableModels: ModelInfo[] | undefined,
	preferredProvider?: string,
	options: Omit<ModelResolutionOptions, "preferredProvider"> = {},
): ModelInfo | undefined {
	return resolveScopedModelInfo(model, availableModels, { ...options, preferredProvider }).model;
}

export function getSupportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
	if (!model) return THINKING_LEVELS.filter((level) => level !== "max");
	if (model.reasoning === false) return ["off"];

	if (!model.thinkingLevelMap) return THINKING_LEVELS.filter((level) => level !== "max");

	const levels = THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
	return levels;
}
