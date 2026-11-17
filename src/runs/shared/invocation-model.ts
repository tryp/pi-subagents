import { isDynamicParallelStep, isParallelStep, type ChainStep } from "../../shared/settings.ts";

interface InvocationModelParams {
	model?: string;
	tasks?: Array<{ agent: string; model?: string }>;
	chain?: ChainStep[];
}

/** Materialize the invocation default before fork preparation or execution routing.
 * Keep raw model strings (including inherit/thinking suffixes) for the existing
 * registry, fallback and thinking resolvers. Never mutate the caller's entries.
 */
export function applyInvocationModelDefaults<T extends InvocationModelParams>(params: T): T {
	const model = params.model;
	if (model === undefined) return params;
	const withDefault = <E extends { model?: string }>(entry: E): E =>
		entry.model === undefined ? { ...entry, model } : entry;
	return {
		...params,
		...(params.tasks ? { tasks: params.tasks.map(withDefault) } : {}),
		...(params.chain ? {
			chain: params.chain.map((step): ChainStep => {
				if (isParallelStep(step)) return { ...step, parallel: step.parallel.map(withDefault) };
				if (isDynamicParallelStep(step)) return { ...step, parallel: withDefault(step.parallel) };
				return withDefault(step);
			}),
		} : {}),
	};
}
