import type { ResolvedRlimits, ResourceLimitKind } from "../../shared/types.ts";

export const RLIMITS_ENV = "PI_SUBAGENT_RLIMITS";

/** Suppress core dumps by default: rlimit deaths dump core otherwise. */
export const DEFAULT_CORE_SIZE_MB = 0;

/**
 * Floor for RLIMIT_NOFILE. A value below this can prevent the child from
 * starting at all, which would look like an unexplained instant failure.
 */
export const MIN_OPEN_FILES = 64;

/** Minimum soft/hard gap for RLIMIT_CPU, in seconds. See cpuHardLimitSeconds. */
export const MIN_CPU_GRACE_SECONDS = 5;

/**
 * Resources that look plausible but cannot bound a Node child process.
 * Each entry records the measured reason so the error is actionable rather
 * than a silent footgun.
 */
const UNSUPPORTED_RLIMIT_FIELDS: Record<string, string> = {
	addressSpaceMb:
		"RLIMIT_AS cannot bound a Node child. V8 reserves a large virtual address space, so any value tight enough to be useful aborts the process at startup (measured: a 1.5 GiB address-space cap died at 200 MiB RSS with ERR_MEMORY_ALLOCATION_FAILED).",
	dataSegMb:
		"RLIMIT_DATA also aborts Node at startup for plausible values (measured: 256-512 MiB crashed).",
	rssMb:
		"RLIMIT_RSS is a no-op on Linux (measured: the process reached 2.4 GiB under a 50 MiB limit).",
	maxProcesses:
		"RLIMIT_NPROC is per real user ID, not per sub-agent tree, so it either does nothing or prevents the child from forking at all (measured: a 5-process limit left the child unable to fork because the user already had ~220 processes).",
};

/**
 * The hard CPU limit must exceed the soft limit, otherwise the kernel sends
 * SIGXCPU and SIGKILL at effectively the same instant and the child is
 * reported as SIGKILL, which is indistinguishable from our own timeout kill
 * (measured: `--cpu=1:1` reported SIGKILL; `--cpu=1:3` reported SIGXCPU).
 */
export function cpuHardLimitSeconds(softSeconds: number): number {
	return softSeconds + Math.max(MIN_CPU_GRACE_SECONDS, softSeconds);
}

export function hasRlimits(rlimits: ResolvedRlimits | undefined): boolean {
	return Boolean(
		rlimits &&
			(rlimits.cpuSeconds !== undefined ||
				rlimits.fileSizeMb !== undefined ||
				rlimits.openFiles !== undefined ||
				rlimits.coreSizeMb !== undefined),
	);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function validateRlimitsConfig(
	raw: unknown,
	label = "rlimits",
): { rlimits?: ResolvedRlimits; error?: string } {
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: `${label} must be an object of OS resource limits.` };
	}
	const value = raw as Record<string, unknown>;

	for (const key of Object.keys(value)) {
		if (value[key] === undefined) continue;
		const unsupportedReason = UNSUPPORTED_RLIMIT_FIELDS[key];
		if (unsupportedReason) return { error: `${label}.${key} is not supported. ${unsupportedReason}` };
		if (key !== "cpuSeconds" && key !== "fileSizeMb" && key !== "openFiles" && key !== "coreSizeMb") {
			return { error: `${label}.${key} is not supported.` };
		}
	}

	if (value.cpuSeconds !== undefined && !isPositiveInteger(value.cpuSeconds)) {
		return { error: `${label}.cpuSeconds must be an integer >= 1.` };
	}
	if (value.fileSizeMb !== undefined && !isPositiveInteger(value.fileSizeMb)) {
		return { error: `${label}.fileSizeMb must be an integer >= 1.` };
	}
	if (value.openFiles !== undefined) {
		if (!isPositiveInteger(value.openFiles)) {
			return { error: `${label}.openFiles must be an integer >= ${MIN_OPEN_FILES}.` };
		}
		if (value.openFiles < MIN_OPEN_FILES) {
			return {
				error: `${label}.openFiles must be >= ${MIN_OPEN_FILES}; a lower value can prevent the child process from starting.`,
			};
		}
	}
	if (value.coreSizeMb !== undefined) {
		if (typeof value.coreSizeMb !== "number" || !Number.isInteger(value.coreSizeMb) || value.coreSizeMb < 0) {
			return { error: `${label}.coreSizeMb must be an integer >= 0.` };
		}
	}

	const resolved: ResolvedRlimits = {
		...(value.cpuSeconds !== undefined ? { cpuSeconds: value.cpuSeconds as number } : {}),
		...(value.fileSizeMb !== undefined ? { fileSizeMb: value.fileSizeMb as number } : {}),
		...(value.openFiles !== undefined ? { openFiles: value.openFiles as number } : {}),
		...(value.coreSizeMb !== undefined ? { coreSizeMb: value.coreSizeMb as number } : {}),
	};
	if (!hasRlimits(resolved)) return {};
	// A limit-triggered death (SIGXCPU/SIGXFSZ) dumps core by default, which can
	// leave a multi-GB Node core file behind. Suppress unless the caller opted in.
	return { rlimits: { ...resolved, coreSizeMb: resolved.coreSizeMb ?? DEFAULT_CORE_SIZE_MB } };
}

