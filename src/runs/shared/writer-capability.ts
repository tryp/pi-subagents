export const READ_ONLY_CHILD_TOOLS = ["read", "grep", "find", "ls"] as const;
export const READ_ONLY_PARENT_ENV = "PI_SUBAGENT_READ_ONLY_CAPABILITY";

export interface ReadOnlyToolPolicyInput {
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
}

/** Apply the exact tool allowlist used by the cwd capability classifier. */
export function applyReadOnlyToolPolicy<T extends ReadOnlyToolPolicyInput>(agent: T): T {
	return {
		...agent,
		tools: [...READ_ONLY_CHILD_TOOLS],
		extensions: [],
		subagentOnlyExtensions: [],
		mcpDirectTools: [],
	};
}

/** True only for the exact built-in allowlist installed by the readOnly dispatch option. */
export function isReadOnlyToolSet(tools: readonly string[] | undefined): boolean {
	return !!tools
		&& tools.length === READ_ONLY_CHILD_TOOLS.length
		&& READ_ONLY_CHILD_TOOLS.every((tool) => tools.includes(tool));
}

export function isReadOnlyToolCapability(agent: ReadOnlyToolPolicyInput): boolean {
	return isReadOnlyToolSet(agent.tools)
		&& agent.extensions?.length === 0
		&& agent.subagentOnlyExtensions?.length === 0
		&& agent.mcpDirectTools?.length === 0;
}
