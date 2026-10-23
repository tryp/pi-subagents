import type { Api, Model } from "@earendil-works/pi-ai";

const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-go"]);
const SESSION_HEADER = "x-opencode-session";
const CLIENT_HEADER = "x-opencode-client";

export function isOpenCodeModel(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
	if (OPENCODE_PROVIDERS.has(model.provider)) return true;
	try {
		return new URL(model.baseUrl).hostname === "opencode.ai";
	} catch {
		return false;
	}
}

/** Attach tracking only to OpenCode requests without mutating caller-owned options or headers. */
export function withOpenCodeSession<T extends { headers?: Record<string, string | null>; sessionId?: string }>(
	model: Pick<Model<Api>, "provider" | "baseUrl"> & { headers?: Record<string, string> },
	sessionId: string | undefined,
	options: T,
): T {
	const track = Boolean(sessionId && isOpenCodeModel(model));
	if (!track) return options;
	const headers: Record<string, string | null> = {};
	const setHeader = (name: string, value: string | null) => {
		const previous = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
		if (previous) delete headers[previous];
		headers[name] = value;
	};
	if (track) {
		for (const [name, value] of Object.entries(model.headers ?? {})) setHeader(name, value);
	}
	for (const [name, value] of Object.entries(options.headers ?? {})) setHeader(name, value);
	if (!Object.keys(headers).some((name) => name.toLowerCase() === SESSION_HEADER)) setHeader(SESSION_HEADER, sessionId!);
	if (!Object.keys(headers).some((name) => name.toLowerCase() === CLIENT_HEADER)) setHeader(CLIENT_HEADER, "pi");
	return { ...options, sessionId, headers } as T;
}