/**
 * Reject limits this host cannot enforce rather than accepting them and running
 * the child unbounded. A configured resource bound that is silently dropped
 * gives a false sense of protection, which is worse than an explicit failure.
 */
export function rlimitsEnforceabilityError(
	rlimits: ResolvedRlimits | undefined,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (!hasRlimits(rlimits)) return undefined;
	if (platform !== "linux") {
		return `rlimits requires Linux (prlimit); this host is ${platform}. Remove the rlimits configuration or run on Linux.`;
	}
	return undefined;
}

/**
 * Build the prlimit(1) flag list for resolved limits. Pure and order-stable so
 * the spawned command can be asserted exactly in tests.
 */
export function buildRlimitArgs(rlimits: ResolvedRlimits | undefined): string[] {
	if (!rlimits) return [];
	const args: string[] = [];
	if (rlimits.cpuSeconds !== undefined) {
		args.push(`--cpu=${rlimits.cpuSeconds}:${cpuHardLimitSeconds(rlimits.cpuSeconds)}`);
	}
	if (rlimits.fileSizeMb !== undefined) {
		args.push(`--fsize=${rlimits.fileSizeMb * 1024 * 1024}`);
	}
	if (rlimits.openFiles !== undefined) {
		args.push(`--nofile=${rlimits.openFiles}`);
	}
	if (rlimits.coreSizeMb !== undefined) {
		args.push(`--core=${rlimits.coreSizeMb * 1024 * 1024}`);
	}
	return args;
}

/** Human-readable summary used in notices and result messages. */
export function describeRlimits(rlimits: ResolvedRlimits | undefined): string {
	if (!hasRlimits(rlimits)) return "none";
	const parts: string[] = [];
	if (rlimits?.cpuSeconds !== undefined) {
		parts.push(`cpu ${rlimits.cpuSeconds}s (hard ${cpuHardLimitSeconds(rlimits.cpuSeconds)}s)`);
	}
	if (rlimits?.fileSizeMb !== undefined) parts.push(`file size ${rlimits.fileSizeMb}MiB`);
	if (rlimits?.openFiles !== undefined) parts.push(`open files ${rlimits.openFiles}`);
	if (rlimits?.coreSizeMb !== undefined) parts.push(`core ${rlimits.coreSizeMb}MiB`);
	return parts.join(", ");
}

export function resourceLimitExceededMessage(
	kind: ResourceLimitKind,
	rlimits: ResolvedRlimits | undefined,
): string {
	const label = kind === "cpuSeconds" ? "CPU time" : "file size";
	return `Subagent exceeded its ${label} resource limit (${describeRlimits(rlimits)}). The child was terminated by the kernel limit.`;
}

/**
 * Map the kernel's terminating signal back to the limit that caused it, so a
 * limit death is reported as a resource bound rather than a bare signal.
 */
export function resourceLimitKindForSignal(
	signal: NodeJS.Signals | null | undefined,
	rlimits: ResolvedRlimits | undefined,
): ResourceLimitKind | undefined {
	if (!rlimits) return undefined;
	if (signal === "SIGXCPU" && rlimits.cpuSeconds !== undefined) return "cpuSeconds";
	if (signal === "SIGXFSZ" && rlimits.fileSizeMb !== undefined) return "fileSizeMb";
	return undefined;
}

