import fs from "node:fs";
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
	openPaths: string[];
}

export interface AsyncRunGcSummary {
	examined: number;
	candidatesSeen: number;
	considered: number;
	deferredByBudget: number;
	elapsedMs: number;
	pruned: number;
	kept: Record<string, number>;
	bytesReclaimed: number;
	bytesBefore: number;
	bytesAfter: number;
	fdScan: { complete: boolean; unreadable: number };
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
	isPidAlive?: (pid: number) => boolean;
	scanOpenFds?: (paths: string[], procRoot: string) => FdScanResult;
	log?: (line: string) => void;
}

interface RunCandidate {
	id: string;
	status: Record<string, unknown> | null;
	statusIssue?: string;
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

/** Scan /proc once for every candidate tree. Any unreadable or bounded-out entry makes the result incomplete. */
export function scanProcOpenFds(paths: string[], procRoot = "/proc"): FdScanResult {
	let complete = true;
	let unreadable = 0;
	let procEntries: fs.Dirent[];
	try {
		procEntries = fs.readdirSync(procRoot, { withFileTypes: true });
	} catch {
		return { complete: false, unreadable: 1, openPaths: [] };
	}
	const processEntries = procEntries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));
	if (processEntries.length > MAX_PROC_ENTRIES) complete = false;
	const openPaths = new Set<string>();
	let scannedFds = 0;
	for (const procEntry of processEntries.slice(0, MAX_PROC_ENTRIES)) {
		const fdRoot = path.join(procRoot, procEntry.name, "fd");
		let descriptors: string[];
		try {
			descriptors = fs.readdirSync(fdRoot);
		} catch (error) {
			if (isNotFound(error)) continue; // process exited between enumeration and fd scan
			unreadable++;
			complete = false;
			continue;
		}
		for (const descriptor of descriptors) {
			if (++scannedFds > MAX_FD_ENTRIES) {
				complete = false;
				return { complete, unreadable, openPaths: [...openPaths] };
			}
			const descriptorPath = path.join(fdRoot, descriptor);
			let target: string;
			try {
				target = fs.readlinkSync(descriptorPath);
			} catch (error) {
				if (isNotFound(error)) continue; // fd closed during scan
				unreadable++;
				complete = false;
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
	return { complete, unreadable, openPaths: [...openPaths] };
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

function readStatus(runDir: string): { status: Record<string, unknown> | null; reason?: string } {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf8"));
		if (!isRecord(parsed) || typeof parsed.state !== "string" || hasInvalidPid(parsed)) return { status: null, reason: "unreadable-status" };
		return { status: parsed };
	} catch (error) {
		return { status: null, reason: isNotFound(error) ? "missing-status" : "unreadable-status" };
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
		const { status, reason: statusIssue } = readStatus(runDir);
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
	const fdScan = totalPaths.length
		? scan(totalPaths, procRoot)
		: { complete: true, unreadable: 0, openPaths: [] };
	const summary: AsyncRunGcSummary = {
		examined: candidates.length,
		candidatesSeen: candidates.length,
		considered: candidates.length,
		deferredByBudget: 0,
		elapsedMs: 0,
		pruned: 0,
		kept: {},
		bytesReclaimed: 0,
		bytesBefore: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
		bytesAfter: 0,
		fdScan: { complete: fdScan.complete, unreadable: fdScan.unreadable },
	};
	const keep = (reason: string): void => { summary.kept[reason] = (summary.kept[reason] ?? 0) + 1; };
	const terminal = candidates.filter((candidate) => candidate.state !== null && TERMINAL_STATES.has(candidate.state));
	const protectedRecent = new Set(terminal.slice().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, keepRecentTerminal).map((candidate) => candidate.id));
	const eligible: RunCandidate[] = [];
	for (const candidate of candidates) {
		if (!candidate.status || !candidate.state) { keep(candidate.statusIssue ?? "unreadable-status"); continue; }
		if (!TERMINAL_STATES.has(candidate.state)) { keep(candidate.state === "paused" ? "paused" : "nonterminal"); continue; }
		if (protectedRecent.has(candidate.id)) { keep("retention-floor"); continue; }
		if (now - candidate.updatedAt < minAgeMs) { keep("younger-than-min-age"); continue; }
		if (candidate.pidSet.some(isAlive)) { keep("live-pid"); continue; }
		if (!fdScan.complete) { keep("incomplete-fd-scan"); continue; }
		if (candidate.paths.some((item) => fdScan.openPaths.some((openPath) => containedPath(item, openPath) || containedPath(openPath, item)))) { keep("open-fd"); continue; }
		eligible.push(candidate);
	}
	eligible.sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
	let bytesAfter = summary.bytesBefore;
	for (const candidate of eligible) {
		if (bytesAfter <= budgetBytes) { keep("within-budget"); continue; }
		try {
			for (const item of candidate.paths) fs.rmSync(item, { recursive: true, force: true });
			summary.pruned++;
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
	summary.bytesAfter = bytesAfter;
	summary.elapsedMs = Date.now() - startedAt;
	const line = `[subagent async-run GC] candidatesSeen=${summary.candidatesSeen} considered=${summary.considered} pruned=${summary.pruned} deferredByBudget=${summary.deferredByBudget} bytesReclaimed=${summary.bytesReclaimed} elapsedMs=${summary.elapsedMs} examined=${summary.examined} kept=${JSON.stringify(summary.kept)} bytesBefore=${summary.bytesBefore} bytesAfter=${summary.bytesAfter} fdScanComplete=${summary.fdScan.complete} unreadableFds=${summary.fdScan.unreadable}`;
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
