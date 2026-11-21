import fs from "node:fs";
import path from "node:path";
import { isReadOnlyToolSet } from "./writer-capability.ts";

export type CwdClaimKind = "parent" | "foreground" | "async";
export interface CwdClaim {
	runId: string;
	childIndex: number;
	cwd: string;
	claimedAt: number;
	writeCapable: boolean;
	kind: Exclude<CwdClaimKind, "parent">;
	agentName?: string;
	claimsFile?: string;
}

export interface CwdClaimRequest {
	runId: string;
	childIndex: number;
	cwd: string;
	/** Derived only from the tool allowlist actually enforced at launch. */
	tools?: readonly string[];
	kind?: Exclude<CwdClaimKind, "parent">;
	agentName?: string;
	/** Informational only: acceptance roles do not alter tool access or write capability. */
	acceptanceRole?: "read-only" | "writer";
	claimsFile?: string;
}

export interface CwdWriterConflictHolder {
	runId: string;
	kind: CwdClaimKind;
	agentName?: string;
	writeCapable: boolean;
	startedAt: number | null;
	cwd: string;
}

export interface CwdWriterConflict {
	code: "cwd_writer_conflict";
	requestedRunId: string;
	childIndex: number;
	requestedCwd: string;
	holders: CwdWriterConflictHolder[];
	remedies: ["use_worktree_or_different_cwd", "wait_for_holder", "dispatch_read_only", "override_writer_guard"];
}

export interface CwdClaimResult {
	claims: CwdClaim[];
	warnings: string[];
	error?: string;
	conflict?: CwdWriterConflict;
}

/** Kill/stop requests do not write a `killed` state: async reconciliation records them as `stopped`. */
export function releaseTerminalCwdClaims(
	registry: CwdClaimRegistry | undefined,
	runId: string,
	status: string,
): CwdClaim[] {
	if (!registry || !["complete", "completed", "failed", "stopped"].includes(status)) return [];
	return registry.releaseRun(runId, status);
}

/** Process-local index for live cwd writers; each transition is also append-only on disk. */
export class CwdClaimRegistry {
	private readonly claims = new Map<string, CwdClaim>();
	private staleClaimCount = 0;
	private persistenceFailureCount = 0;
	private guardTripCount = 0;
	private guardOverrideCount = 0;

	claim(input: {
		requests: CwdClaimRequest[];
		liveRunIds: ReadonlySet<string>;
		strict?: boolean;
		parentCwd?: string;
		parentRunId?: string;
		parentTools?: readonly string[];
		overrideWriterGuard?: boolean;
		now?: number;
	}): CwdClaimResult {
		this.pruneStale(input.liveRunIds);
		const requests = input.requests.map((request) => ({ ...request, cwd: path.resolve(request.cwd) }));
		const conflicts: Array<{ request: CwdClaimRequest; holder: CwdClaimWriter }> = [];
		for (let i = 0; i < requests.length; i++) {
			const request = requests[i]!;
			if (!isWriteCapable(request.tools)) continue;
			for (const held of this.claims.values()) {
				if (held.cwd === request.cwd && held.writeCapable) conflicts.push({ request, holder: held });
			}
			if (input.parentCwd && !isReadOnlyToolSet(input.parentTools) && path.resolve(input.parentCwd) === request.cwd && input.parentRunId !== request.runId) {
				conflicts.push({ request, holder: { runId: input.parentRunId ?? "parent session", childIndex: -1, cwd: request.cwd, claimedAt: null, writeCapable: true, kind: "parent" } });
			}
		}
		const now = input.now ?? Date.now();
		const created = requests.map((request) => ({
			...request,
			tools: undefined,
			claimedAt: now,
			writeCapable: isWriteCapable(request.tools),
			kind: request.kind ?? "async",
		}));
		const conflict = conflicts.length ? toStructuredConflict(conflicts) : undefined;
		if (conflict) {
			this.guardTripCount++;
			for (const file of new Set(requests.map((request) => request.claimsFile).filter((value): value is string => !!value))) this.append(file, { event: "cwd-writer-guard-trip", ts: now, conflict, count: this.guardTripCount });
			if (!input.overrideWriterGuard) {
				const first = conflict.holders[0]!;
				return {
					claims: [],
					warnings: [],
					conflict,
					error: `cwd_writer_conflict: run '${conflict.requestedRunId}' child ${conflict.childIndex} requested ${conflict.requestedCwd}; held by ${first.kind} run '${first.runId}'${first.agentName ? ` (${first.agentName})` : ""}. Use a worktree/different cwd, wait for the holder, or dispatch read-only.`,
				};
			}
			this.guardOverrideCount++;
			for (const file of new Set(requests.map((request) => request.claimsFile).filter((value): value is string => !!value))) this.append(file, { event: "cwd-writer-guard-override", ts: now, conflict, holderRunIds: conflict.holders.map((holder) => holder.runId), overrideReason: "explicit overrideWriterGuard dispatch parameter", count: this.guardOverrideCount });
		}
		for (const claim of created) {
			this.claims.set(`${claim.runId}:${claim.childIndex}`, claim);
			this.append(claim.claimsFile, { event: "claim", ...claim });
		}
		const warnings = conflict ? [`cwd_writer_conflict overridden for ${conflict.requestedCwd}; holders: ${conflict.holders.map((holder) => holder.runId).join(", ")}`] : [];
		return { claims: created, warnings, ...(conflict ? { conflict } : {}) };
	}

