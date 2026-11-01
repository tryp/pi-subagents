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
	yieldedChunks: number;
	longestSynchronousBlockMs: number;
	elapsedMs: number;
	pruned: number;
	kept: Record<string, number>;
	bytesReclaimed: number;
	dryRunWouldPrune: number;
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
	dryRun?: boolean;
	onPhase?: (name: string, elapsedMs: number) => void;
	maxChunkMs?: number;
	yieldEveryItems?: number;
	reader?: AsyncRunGcReader;
	cursor?: AsyncRunGcCursor;
	onYield?: (cursor: AsyncRunGcCursor) => void;
}

export interface AsyncRunGcCursor {
	phase: "nested-routes" | "candidates" | "fd-scan" | "classify" | "delete" | "done";
	routeOffset: number;
	candidateOffset: number;
	fdProcessOffset: number;
	fdEntryOffset: number;
	deleteOffset: number;
	yieldedChunks: number;
}

export type AsyncRunGcReader = Pick<typeof fs, "readdirSync" | "readFileSync" | "statSync" | "lstatSync" | "existsSync" | "readlinkSync">;

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

function existingBytes(paths: string[], onElapsed?: (elapsedMs: number) => void): number {
	const startedAt = Date.now();
	let total = 0;
	for (const item of paths) {
		try {
			const stat = fs.lstatSync(item);
			total += stat.isDirectory() ? directoryBytes(item) : stat.size;
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}
	onElapsed?.(Date.now() - startedAt);
	return total;
}

function listCandidates(asyncDir: string, resultsDir: string, routeIndex: Map<string, string[]>, onPhase?: (name: string, elapsedMs: number) => void): RunCandidate[] {
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
		const statusStarted = Date.now();
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
		onPhase?.("perRunStatusReads", Date.now() - statusStarted);
		const paths = associatedPaths(id, asyncDir, resultsDir, routeIndex);
		const bytes = existingBytes(paths, (elapsedMs) => onPhase?.("directoryBytes", elapsedMs));
		return {
			id,
			status,
			statusIssue,
			state: typeof status?.state === "string" ? status.state : null,
			pidSet: status ? collectPids(status) : [],
			paths,
			bytes,
			updatedAt,
		};
	});
}

export function createAsyncRunGcCursor(): AsyncRunGcCursor {
	return { phase: "nested-routes", routeOffset: 0, candidateOffset: 0, fdProcessOffset: 0, fdEntryOffset: 0, deleteOffset: 0, yieldedChunks: 0 };
}

type Checkpoint = (force?: boolean) => Promise<void>;

async function nestedRouteIndexAsync(
	dir: string,
	reader: AsyncRunGcReader,
	cursor: AsyncRunGcCursor,
	checkpoint: Checkpoint,
): Promise<Map<string, string[]>> {
	let entries: fs.Dirent[];
	try { entries = reader.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[]; }
	catch (error) { if (isNotFound(error)) return new Map(); throw error; }
	const routesByRoot = new Map<string, string[]>();
	for (let i = cursor.routeOffset; i < entries.length; i++) {
		const entry = entries[i];
		cursor.routeOffset = i + 1;
		if (entry.isDirectory()) {
			const routeRoot = path.join(dir, entry.name);
			try {
				const metadata: unknown = JSON.parse(reader.readFileSync(path.join(routeRoot, "route.json"), "utf8") as string);
				if (isRecord(metadata) && typeof metadata.rootRunId === "string") {
					const routes = routesByRoot.get(metadata.rootRunId) ?? [];
					routes.push(routeRoot);
					routesByRoot.set(metadata.rootRunId, routes);
				}
			} catch { /* Unknown route metadata is retained. */ }
		}
		await checkpoint();
	}
	return routesByRoot;
}

async function directoryBytesAsync(root: string, reader: AsyncRunGcReader, checkpoint: Checkpoint): Promise<number> {
	let total = 0;
	const pending = [root];
	while (pending.length) {
		const current = pending.pop()!;
		let entries: fs.Dirent[];
		try { entries = reader.readdirSync(current, { withFileTypes: true }) as fs.Dirent[]; }
		catch (error) { if (!isNotFound(error)) throw error; await checkpoint(); continue; }
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			try {
				const stat = reader.lstatSync(fullPath);
				if (stat.isDirectory()) pending.push(fullPath);
				else total += stat.size;
			} catch (error) { if (!isNotFound(error)) throw error; }
			await checkpoint();
		}
	}
	return total;
}

