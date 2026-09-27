import { DEFAULT_SYNC_WAKE_MS, type ExtensionConfig } from "../../shared/types.ts";

/**
 * Resolve the sync-runtime wake budget for a single foreground subagent run.
 *
 * Returns undefined when the wake is disabled:
 * - the caller passed an explicit timeoutMs (that caller already chose its
 *   own bound and expects the timeout-kill semantics);
 * - config.syncWakeMs is 0 (explicit opt-out).
 *
 * Otherwise returns config.syncWakeMs when positive, or DEFAULT_SYNC_WAKE_MS
 * (4 minutes). The wake detaches a still-running child and returns control to
 * the outer agent with a notice, instead of blocking its loop until the child
 * finishes — which may be never (observed: a 14h stall from a sync call whose
 * child ran a deadlocked test binary).
 */
export function resolveSyncWakeMs(
	config: Pick<ExtensionConfig, "syncWakeMs">,
	explicitTimeoutMs?: number,
): number | undefined {
	if (explicitTimeoutMs !== undefined) return undefined;
	if (typeof config.syncWakeMs !== "number" || !Number.isFinite(config.syncWakeMs)) return DEFAULT_SYNC_WAKE_MS;
	if (config.syncWakeMs === 0) return undefined;
	if (config.syncWakeMs > 0) return config.syncWakeMs;
	return DEFAULT_SYNC_WAKE_MS;
}

/**
 * Resolve the checkpoint budget for an explicit blocking wait.
 *
 * This shares the `syncWakeMs` configuration and default with foreground sync
 * wakes, but a wait's `timeoutMs` is only an upper bound: it must not disable
 * the checkpoint the way an explicit foreground-run timeout disables sync wake.
 */
export function resolveSupervisorCheckpointMs(
	config: Pick<ExtensionConfig, "syncWakeMs">,
): number | undefined {
	return resolveSyncWakeMs(config);
}
