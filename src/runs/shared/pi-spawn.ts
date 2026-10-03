import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedRlimits } from "../../shared/types.ts";
import { buildRlimitArgs, clampRlimitsToInherited, describeRlimits, hasRlimits, parseProcSelfLimits, type InheritedHardLimits } from "./rlimits.ts";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
export const PRLIMIT_COMMAND = "prlimit";

export function findPiPackageRootFromEntry(
	entryPoint: string,
): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
				name?: unknown;
			};
			if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
	return findPiPackageRootFromEntry(
		fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)),
	);
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry
			? findPiPackageRootFromEntry(fs.realpathSync(entry))
			: undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
		return undefined;
	}
}

export interface PiSpawnDeps {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	existsSync?: (filePath: string) => boolean;
	realpathSync?: (filePath: string) => string;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	resolvePackageJson?: () => string;
	resolvePackageEntry?: () => string;
	piPackageRoot?: string;
	env?: NodeJS.ProcessEnv;
	/** Resolved OS resource limits to apply to the child via prlimit(1). */
	rlimits?: ResolvedRlimits;
	/** Injectable prlimit(1) lookup so tests never probe the real PATH. */
	resolvePrlimitPath?: () => string | undefined;
	/** Hard limits already inherited by this process; read from /proc when omitted. */
	inheritedHardLimits?: InheritedHardLimits;
}

export interface PiSpawnCommand {
	command: string;
	args: string[];
	/**
	 * Limits actually applied to the child, after clamping to the inherited hard
	 * limits. Attribution must use these rather than the requested values, since
	 * the kernel enforces the clamped ones.
	 */
	rlimitsApplied?: ResolvedRlimits;
	/** Why requested limits were not applied. Absent when applied or not requested. */
	rlimitsSkipped?: string;
}

function isRunnableNodeScript(
	filePath: string,
	existsSync: (filePath: string) => boolean,
): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

export function resolvePiCliScript(
	deps: PiSpawnDeps = {},
): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const realpathSync = deps.realpathSync ?? fs.realpathSync;
	const readFileSync =
		deps.readFileSync ??
		((filePath, encoding) => fs.readFileSync(filePath, encoding));
	const argv1 = deps.argv1 ?? process.argv[1];

	if (argv1) {
		const argvPath = normalizePath(argv1);
		if (isRunnableNodeScript(argvPath, existsSync)) {
			try {
				const canonicalArgvPath = realpathSync(argvPath);
				if (isRunnableNodeScript(canonicalArgvPath, existsSync) && findPiPackageRootFromEntry(canonicalArgvPath)) {
					return canonicalArgvPath;
				}
			} catch {
				// Host package metadata is untrusted here; keep resolving the installed Pi CLI.
			}
		}
	}

	try {
		const resolvePackageJson =
			deps.resolvePackageJson ??
			(() => {
				const root = deps.piPackageRoot ?? resolvePiPackageRoot();
				if (root) return path.join(root, "package.json");
				const packageRoot = deps.resolvePackageEntry
					? findPiPackageRootFromEntry(deps.resolvePackageEntry())
					: resolveInstalledPiPackageRoot();
				if (!packageRoot)
					throw new Error(
						`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`,
					);
				return path.join(packageRoot, "package.json");
			});
		const packageJsonPath = resolvePackageJson();
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = packageJson.bin;
		const binPath =
			typeof binField === "string"
				? binField
				: (binField?.pi ?? Object.values(binField ?? {})[0]);
		if (!binPath) return undefined;
		const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
		if (isRunnableNodeScript(candidate, existsSync)) {
			return candidate;
		}
	} catch {
		// Verified CLI resolution is optional; falling back to `pi` lets PATH handle execution.
		return undefined;
	}

	return undefined;
}

export function resolvePrlimitPath(deps: PiSpawnDeps = {}): string | undefined {
	if (deps.resolvePrlimitPath) return deps.resolvePrlimitPath();
	const existsSync = deps.existsSync ?? fs.existsSync;
	const env = deps.env ?? process.env;
	const pathValue = env.PATH ?? env.Path ?? "";
	if (!pathValue) return undefined;
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, PRLIMIT_COMMAND);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Why OS rlimits cannot be applied on this host, or undefined when they can.
 * `getPiSpawnCommand` turns this into `rlimitsSkipped`, and the spawn sites
 * report that on the child's stderr, so configured bounds are never dropped
 * without a visible reason. The platform case is also rejected earlier, at
 * resolution time, by `rlimitsEnforceabilityError`.
 */