async function existingBytesAsync(paths: string[], reader: AsyncRunGcReader, checkpoint: Checkpoint): Promise<number> {
	let total = 0;
	for (const item of paths) {
		try {
			const stat = reader.lstatSync(item);
			total += stat.isDirectory() ? await directoryBytesAsync(item, reader, checkpoint) : stat.size;
		} catch (error) { if (!isNotFound(error)) throw error; }
		await checkpoint();
	}
	return total;
}

async function listCandidatesAsync(
	asyncDir: string,
	resultsDir: string,
	routeIndex: Map<string, string[]>,
	reader: AsyncRunGcReader,
	cursor: AsyncRunGcCursor,
	checkpoint: Checkpoint,
	onPhase?: (name: string, elapsedMs: number) => void,
): Promise<RunCandidate[]> {
	let entries: fs.Dirent[];
	try { entries = reader.readdirSync(asyncDir, { withFileTypes: true }) as fs.Dirent[]; }
	catch (error) { if (isNotFound(error)) return []; throw error; }
	const candidates: RunCandidate[] = [];
	for (let i = cursor.candidateOffset; i < entries.length; i++) {
		const entry = entries[i];
		cursor.candidateOffset = i + 1;
		if (!entry.isDirectory()) { await checkpoint(); continue; }
		const id = entry.name;
		const runDir = path.join(asyncDir, id);
		const statusStarted = Date.now();
		let status: Record<string, unknown> | null = null;
		let statusIssue: string | undefined;
		try {
			const parsed: unknown = JSON.parse(reader.readFileSync(path.join(runDir, "status.json"), "utf8") as string);
			if (!isRecord(parsed) || typeof parsed.state !== "string" || hasInvalidPid(parsed)) statusIssue = "unreadable-status";
			else status = parsed;
		} catch (error) { statusIssue = isNotFound(error) ? "missing-status" : "unreadable-status"; }
		let statusMtime = 0;
		try { statusMtime = reader.statSync(path.join(runDir, "status.json")).mtimeMs; } catch { /* Retain unknown status. */ }
		onPhase?.("perRunStatusReads", Date.now() - statusStarted);
		const updatedAt = typeof status?.endedAt === "number" && Number.isFinite(status.endedAt)
			? status.endedAt
			: typeof status?.lastUpdate === "number" && Number.isFinite(status.lastUpdate) ? status.lastUpdate : statusMtime;
		const paths = [runDir];
		const directResult = path.join(resultsDir, `${id}.json`);
		if (reader.existsSync(directResult)) paths.push(directResult);
		const nestedResults = path.join(resultsDir, "nested", id);
		if (reader.existsSync(nestedResults)) paths.push(nestedResults);
		paths.push(...nestedRoutePaths(routeIndex, id));
		const bytesStarted = Date.now();
		const bytes = await existingBytesAsync(paths, reader, checkpoint);
		onPhase?.("directoryBytes", Date.now() - bytesStarted);
		candidates.push({ id, status, statusIssue, state: typeof status?.state === "string" ? status.state : null, pidSet: status ? collectPids(status) : [], paths, bytes, updatedAt });
		await checkpoint();
	}
	return candidates;
}

