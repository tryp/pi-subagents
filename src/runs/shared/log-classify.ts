export type LogSeverity = "err" | "warn";

export interface LogCounts {
	err: number;
	warn: number;
	total: number;
}

const STRONG_ERROR_PATTERNS: readonly RegExp[] = [
	/^\s*Traceback\s*\((?:most recent call last|innermost last)\):/i,
	/^\s*(?:\[(?:ERROR|ERR|FATAL)\]|(?:ERROR|ERR|FATAL)\s*:)/i,
	/^\s*(?:TypeError|ReferenceError|AssertionError|RangeError|SyntaxError|URIError|EvalError|RuntimeError|ImportError|ModuleNotFoundError|KeyError|ValueError|IndexError|NameError|AttributeError|OSError|IOError|ConnectionError|TimeoutError|Exception|UncaughtException)\s*:/,
	/\bpanic\s*:/i,
	/\b(?:segmentation fault|segfault)\b/i,
	/\b(?:uncaught|unhandled)\s+(?:exception|error)\b/i,
];

const WARNING_PATTERNS: readonly RegExp[] = [
	/^\s*(?:\[(?:WARN|WARNING)\]|WARN(?:ING)?\b)/i,
	/\bdeprecat(?:ed|ion|ions)\b/i,
];

const WEAK_ERROR_PATTERN = /\b(?:failed|failure|failures|error|errors)\b/i;
const BENIGN_ERROR_PATTERNS: readonly RegExp[] = [
	/\b0\s+errors?\b/i,
	/\berror\s+handler\b.*\btests?\s+passed\b/i,
];
const PATH_PATTERN = /(?:[A-Za-z]:)?(?:\/|\\)[^\s"'<>)]*/g;
const EXTENSION_ERROR_PATH_PATTERN = /\berrors?\.[A-Za-z0-9]+\b/gi;

/** Classify one line. Weak error-shaped matches are warnings to limit false alarms. */
export function classifyLine(line: string): LogSeverity | null {
	if (STRONG_ERROR_PATTERNS.some((pattern) => pattern.test(line))) return "err";
	if (WARNING_PATTERNS.some((pattern) => pattern.test(line))) return "warn";
	if (BENIGN_ERROR_PATTERNS.some((pattern) => pattern.test(line))) return null;

	// Paths and filenames can contain "error" without describing an error event.
	const messageText = line.replace(PATH_PATTERN, " ").replace(EXTENSION_ERROR_PATH_PATTERN, " ");
	return WEAK_ERROR_PATTERN.test(messageText) ? "warn" : null;
}

/** Count all lines, including unclassified lines; a final newline is not an extra line. */
export function countLogLines(text: string): LogCounts {
	if (text.length === 0) return { err: 0, warn: 0, total: 0 };
	const lines = text.split(/\r\n|\n|\r/);
	if (lines[lines.length - 1] === "") lines.pop();
	const counts: LogCounts = { err: 0, warn: 0, total: lines.length };
	for (const line of lines) {
		const severity = classifyLine(line);
		if (severity === "err") counts.err += 1;
		else if (severity === "warn") counts.warn += 1;
	}
	return counts;
}

/** Return the first strong-error line, stripped of line endings and truncated. */
export function firstErrorLine(text: string, maxLen = 160): string | undefined {
	if (text.length === 0 || maxLen <= 0) return undefined;
	const lines = text.split(/\r\n|\n|\r/);
	const line = lines.find((candidate) => classifyLine(candidate) === "err");
	if (line === undefined) return undefined;
	return line.slice(0, maxLen);
}
