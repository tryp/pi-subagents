import fs from "node:fs";
import path from "node:path";

export interface CwdClaim {
	runId: string;
	childIndex: number;
	cwd: string;
	claimedAt: number;
	claimsFile?: string;
}

export interface CwdClaimRequest {
	runId: string;
	childIndex: number;
	cwd: string;
	claimsFile?: string;
}

export interface CwdClaimResult {
	claims: CwdClaim[];
	warnings: string[];
	error?: string;
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

	claim(input: {
		requests: CwdClaimRequest[];
		liveRunIds: ReadonlySet<string>;
		strict?: boolean;
		parentCwd?: string;
		parentRunId?: string;
		now?: number;
	}): CwdClaimResult {
		this.pruneStale(input.liveRunIds);
		const requests = input.requests.map((request) => ({ ...request, cwd: path.resolve(request.cwd) }));
		const conflicts: Array<{ request: CwdClaimRequest; holder: CwdClaim | { runId: string; childIndex: number; cwd: string } }> = [];
		for (const request of requests) {
			for (const held of this.claims.values()) {
				if (held.runId !== request.runId && held.cwd === request.cwd) conflicts.push({ request, holder: held });
			}
			if (input.parentCwd && path.resolve(input.parentCwd) === request.cwd && input.parentRunId !== request.runId) {
				conflicts.push({ request, holder: { runId: input.parentRunId ?? "parent session", childIndex: -1, cwd: request.cwd } });
			}
		}
		if (conflicts.length && input.strict) {
			const unique = [...new Map(conflicts.map(({ request, holder }) => [`${request.cwd}\0${holder.runId}`, { request, holder }])).values()];
			return {
				claims: [],
				warnings: [],
				error: `Refusing cwd claim: run '${unique[0]!.request.runId}' would share '${unique[0]!.request.cwd}' with live run '${unique[0]!.holder.runId}'.`,
			};
		}
		const now = input.now ?? Date.now();
		const created = requests.map((request) => ({ ...request, claimedAt: now }));
		for (const claim of created) {
			this.claims.set(`${claim.runId}:${claim.childIndex}`, claim);
			this.append(claim.claimsFile, { event: "claim", ...claim });
		}
		const warnings = conflicts.map(({ request, holder }) => `Cwd writer conflict: run '${request.runId}' child ${request.childIndex} and live run '${holder.runId}' both write ${request.cwd}.`);
		return { claims: created, warnings };
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

	get staleClaims(): number {
		return this.staleClaimCount;
	}

	format(liveRunIds: ReadonlySet<string>): string {
		const claims = this.list(liveRunIds);
		if (!claims.length) return `Active cwd claims: none (stale claims pruned: ${this.staleClaimCount}; persistence failures: ${this.persistenceFailureCount}).`;
		const byCwd = new Map<string, Set<string>>();
		for (const claim of claims) {
			const owners = byCwd.get(claim.cwd) ?? new Set<string>();
			owners.add(claim.runId);
			byCwd.set(claim.cwd, owners);
		}
		const lines = [`Active cwd claims (stale claims pruned: ${this.staleClaimCount}; persistence failures: ${this.persistenceFailureCount}):`];
		for (const [cwd, runs] of byCwd) lines.push(`${runs.size} runs writing ${cwd}`);
		for (const claim of claims) lines.push(`  run ${claim.runId} child ${claim.childIndex}: ${claim.cwd}`);
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
			// Persistence must not make a launch fail, but the loss is surfaced in status.
			this.persistenceFailureCount++;
		}
	}
}