	releaseRun(runId: string, reason = "terminal"): CwdClaim[] {
		const released: CwdClaim[] = [];
		for (const [key, claim] of this.claims) {
			if (claim.runId !== runId) continue;
			this.claims.delete(key);
			released.push(claim);
			this.append(claim.claimsFile, { event: "release", runId, childIndex: claim.childIndex, cwd: claim.cwd, ts: Date.now(), reason });
		}
		return released;
	}

	list(liveRunIds: ReadonlySet<string>): CwdClaim[] {
		this.pruneStale(liveRunIds);
		return [...this.claims.values()].sort((a, b) => a.cwd.localeCompare(b.cwd) || a.runId.localeCompare(b.runId) || a.childIndex - b.childIndex);
	}

	get staleClaims(): number { return this.staleClaimCount; }
	get guardTrips(): number { return this.guardTripCount; }
	get guardOverrides(): number { return this.guardOverrideCount; }

	format(liveRunIds: ReadonlySet<string>): string {
		const claims = this.list(liveRunIds);
		if (!claims.length) return `Active cwd claims: none (stale claims pruned: ${this.staleClaimCount}; guard trips: ${this.guardTripCount}; overrides: ${this.guardOverrideCount}; persistence failures: ${this.persistenceFailureCount}).`;
		const byCwd = new Map<string, Set<string>>();
		for (const claim of claims) {
			const owners = byCwd.get(claim.cwd) ?? new Set<string>();
			owners.add(claim.runId);
			byCwd.set(claim.cwd, owners);
		}
		const lines = [`Active cwd claims (stale claims pruned: ${this.staleClaimCount}; guard trips: ${this.guardTripCount}; overrides: ${this.guardOverrideCount}; persistence failures: ${this.persistenceFailureCount}):`];
		for (const [cwd, runs] of byCwd) lines.push(`${runs.size} runs claiming ${cwd}`);
		for (const claim of claims) lines.push(`  run ${claim.runId} child ${claim.childIndex}: ${claim.cwd} (${claim.writeCapable ? "writer" : "read-only"})`);
		return lines.join("\n");
	}

	private pruneStale(liveRunIds: ReadonlySet<string>): void {
		for (const [key, claim] of this.claims) {
			if (liveRunIds.has(claim.runId)) continue;
			this.claims.delete(key);
			this.staleClaimCount++;
			this.append(claim.claimsFile, { event: "release", runId: claim.runId, childIndex: claim.childIndex, cwd: claim.cwd, ts: Date.now(), reason: "stale-run-not-live" });
		}
	}

	private append(file: string | undefined, record: Record<string, unknown>): void {
		if (!file) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
		} catch {
			this.persistenceFailureCount++;
		}
	}
}

interface CwdClaimWriter {
	runId: string;
	childIndex: number;
	cwd: string;
	claimedAt: number | null;
	writeCapable: boolean;
	kind: CwdClaimKind;
	agentName?: string;
}

function isWriteCapable(tools: readonly string[] | undefined): boolean {
	return !isReadOnlyToolSet(tools);
}

function toStructuredConflict(conflicts: Array<{ request: CwdClaimRequest; holder: CwdClaimWriter }>): CwdWriterConflict {
	const first = conflicts[0]!.request;
	const holders = [...new Map(conflicts.map(({ holder }) => [holder.runId, {
		runId: holder.runId,
		kind: holder.kind,
		...(holder.agentName ? { agentName: holder.agentName } : {}),
		writeCapable: holder.writeCapable,
		startedAt: holder.claimedAt,
		cwd: holder.cwd,
	}])).values()];
	return { code: "cwd_writer_conflict", requestedRunId: first.runId, childIndex: first.childIndex, requestedCwd: first.cwd, holders, remedies: ["use_worktree_or_different_cwd", "wait_for_holder", "dispatch_read_only", "override_writer_guard"] };
}
