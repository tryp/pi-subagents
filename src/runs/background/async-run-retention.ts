import fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { ASYNC_RUN_GC_BUDGET_BYTES } from "../../shared/settings.ts";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR } from "../../shared/types.ts";

export { ASYNC_RUN_GC_BUDGET_BYTES };
export const ASYNC_RUN_GC_KEEP_RECENT_TERMINAL = 20;
export const ASYNC_RUN_GC_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const ASYNC_RUN_GC_STARTUP_DELAY_MS = 2_000;

const TERMINAL_STATES = new Set(["complete", "failed", "stopped"]);
const MAX_PROC_ENTRIES = 50_000;
const MAX_FD_ENTRIES = 500_000;

export interface FdScanResult {
	complete: boolean;
	unreadable: number;
	foreignUid: number;
	scannedReadableForeign: number;
	foreignUnreadable: number;
	sameUidUnreadable: number;
	uidUnverifiable: number;
	scanTruncated: boolean;
	unreadableForeignUids: number[];
	openPaths: string[];
}

export interface AsyncRunGcSummary {
	examined: number;
	candidatesSeen: number;
	considered: number;
	deferredByBudget: number;
	elapsedMs: number;
	pruned: number;
	wouldPrune: number;
	kept: Record<string, number>;
	bytesReclaimed: number;
	bytesWouldReclaim: number;
	bytesBefore: number;
	bytesAfter: number;
	fdScan: { complete: boolean; unreadable: number; foreignUid: number; foreignUnreadable: number; sameUidUnreadable: number; uidUnverifiable: number; scanTruncated: boolean };
	scannedReadableForeign: number;
	skippedUnreadableForeignProvenUnreachable: number;
	keptUnreadableForeignReachable: number;
	keptUnknownUid: number;
	keptAcl: number;
	keptForeignOwner: number;
	keptStatError: number;
	keptSameUidUnreadable: number;
	keptWorldAccessible: number;
	keptUidUnverifiable: number;
	keptOwnerAlive: number;
	keptMissingStatus: number;
	keptUnreadableStatusForeign: number;
	statusErrors: Record<string, number>;
	outcomes: Record<string, number>;
}

export interface AsyncRunGcOptions {
	asyncDir?: string;
	resultsDir?: string;
	nestedEventsDir?: string;
	budgetBytes?: number;
	keepRecentTerminal?: number;
	minAgeMs?: number;
	now?: number;
	procRoot?: string;
	dryRun?: boolean;
	isPidAlive?: (pid: number) => boolean;
	scanOpenFds?: (paths: string[], procRoot: string) => FdScanResult;
	log?: (line: string) => void;
}

type ForeignReachabilityReason = "mode-blocked" | "acl" | "foreign-owner" | "stat-error" | "reachable";

interface ForeignReachabilityAssessment {
	foreignReachable: boolean;
	reason: ForeignReachabilityReason;
}

interface RunCandidate {
	id: string;
	foreignReachability?: ForeignReachabilityAssessment;
	status: Record<string, unknown> | null;
	statusIssue?: string;
	statusErrorCode?: string;
	state: string | null;
	pidSet: number[];
	paths: string[];
	bytes: number;
	updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isAccessDenied(error: unknown): boolean {
	return isRecord(error) && (error.code === "EACCES" || error.code === "EPERM");
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isRecord(error) || error.code !== "ESRCH";
	}
}

function hasInvalidPid(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasInvalidPid);
	if (!isRecord(value)) return false;
	if ("pid" in value && value.pid !== undefined && (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0)) return true;
	return Object.values(value).some(hasInvalidPid);
}

function collectPids(value: unknown, output = new Set<number>()): number[] {
	if (Array.isArray(value)) {
		for (const child of value) collectPids(child, output);
	} else if (isRecord(value)) {
		if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) output.add(value.pid);
		for (const child of Object.values(value)) collectPids(child, output);
	}
	return [...output];
}

function containedPath(root: string, target: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target.replace(/ \(deleted\)$/, ""));
	return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

/**
 * A foreign uid cannot inherit or otherwise hold our descriptors absent privileged fd transfer
 * (for example SCM_RIGHTS to a cooperating foreign process, or root). We skip only a positively
 * identified foreign uid, and only collect its unreadable-fd case for trees not world-accessible.
 * Unknown uid and same-uid unreadability remain fail-closed.
 */
