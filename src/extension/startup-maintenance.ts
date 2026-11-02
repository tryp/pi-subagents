export const STARTUP_RECONCILIATION_DISABLE_ENV = "PI_SUBAGENTS_DISABLE_STARTUP_RECONCILIATION";
export const STARTUP_RECONCILIATION_DELAY_MS = 1_000;

export interface StartupReconciliationController {
	schedule(work: (isCurrent: () => boolean) => void | Promise<void>, delayMs?: number): void;
	invalidate(): void;
	dispose(): void;
}

export function createStartupReconciliationController(): StartupReconciliationController {
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	const invalidate = () => {
		generation++;
		if (timer) clearTimeout(timer);
		timer = null;
	};

	return {
		schedule(work, delayMs = STARTUP_RECONCILIATION_DELAY_MS) {
			invalidate();
			const scheduledGeneration = generation;
			const isCurrent = () => !disposed && scheduledGeneration === generation;
			if (!isCurrent()) return;
			timer = setTimeout(() => {
				timer = null;
				if (!isCurrent()) return;
				void work(isCurrent);
			}, delayMs);
			timer.unref?.();
		},
		invalidate,
		dispose() {
			disposed = true;
			invalidate();
		},
	};
}