export function rlimitsUnsupportedReason(
	deps: PiSpawnDeps = {},
): "platform" | "missing-prlimit" | undefined {
	if ((deps.platform ?? process.platform) !== "linux") return "platform";
	if (!resolvePrlimitPath(deps)) return "missing-prlimit";
	return undefined;
}

/**
 * Hard limits this process already inherited. Read lazily from /proc/self/limits
 * so a requested limit can be clamped instead of being rejected by prlimit(1).
 */
export function readInheritedHardLimits(deps: PiSpawnDeps = {}): InheritedHardLimits {
	if (deps.inheritedHardLimits) return deps.inheritedHardLimits;
	if ((deps.platform ?? process.platform) !== "linux") return {};
	const readFileSync = deps.readFileSync ?? ((filePath: string, encoding: "utf-8") => fs.readFileSync(filePath, encoding));
	try {
		return parseProcSelfLimits(readFileSync("/proc/self/limits", "utf-8"));
	} catch {
		// An unreadable /proc leaves the request unclamped; prlimit(1) still reports
		// any rejection on the child's stderr.
		return {};
	}
}

function resolveBasePiSpawnCommand(
	args: string[],
	deps: PiSpawnDeps = {},
): PiSpawnCommand {
	const env = deps.env ?? process.env;
	const piBinary = env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
	if (piBinary) {
		return { command: piBinary, args };
	}

	const piCliPath = resolvePiCliScript(deps);
	if (piCliPath) {
		return {
			command: deps.execPath ?? process.execPath,
			args: [piCliPath, ...args],
		};
	}

	return { command: "pi", args };
}

export function getPiSpawnCommand(
	args: string[],
	deps: PiSpawnDeps = {},
): PiSpawnCommand {
	const base = resolveBasePiSpawnCommand(args, deps);
	if (!hasRlimits(deps.rlimits)) return base;
	// Requested limits must never be dropped silently: report why they cannot be
	// applied so callers can surface it instead of implying the child is bounded.
	const unsupported = rlimitsUnsupportedReason(deps);
	if (unsupported === "platform") {
		return { ...base, rlimitsSkipped: `OS resource limits (${describeRlimits(deps.rlimits)}) were not applied: they require Linux (prlimit). This host is ${deps.platform ?? process.platform}.` };
	}
	if (unsupported === "missing-prlimit") {
		return { ...base, rlimitsSkipped: `OS resource limits (${describeRlimits(deps.rlimits)}) were not applied: the prlimit(1) command was not found on PATH.` };
	}
	// Clamp to the inherited hard limits first: prlimit(1) cannot raise a hard
	// limit, and a rejected request aborts the spawn instead of running bounded.
	const effective = clampRlimitsToInherited(deps.rlimits, readInheritedHardLimits(deps));
	if (!hasRlimits(effective)) {
		return { ...base, rlimitsSkipped: `OS resource limits (${describeRlimits(deps.rlimits)}) were not applied: this process already inherited tighter hard limits.` };
	}
	const flags = buildRlimitArgs(effective);
	if (flags.length === 0) return base;
	const prlimitPath = resolvePrlimitPath(deps);
	// Unreachable while `rlimitsUnsupportedReason` checks first, but never fall back
	// to an unwrapped command: an unapplied requested bound must stay visible.
	if (!prlimitPath) {
		return { ...base, rlimitsSkipped: `OS resource limits (${describeRlimits(deps.rlimits)}) were not applied: the prlimit(1) command was not found on PATH.` };
	}
	// prlimit(1) execs the target in place, so the returned PID is the child
	// itself and signal/exit semantics are unchanged.
	return {
		command: prlimitPath,
		args: [...flags, "--", base.command, ...base.args],
		rlimitsApplied: effective,
	};
}