export function scanProcOpenFds(paths: string[], procRoot = "/proc"): FdScanResult {
	let complete = true;
	let scanTruncated = false;
	let unreadable = 0;
	let foreignUid = 0;
	let scannedReadableForeign = 0;
	let foreignUnreadable = 0;
	const unreadableForeignUids = new Set<number>();
	let sameUidUnreadable = 0;
	let uidUnverifiable = 0;
	let procEntries: fs.Dirent[];
	try {
		procEntries = fs.readdirSync(procRoot, { withFileTypes: true });
	} catch {
		return { complete: false, unreadable: 1, foreignUid: 0, scannedReadableForeign: 0, foreignUnreadable: 0, sameUidUnreadable: 0, uidUnverifiable: 1, scanTruncated: false, unreadableForeignUids: [], openPaths: [] };
	}
	const processEntries = procEntries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));
	if (processEntries.length > MAX_PROC_ENTRIES) { complete = false; scanTruncated = true; }
	const openPaths = new Set<string>();
	let scannedFds = 0;
	const ourUid = typeof process.getuid === "function" ? process.getuid() : null;
	for (const procEntry of processEntries.slice(0, MAX_PROC_ENTRIES)) {
		const procDir = path.join(procRoot, procEntry.name);
		let status: string;
		try {
			status = fs.readFileSync(path.join(procDir, "status"), "utf8");
		} catch (error) {
			if (isNotFound(error)) continue;
			unreadable++;
			uidUnverifiable++;
			complete = false;
			continue;
		}
		const uidLine = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
		const uids = uidLine?.slice(1).map(Number);
		if (!uids || uids.length !== 4 || uids.some((uid) => !Number.isSafeInteger(uid)) || ourUid === null) {
			unreadable++;
			uidUnverifiable++;
			complete = false;
			continue;
		}
		const isForeign = uids.every((uid) => uid !== ourUid);
		if (isForeign) foreignUid++;
		let descriptors: string[];
		try {
			descriptors = fs.readdirSync(path.join(procDir, "fd"));
		} catch (error) {
			if (isNotFound(error)) continue;
			unreadable++;
			complete = false;
			if (isForeign) {
				foreignUnreadable++;
				unreadableForeignUids.add(uids[0]!);
			} else sameUidUnreadable++;
			continue;
		}
		if (isForeign) scannedReadableForeign++;
		for (const descriptor of descriptors) {
			if (++scannedFds > MAX_FD_ENTRIES) {
				complete = false;
				scanTruncated = true;
				return { complete, unreadable, foreignUid, scannedReadableForeign, foreignUnreadable, sameUidUnreadable, uidUnverifiable, scanTruncated, unreadableForeignUids: [...unreadableForeignUids], openPaths: [...openPaths] };
			}
			let target: string;
			try {
				target = fs.readlinkSync(path.join(procDir, "fd", descriptor));
			} catch (error) {
				if (isNotFound(error)) continue;
				unreadable++;
				complete = false;
				if (isForeign) {
					foreignUnreadable++;
					unreadableForeignUids.add(uids[0]!);
				} else sameUidUnreadable++;
				continue;
			}
			for (const candidatePath of paths) {
				if (containedPath(candidatePath, target)) {
					openPaths.add(candidatePath);
					break;
				}
			}
		}
	}
	return { complete, unreadable, foreignUid, scannedReadableForeign, foreignUnreadable, sameUidUnreadable, uidUnverifiable, scanTruncated, unreadableForeignUids: [...unreadableForeignUids], openPaths: [...openPaths] };
}

function pathComponents(item: string): string[] | null {
	try {
		const resolved = fs.realpathSync(item);
		const parsed = path.parse(resolved);
		const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
		const output = [parsed.root];
		let current = parsed.root;
		for (const component of components) {
			current = path.join(current, component);
			output.push(current);
		}
		return output;
	} catch {
		return null;
	}
}

