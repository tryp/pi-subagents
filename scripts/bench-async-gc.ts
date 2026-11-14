import { performance } from "node:perf_hooks";
import { pruneAsyncRunDirs, runAsyncRunGc, scanProcOpenFds } from "../src/runs/background/async-run-retention.ts";

// Usage: node bench-async-gc.ts [--scan-fds] [--worker] ASYNC_DIR NESTED_EVENTS_DIR RESULTS_DIR
//
// Without --scan-fds this measures the sweep with the /proc descriptor scan
// STUBBED OUT. That is deliberate and narrow: it isolates the route/status
// reading cost from the process scan, and it is what makes the pre-fix vs
// post-fix timing comparison like-for-like. It is NOT a measurement of the
// machine: every fd figure in that mode is zero by construction
// (sameUidUnreadable, foreignUnreadable, blockedUnreadable), so a zero there
// says nothing about whether the sweep is blind. Conclusions about blindness or
// prunability must come from --scan-fds or from a real dry run.
//
// `fdScanMode` in the output records which one produced the numbers.
//
// --worker runs the sweep through the startup path (runAsyncRunGc, i.e. a worker
// thread) instead of inline. Both modes report `mainThreadStallMs`: a 10ms timer
// armed immediately before the sweep and how late it fires. That is the number a
// user feels -- on 2026-11-14 it was 2,905ms inline on this machine's corpus and
// 0ms through the worker, which is why startup stopped lagging.
const argv = process.argv.slice(2);
const scanFds = argv.includes("--scan-fds");
const useWorker = argv.includes("--worker");
const [asyncDir, nestedEventsDir, resultsDir] = argv.filter((arg) => !arg.startsWith("--"));
if (!asyncDir || !nestedEventsDir || !resultsDir) {
	throw new Error("usage: node bench-async-gc.ts [--scan-fds] [--worker] ASYNC_DIR NESTED_EVENTS_DIR RESULTS_DIR");
}
if (useWorker && !scanFds) {
	// The stub is a function and functions cannot cross a thread boundary, so a
	// stubbed worker run would measure a different sweep than the inline run it is
	// compared against. Refuse instead of printing a number that looks comparable.
	throw new Error("--worker cannot be combined with the stubbed scanner; add --scan-fds");
}

async function timed<T>(run: () => Promise<T> | T): Promise<{ value: T; wallMs: number; mainThreadStallMs: number }> {
	const started = performance.now();
	const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 10));
	const value = await run();
	const wallMs = +(performance.now() - started).toFixed(1);
	return { value, wallMs, mainThreadStallMs: +((await timer) - 10).toFixed(1) };
}

const options = {
	asyncDir,
	nestedEventsDir,
	resultsDir,
	budgetBytes: Number.MAX_SAFE_INTEGER,
	...(scanFds ? {} : { scanOpenFds: () => ({ complete: true, unreadable: 0, foreignUid: 0, scannedReadableForeign: 0, foreignUnreadable: 0, sameUidUnreadable: 0, uidUnverifiable: 0, procStatusErrors: {}, fdTableErrors: {}, fdEntryErrors: {}, sameUidFdErrorCodes: {}, foreignFdErrorCodes: {}, scanTruncated: false, unreadableForeignUids: [], openPaths: [] }) }),
};

const lines: string[] = [];
const measured = await timed(async () =>
	useWorker
		? runAsyncRunGc({ ...options, dryRun: true, log: (line) => lines.push(line) })
		: pruneAsyncRunDirs({ ...options, log: (line) => lines.push(line) }),
);
for (const line of lines) console.log(line);
console.log(JSON.stringify({
	wallMs: measured.wallMs,
	mainThreadStallMs: measured.mainThreadStallMs,
	execution: useWorker ? "worker" : "inline",
	fdScanMode: scanFds ? "real" : "stubbed",
	summary: measured.value ?? null,
}));
// Keep the import reachable in the stubbed mode too, so `--scan-fds` and the
// default differ only by the injected scanner and never by the import graph.
void scanProcOpenFds;