async function scanProcOpenFdsAsync(
	paths: string[],
	procRoot: string,
	reader: AsyncRunGcReader,
	cursor: AsyncRunGcCursor,
	checkpoint: Checkpoint,
): Promise<FdScanResult> {
	let complete = true;
	let unreadable = 0;
	let procEntries: fs.Dirent[];
	try { procEntries = reader.readdirSync(procRoot, { withFileTypes: true }) as fs.Dirent[]; }
	catch { return { complete: false, unreadable: 1, openPaths: [] }; }
	const processEntries = procEntries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).slice(0, MAX_PROC_ENTRIES);
	if (processEntries.length >= MAX_PROC_ENTRIES) complete = false;
	const roots = new Set(paths.map((candidate) => path.resolve(candidate)));
	const openPaths = new Set<string>();
	let scannedFds = 0;
	for (let pi = cursor.fdProcessOffset; pi < processEntries.length; pi++) {
		const procEntry = processEntries[pi];
		cursor.fdProcessOffset = pi;
		const fdRoot = path.join(procRoot, procEntry.name, "fd");
		let descriptors: string[];
		try { descriptors = reader.readdirSync(fdRoot) as string[]; }
		catch (error) { if (isNotFound(error)) { cursor.fdProcessOffset = pi + 1; await checkpoint(); continue; } unreadable++; complete = false; cursor.fdProcessOffset = pi + 1; await checkpoint(); continue; }
		for (let fi = cursor.fdEntryOffset; fi < descriptors.length; fi++) {
			cursor.fdEntryOffset = fi;
			if (++scannedFds > MAX_FD_ENTRIES) return { complete: false, unreadable, openPaths: [...openPaths] };
			const descriptorPath = path.join(fdRoot, descriptors[fi]);
			try {
				const target = path.resolve((reader.readlinkSync(descriptorPath) as string).replace(/ \(deleted\)$/, ""));
				let parent = target;
				while (true) {
					if (roots.has(parent)) { openPaths.add(parent); break; }
					const next = path.dirname(parent);
					if (next === parent) break;
					parent = next;
				}
			} catch (error) { if (!isNotFound(error)) { unreadable++; complete = false; } }
			await checkpoint();
		}
		cursor.fdEntryOffset = 0;
		cursor.fdProcessOffset = pi + 1;
		await checkpoint();
	}
	return { complete, unreadable, openPaths: [...openPaths] };
}