function scanPosixAcls(paths: string[]): { aclPaths: Set<string>; unknownPaths: Set<string> } {
	const allPaths = new Set<string>();
	const unknownPaths = new Set<string>();
	for (const item of paths) {
		const components = pathComponents(item);
		if (!components) unknownPaths.add(path.resolve(item));
		else for (const component of components) allPaths.add(component);
	}
	const aclPaths = new Set<string>();
	const batches = [...allPaths];
	for (let offset = 0; offset < batches.length; offset += 128) {
		const batch = batches.slice(offset, offset + 128);
		try {
			const output = execFileSync("getfattr", [
				"--absolute-names", "--dump", "--match", "^system\\.posix_acl_(access|default)$", ...batch,
			], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });
			let activePath: string | null = null;
			for (const line of output.split("\n")) {
				const header = /^# file: (.*)$/.exec(line);
				if (header) activePath = header[1]!;
				else if (activePath && /^system\.posix_acl_(access|default)=/.test(line)) aclPaths.add(path.resolve(activePath));
			}
		} catch {
			for (const item of batch) unknownPaths.add(item);
		}
	}
	return { aclPaths, unknownPaths };
}

function assessForeignReachability(
	paths: string[],
	ourUid: number,
): ForeignReachabilityAssessment {
	for (const item of paths) {
		const components = pathComponents(item);
		if (!components) return { foreignReachable: true, reason: "stat-error" };
		let modeBlocked = false;
		for (let index = 0; index < components.length; index++) {
			const component = components[index]!;
			let stat: fs.Stats;
			try { stat = fs.statSync(component); }
			catch { return { foreignReachable: true, reason: "stat-error" }; }
			const isLeaf = index === components.length - 1;
			if (isLeaf && stat.uid !== ourUid) return { foreignReachable: true, reason: "foreign-owner" };
			const mode = stat.mode & 0o777;
			const nonOwnerExecute = (mode & 0o011) !== 0;
			const nonOwnerRead = (mode & 0o044) !== 0;
			if (!isLeaf && !nonOwnerExecute) modeBlocked = true;
			if (isLeaf && !(stat.isDirectory() ? nonOwnerRead && nonOwnerExecute : nonOwnerRead)) modeBlocked = true;
		}
		if (!modeBlocked) return { foreignReachable: true, reason: "reachable" };
	}
	return { foreignReachable: false, reason: "mode-blocked" };
}

function aclReachability(paths: string[], aclScan: { aclPaths: Set<string>; unknownPaths: Set<string> }): ForeignReachabilityReason | null {
	for (const item of paths) {
		const components = pathComponents(item);
		if (!components) return "stat-error";
		for (const component of components) {
			if (aclScan.unknownPaths.has(component)) return "stat-error";
			if (aclScan.aclPaths.has(component)) return "acl";
		}
	}
	return null;
}

function directoryBytes(root: string): number {
	let total = 0;
	const pending = [root];
	while (pending.length) {
		const current = pending.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch (error) {
			if (!isNotFound(error)) throw error;
			continue;
		}
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			try {
				const stat = fs.lstatSync(fullPath);
				if (stat.isDirectory()) pending.push(fullPath);
				else total += stat.size;
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
		}
	}
	return total;
}

function readStatus(runDir: string): { status: Record<string, unknown> | null; reason?: string; errorCode?: string } {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf8"));
		if (!isRecord(parsed) || typeof parsed.state !== "string" || hasInvalidPid(parsed)) return { status: null, reason: "unreadable-status", errorCode: "malformed" };
		return { status: parsed };
	} catch (error) {
		const errorCode = isRecord(error) && typeof error.code === "string" ? error.code : error instanceof SyntaxError ? "malformed" : "unknown";
		if (errorCode === "ENOENT") return { status: null, reason: "missing-status", errorCode };
		if (isAccessDenied(error)) return { status: null, reason: "unreadable-status-foreign", errorCode };
		return { status: null, reason: "unreadable-status", errorCode };
	}
}

function nestedRouteIndex(nestedEventsDir: string): Map<string, string[]> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(nestedEventsDir, { withFileTypes: true });
	} catch (error) {
		if (isNotFound(error)) return new Map();
		throw error;
	}
	const routesByRoot = new Map<string, string[]>();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const routeRoot = path.join(nestedEventsDir, entry.name);
		try {
			const metadata: unknown = JSON.parse(fs.readFileSync(path.join(routeRoot, "route.json"), "utf8"));
			if (!isRecord(metadata) || typeof metadata.rootRunId !== "string") continue;
			const routes = routesByRoot.get(metadata.rootRunId) ?? [];
			routes.push(routeRoot);
			routesByRoot.set(metadata.rootRunId, routes);
		} catch {
			// Unknown route metadata is not attributable and is left untouched.
		}
	}
	return routesByRoot;
}

