export const RUNNER_HEARTBEAT_INTERVAL_MS = 30_000;

/** Start a non-owning heartbeat that self-stops when the run has no active child. */
export function startRunnerHeartbeat(
	isRunning: () => boolean,
	onHeartbeat: () => void,
	intervalMs = RUNNER_HEARTBEAT_INTERVAL_MS,
): () => void {
	let stopped = false;
	const timer = setInterval(() => {
		if (stopped) return;
		if (!isRunning()) {
			stopped = true;
			clearInterval(timer);
			return;
		}
		onHeartbeat();
	}, intervalMs);
	timer.unref?.();
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
	};
}