export function encodeRlimitsEnv(rlimits: ResolvedRlimits | undefined): string | undefined {
	return hasRlimits(rlimits) ? JSON.stringify(rlimits) : undefined;
}

/**
 * Hard limits this process already inherited, parsed from /proc/self/limits.
 * A child can never raise a hard limit above these, so requests must be
 * clamped: prlimit(1) otherwise fails with EPERM and never execs the target,
 * which surfaces as a cryptic start failure instead of a bounded run.
 */
export interface InheritedHardLimits {
	cpuSeconds?: number;
	fileSizeBytes?: number;
	openFiles?: number;
	coreSizeBytes?: number;
}

const PROC_LIMIT_PREFIXES: Array<[prefix: string, key: keyof InheritedHardLimits]> = [
	["Max cpu time", "cpuSeconds"],
	["Max file size", "fileSizeBytes"],
	["Max open files", "openFiles"],
	["Max core file size", "coreSizeBytes"],
];

/** Parse the hard column of /proc/self/limits. `unlimited` means no clamp. */
export function parseProcSelfLimits(text: string): InheritedHardLimits {
	const limits: InheritedHardLimits = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		for (const [prefix, key] of PROC_LIMIT_PREFIXES) {
			if (!trimmed.startsWith(prefix)) continue;
			// Columns: soft, hard, units -- the name column is space-padded.
			const hard = trimmed.slice(prefix.length).trim().split(/\s+/)[1];
			if (!hard || hard === "unlimited") continue;
			const value = Number(hard);
			if (Number.isFinite(value) && value >= 0) limits[key] = value;
		}
	}
	return limits;
}

/**
 * Largest CPU soft limit whose derived hard limit still fits under `hard`.
 * cpuHardLimitSeconds is soft+5 below 5s and 2*soft at or above it.
 */
export function maxCpuSoftForHard(hard: number): number {
	return hard >= 10 ? Math.floor(hard / 2) : hard - 5;
}

/**
 * Lower each requested limit to fit inside the inherited hard limits. Only ever
 * tightens, because the inherited limit would be enforced anyway; a limit with
 * no remaining room is dropped rather than passed to prlimit(1).
 */
export function clampRlimitsToInherited(
	rlimits: ResolvedRlimits | undefined,
	inherited: InheritedHardLimits,
): ResolvedRlimits | undefined {
	if (!rlimits) return undefined;
	const clamped: ResolvedRlimits = { ...rlimits };

	if (clamped.cpuSeconds !== undefined && inherited.cpuSeconds !== undefined) {
		const room = maxCpuSoftForHard(inherited.cpuSeconds);
		if (room < 1) delete clamped.cpuSeconds;
		else clamped.cpuSeconds = Math.min(clamped.cpuSeconds, room);
	}
	if (clamped.fileSizeMb !== undefined && inherited.fileSizeBytes !== undefined) {
		const roomMb = Math.floor(inherited.fileSizeBytes / (1024 * 1024));
		if (roomMb < 1) delete clamped.fileSizeMb;
		else clamped.fileSizeMb = Math.min(clamped.fileSizeMb, roomMb);
	}
	if (clamped.openFiles !== undefined && inherited.openFiles !== undefined) {
		clamped.openFiles = Math.min(clamped.openFiles, inherited.openFiles);
	}
	if (clamped.coreSizeMb !== undefined && inherited.coreSizeBytes !== undefined) {
		const roomMb = Math.floor(inherited.coreSizeBytes / (1024 * 1024));
		clamped.coreSizeMb = Math.min(clamped.coreSizeMb, roomMb);
	}

	return hasRlimits(clamped) ? clamped : undefined;
}

export function decodeRlimitsEnv(value: string | undefined): ResolvedRlimits | undefined {
	if (!value?.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		// Label the failure: this value is normally written by buildPiArgs, but it
		// is inherited through the child environment and may be set externally.
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid ${RLIMITS_ENV}: ${message}`);
	}
	const normalized = validateRlimitsConfig(parsed, RLIMITS_ENV);
	if (normalized.error) throw new Error(normalized.error);
	return normalized.rlimits;
}