export async function pruneAsyncRunDirs(options: AsyncRunGcOptions = {}): Promise<AsyncRunGcSummary> {
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
	const reader = options.reader ?? fs;
	const cursor = options.cursor ?? createAsyncRunGcCursor();
	const scan = options.scanOpenFds ?? scanProcOpenFds;
	const summary: AsyncRunGcSummary = {
		examined: 0, candidatesSeen: 0, considered: 0, deferredByBudget: 0, yieldedChunks: 0,
		longestSynchronousBlockMs: 0, elapsedMs: 0, pruned: 0, kept: {}, bytesReclaimed: 0, dryRunWouldPrune: 0,
		bytesBefore: 0, bytesAfter: 0, fdScan: { complete: true, unreadable: 0 },
	};
	const yieldEveryItems = Math.max(1, options.yieldEveryItems ?? 128);
	const maxChunkMs = Math.max(1, options.maxChunkMs ?? 12);
	let chunkItems = 0;
	let chunkStarted = Date.now();
	const checkpoint: Checkpoint = async () => {
		chunkItems++;
		if (chunkItems < yieldEveryItems && Date.now() - chunkStarted < maxChunkMs) return;
		const chunkElapsedMs = Date.now() - chunkStarted;
		summary.longestSynchronousBlockMs = Math.max(summary.longestSynchronousBlockMs, chunkElapsedMs);
		cursor.yieldedChunks++;
		summary.yieldedChunks++;
		summary.deferredByBudget++;
		chunkItems = 0;
		chunkStarted = Date.now();
		options.onYield?.(cursor);
		await new Promise<void>((resolve) => setImmediate(resolve));
	};
	const keep = (reason: string): void => { summary.kept[reason] = (summary.kept[reason] ?? 0) + 1; };

	const routeStarted = Date.now();
	cursor.phase = "nested-routes";
	const routeIndex = await nestedRouteIndexAsync(nestedEventsDir, reader, cursor, checkpoint);
	options.onPhase?.("nestedRouteIndex", Date.now() - routeStarted);
	const candidateStarted = Date.now();
	cursor.phase = "candidates";
	const candidates = await listCandidatesAsync(asyncDir, resultsDir, routeIndex, reader, cursor, checkpoint, options.onPhase);
	options.onPhase?.("candidateListing", Date.now() - candidateStarted);
	summary.examined = candidates.length;
	summary.candidatesSeen = candidates.length;
	summary.considered = candidates.length;
	summary.bytesBefore = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
	const totalPaths = [...new Set(candidates.flatMap((candidate) => candidate.paths))];
	const fdStarted = Date.now();
	cursor.phase = "fd-scan";
	const fdScan = totalPaths.length
		? options.scanOpenFds
			? scan(totalPaths, procRoot)
			: await scanProcOpenFdsAsync(totalPaths, procRoot, reader, cursor, checkpoint)
		: { complete: true, unreadable: 0, openPaths: [] };
	summary.fdScan = { complete: fdScan.complete, unreadable: fdScan.unreadable };
	options.onPhase?.("livenessFdScan", Date.now() - fdStarted);
	const terminal = candidates.filter((candidate) => candidate.state !== null && TERMINAL_STATES.has(candidate.state));
	const protectedRecent = new Set(terminal.slice().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, keepRecentTerminal).map((candidate) => candidate.id));
	const eligible: RunCandidate[] = [];
	cursor.phase = "classify";
	for (const candidate of candidates) {
		if (!candidate.status || !candidate.state) keep(candidate.statusIssue ?? "unreadable-status");
		else if (!TERMINAL_STATES.has(candidate.state)) keep(candidate.state === "paused" ? "paused" : "nonterminal");
		else if (protectedRecent.has(candidate.id)) keep("retention-floor");
		else if (now - candidate.updatedAt < minAgeMs) keep("younger-than-min-age");
		else if (candidate.pidSet.some(isAlive)) keep("live-pid");
		else if (!fdScan.complete) keep("incomplete-fd-scan");
		else if (candidate.paths.some((item) => fdScan.openPaths.some((openPath) => containedPath(item, openPath) || containedPath(openPath, item)))) keep("open-fd");
		else eligible.push(candidate);
		await checkpoint();
	}
	eligible.sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
	let bytesAfter = summary.bytesBefore;
	cursor.phase = "delete";
	for (let i = cursor.deleteOffset; i < eligible.length; i++) {
		const candidate = eligible[i];
		cursor.deleteOffset = i + 1;
		if (bytesAfter <= budgetBytes) keep("within-budget");
		else if (options.dryRun || process.env.PI_SUBAGENTS_GC_DRY_RUN === "1") {
			summary.dryRunWouldPrune++;
			summary.bytesReclaimed += candidate.bytes;
			bytesAfter = Math.max(0, bytesAfter - candidate.bytes);
		} else {
			const deleteStarted = Date.now();
			try {
				for (const item of candidate.paths) await fs.promises.rm(item, { recursive: true, force: true });
				summary.pruned++;
				summary.bytesReclaimed += candidate.bytes;
				bytesAfter = Math.max(0, bytesAfter - candidate.bytes);
			} catch {
				const remaining = await existingBytesAsync(candidate.paths, reader, checkpoint);
				const reclaimed = Math.max(0, candidate.bytes - remaining);
				bytesAfter = Math.max(0, bytesAfter - reclaimed);
				summary.bytesReclaimed += reclaimed;
				keep("delete-error");
			} finally { options.onPhase?.("deletion", Date.now() - deleteStarted); }
		}
		await checkpoint();
	}
	summary.bytesAfter = bytesAfter;
	summary.longestSynchronousBlockMs = Math.max(summary.longestSynchronousBlockMs, Date.now() - chunkStarted);
	cursor.phase = "done";
	summary.elapsedMs = Date.now() - startedAt;
	options.onPhase?.("longestSynchronousBlockMs", summary.longestSynchronousBlockMs);
	const line = `[subagent async-run GC] candidatesSeen=${summary.candidatesSeen} considered=${summary.considered} pruned=${summary.pruned} dryRunWouldPrune=${summary.dryRunWouldPrune} deferredByBudget=${summary.deferredByBudget} yieldedChunks=${summary.yieldedChunks} bytesReclaimed=${summary.bytesReclaimed} elapsedMs=${summary.elapsedMs} examined=${summary.examined} kept=${JSON.stringify(summary.kept)} bytesBefore=${summary.bytesBefore} bytesAfter=${summary.bytesAfter} fdScanComplete=${summary.fdScan.complete} unreadableFds=${summary.fdScan.unreadable}`;
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
		return await pruneAsyncRunDirs(options);
	} finally {
		cleanupInFlight = false;
	}
}