function nestedRoutePaths(routeIndex: Map<string, string[]>, rootRunId: string): string[] {
	return routeIndex.get(rootRunId) ?? [];
}

function associatedPaths(id: string, asyncDir: string, resultsDir: string, routeIndex: Map<string, string[]>): string[] {
	const runDir = path.join(asyncDir, id);
	const paths = [runDir];
	const directResult = path.join(resultsDir, `${id}.json`);
	if (fs.existsSync(directResult)) paths.push(directResult);
	const nestedResults = path.join(resultsDir, "nested", id);
	if (fs.existsSync(nestedResults)) paths.push(nestedResults);
	paths.push(...nestedRoutePaths(routeIndex, id));
	return paths;
}

function existingBytes(paths: string[]): number {
	let total = 0;
	for (const item of paths) {
		try {
			const stat = fs.lstatSync(item);
			total += stat.isDirectory() ? directoryBytes(item) : stat.size;
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}
	return total;
}

function listCandidates(asyncDir: string, resultsDir: string, routeIndex: Map<string, string[]>): RunCandidate[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(asyncDir, { withFileTypes: true });
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	return entries.filter((entry) => entry.isDirectory()).map((entry) => {
		const id = entry.name;
		const runDir = path.join(asyncDir, id);
		const { status, reason: statusIssue, errorCode: statusErrorCode } = readStatus(runDir);
		let statusMtime = 0;
		try {
			statusMtime = fs.statSync(path.join(runDir, "status.json")).mtimeMs;
		} catch {
			// Missing/unreadable status is retained below; timestamp is not used to prune it.
		}
		const updatedAt = typeof status?.endedAt === "number" && Number.isFinite(status.endedAt)
			? status.endedAt
			: typeof status?.lastUpdate === "number" && Number.isFinite(status.lastUpdate)
				? status.lastUpdate
				: statusMtime;
		const paths = associatedPaths(id, asyncDir, resultsDir, routeIndex);
		return {
			id,
			
			status,
			statusIssue,
			statusErrorCode,
			state: typeof status?.state === "string" ? status.state : null,
			pidSet: status ? collectPids(status) : [],
			paths,
			bytes: existingBytes(paths),
			updatedAt,
		};
	});
}

export function pruneAsyncRunDirs(options: AsyncRunGcOptions = {}): AsyncRunGcSummary {
	const asyncDir = path.resolve(options.asyncDir ?? ASYNC_DIR);
	const resultsDir = path.resolve(options.resultsDir ?? RESULTS_DIR);
	const nestedEventsDir = path.resolve(options.nestedEventsDir ?? path.join(TEMP_ROOT_DIR, "nested-subagent-events"));
	const budgetBytes = options.budgetBytes ?? ASYNC_RUN_GC_BUDGET_BYTES;
	const keepRecentTerminal = options.keepRecentTerminal ?? ASYNC_RUN_GC_KEEP_RECENT_TERMINAL;
	const minAgeMs = options.minAgeMs ?? ASYNC_RUN_GC_MIN_AGE_MS;
	const now = options.now ?? Date.now();
	const startedAt = Date.now();
	const procRoot = options.procRoot ?? "/proc";
	const isAlive = options.isPidAlive ?? isProcessAlive;
	const scan = options.scanOpenFds ?? scanProcOpenFds;
	const routeIndex = nestedRouteIndex(nestedEventsDir);
	const candidates = listCandidates(asyncDir, resultsDir, routeIndex);
	const totalPaths = [...new Set(candidates.flatMap((candidate) => candidate.paths))];
	const fdScan: FdScanResult = totalPaths.length
		? scan(totalPaths, procRoot)
		: { complete: true, unreadable: 0, foreignUid: 0, scannedReadableForeign: 0, foreignUnreadable: 0, sameUidUnreadable: 0, uidUnverifiable: 0, scanTruncated: false, unreadableForeignUids: [], openPaths: [] };
	if (fdScan.foreignUnreadable > 0 && fdScan.unreadableForeignUids.length > 0) {
		const ourUid = typeof process.getuid === "function" ? process.getuid() : null;
		for (const candidate of candidates) {
			candidate.foreignReachability = ourUid === null
				? { foreignReachable: true, reason: "stat-error" }
				: assessForeignReachability(candidate.paths, ourUid);
		}
		const aclCandidates = candidates.filter((candidate) => candidate.foreignReachability?.reason === "reachable");
		if (aclCandidates.length > 0) {
			const aclPaths = [...new Set(aclCandidates.flatMap((candidate) => candidate.paths))];
			const aclScan = scanPosixAcls(aclPaths);
			for (const candidate of aclCandidates) {
				const reason = aclReachability(candidate.paths, aclScan);
				if (reason) candidate.foreignReachability = { foreignReachable: true, reason };
			}
		}
	}
	const summary: AsyncRunGcSummary = {
		examined: candidates.length,
		candidatesSeen: candidates.length,
		considered: candidates.length,
		deferredByBudget: 0,
		elapsedMs: 0,
		pruned: 0,
		wouldPrune: 0,
		kept: {},
		bytesReclaimed: 0,
		bytesWouldReclaim: 0,
		bytesBefore: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
		bytesAfter: 0,
		fdScan: {
			complete: fdScan.complete,
			unreadable: fdScan.unreadable,
			foreignUid: fdScan.foreignUid,
			sameUidUnreadable: fdScan.sameUidUnreadable,
			uidUnverifiable: fdScan.uidUnverifiable,
			foreignUnreadable: fdScan.foreignUnreadable,
			scanTruncated: fdScan.scanTruncated,
		},
		scannedReadableForeign: fdScan.scannedReadableForeign,
		skippedUnreadableForeignProvenUnreachable: 0,
		keptUnreadableForeignReachable: 0,
		keptUnknownUid: 0,
		keptAcl: 0,
		keptForeignOwner: 0,
		keptStatError: 0,
		keptSameUidUnreadable: 0,
		keptWorldAccessible: 0,
		keptUidUnverifiable: 0,
		keptOwnerAlive: 0,
		keptMissingStatus: 0,
		keptUnreadableStatusForeign: 0,
		statusErrors: {},
		outcomes: {},
	};
	const keep = (reason: string): void => {
		summary.kept[reason] = (summary.kept[reason] ?? 0) + 1;
		summary.outcomes[`kept:${reason}`] = (summary.outcomes[`kept:${reason}`] ?? 0) + 1;
	};
	const terminal = candidates.filter((candidate) => candidate.state !== null && TERMINAL_STATES.has(candidate.state));
	const protectedRecent = new Set(terminal.slice().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, keepRecentTerminal).map((candidate) => candidate.id));
	const eligible: RunCandidate[] = [];
	for (const candidate of candidates) {
		if (!candidate.status || !candidate.state) {
			const reason = candidate.statusIssue ?? "unreadable-status";
			if (reason === "missing-status") summary.keptMissingStatus++;
			if (reason === "unreadable-status-foreign") summary.keptUnreadableStatusForeign++;
			if (candidate.statusErrorCode) summary.statusErrors[candidate.statusErrorCode] = (summary.statusErrors[candidate.statusErrorCode] ?? 0) + 1;
			keep(reason);
			continue;
		}
		if (!TERMINAL_STATES.has(candidate.state)) { keep(candidate.state === "paused" ? "paused" : "nonterminal"); continue; }
		if (protectedRecent.has(candidate.id)) { keep("retention-floor"); continue; }
		if (now - candidate.updatedAt < minAgeMs) { keep("younger-than-min-age"); continue; }
		if (candidate.pidSet.some(isAlive)) { summary.keptOwnerAlive++; keep("live-pid"); continue; }
		if (fdScan.uidUnverifiable > 0) {
			summary.keptUidUnverifiable++;
			summary.keptUnknownUid++;
			keep("uid-unverifiable");
			continue;
		}
		if (fdScan.sameUidUnreadable > 0) {
			summary.keptSameUidUnreadable++;
			keep("same-uid-unreadable-fd");
			continue;
		}
		if (fdScan.scanTruncated || (!fdScan.complete && fdScan.foreignUnreadable === 0)) { keep("incomplete-fd-scan"); continue; }
		if (candidate.paths.some((item) => fdScan.openPaths.some((openPath) => containedPath(item, openPath) || containedPath(openPath, item)))) { keep("open-fd"); continue; }
		if (fdScan.foreignUnreadable > 0) {
			const reachability = candidate.foreignReachability ?? { foreignReachable: true, reason: "stat-error" as const };
			if (reachability.foreignReachable) {
				summary.keptUnreadableForeignReachable++;
				summary.keptWorldAccessible++;
				if (reachability.reason === "acl") summary.keptAcl++;
				if (reachability.reason === "foreign-owner") summary.keptForeignOwner++;
				if (reachability.reason === "stat-error") summary.keptStatError++;
				keep(`unreadable-foreign-${reachability.reason}`);
				continue;
			}
			summary.skippedUnreadableForeignProvenUnreachable++;
		}
		eligible.push(candidate);
	}
	eligible.sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
	let bytesAfter = summary.bytesBefore;
	for (const candidate of eligible) {
		if (bytesAfter <= budgetBytes) { keep("within-budget"); continue; }
		if (options.dryRun) {
			summary.wouldPrune++;
			summary.outcomes["would-prune"] = (summary.outcomes["would-prune"] ?? 0) + 1;
			summary.bytesWouldReclaim += candidate.bytes;
			bytesAfter = Math.max(0, bytesAfter - candidate.bytes);
			continue;
		}
		try {
			for (const item of candidate.paths) fs.rmSync(item, { recursive: true, force: true });
			summary.pruned++;
			summary.outcomes["pruned"] = (summary.outcomes["pruned"] ?? 0) + 1;
			summary.bytesReclaimed += candidate.bytes;
			bytesAfter = Math.max(0, bytesAfter - candidate.bytes);
		} catch {
			const remaining = existingBytes(candidate.paths);
			const reclaimed = Math.max(0, candidate.bytes - remaining);
			bytesAfter = Math.max(0, bytesAfter - reclaimed);
			summary.bytesReclaimed += reclaimed;
			keep("delete-error");
		}
	}
	summary.bytesAfter = options.dryRun ? summary.bytesBefore : bytesAfter;
	summary.elapsedMs = Date.now() - startedAt;
	const outcomeCount = Object.values(summary.outcomes).reduce((sum, count) => sum + count, 0);
	if (outcomeCount !== summary.examined) throw new Error(`async-run GC candidate outcome mismatch: ${outcomeCount} outcomes for ${summary.examined} candidates`);
	const blockedUnreadable = summary.keptSameUidUnreadable + summary.keptUidUnverifiable + (summary.kept["incomplete-fd-scan"] ?? 0);
	const line = `[subagent async-run GC] sweep examined=${summary.examined} collectable=${eligible.length} dryRun=${options.dryRun === true} wouldDelete=${summary.wouldPrune} wouldBytes=${summary.bytesWouldReclaim} deleted=${summary.pruned} bytes=${summary.bytesReclaimed} blockedUnreadable=${blockedUnreadable} blockedWorldAccessible=${summary.keptWorldAccessible} scanned_readable_foreign=${summary.scannedReadableForeign} foreign_unreadable_fd_tables=${summary.fdScan.foreignUnreadable} skipped_unreadable_foreign_proven_unreachable=${summary.skippedUnreadableForeignProvenUnreachable} kept_unreadable_foreign_reachable=${summary.keptUnreadableForeignReachable} kept_unknown_uid=${summary.keptUnknownUid} kept_acl=${summary.keptAcl} kept_foreign_owner=${summary.keptForeignOwner} kept_stat_error=${summary.keptStatError} kept_missing_status=${summary.keptMissingStatus} kept_unreadable_status_foreign=${summary.keptUnreadableStatusForeign} status_errors=${JSON.stringify(summary.statusErrors)} keptOwnerAlive=${summary.keptOwnerAlive} outcomes=${JSON.stringify(summary.outcomes)} kept=${JSON.stringify(summary.kept)} bytesBefore=${summary.bytesBefore} bytesAfter=${summary.bytesAfter} fdScanComplete=${summary.fdScan.complete} unreadableFds=${summary.fdScan.unreadable}`;
	options.log?.(line);
	return summary;
}

let cleanupInFlight = false;
export async function runAsyncRunGc(options: AsyncRunGcOptions = {}): Promise<AsyncRunGcSummary | null> {
	if (process.env.PI_SUBAGENTS_GC?.toLowerCase() === "off") {
		options.log?.("[subagent async-run GC] disabled=env");
		return null;
	}
	if (cleanupInFlight) return null;
	cleanupInFlight = true;
	try {
		// Let startup timers, I/O, and signal callbacks run before filesystem work begins.
		await new Promise<void>((resolve) => setImmediate(resolve));
		return pruneAsyncRunDirs(options);
	} finally {
		cleanupInFlight = false;
	}
}
