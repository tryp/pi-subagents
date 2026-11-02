export const SHARED_CONTEXT_OPEN_DELIMITER = "<subagent-shared-context>";
export const SHARED_CONTEXT_CLOSE_DELIMITER = "</subagent-shared-context>";

/** Format the invocation-level shared text without interpreting or normalizing it. */
export function formatSharedContextPreamble(sharedContext?: string): string {
	if (sharedContext === undefined || sharedContext.length === 0) return "";
	return `${SHARED_CONTEXT_OPEN_DELIMITER}\n${sharedContext}\n${SHARED_CONTEXT_CLOSE_DELIMITER}\n\n`;
}
