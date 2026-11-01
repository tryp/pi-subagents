import { performance } from "node:perf_hooks";
import { pruneAsyncRunDirs, scanProcOpenFds } from "../src/runs/background/async-run-retention.ts";

// Usage: node bench-async-gc.ts [--scan-fds] ASYNC_DIR NESTED_EVENTS_DIR RESULTS_DIR
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
const argv = process.argv.slice(2);
const scanFds = argv.includes("--scan-fds");
const [asyncDir, nestedEventsDir, resultsDir] = argv.filter((arg) => arg !== "--scan-fds");
if (!asyncDir || !nestedEventsDir || !resultsDir) {
	throw new Error("usage: node bench-async-gc.ts [--scan-fds] ASYNC_DIR NESTED_EVENTS_DIR RESULTS_DIR");
}
const started = performance.now();
const summary = pruneAsyncRunDirs({
	asyncDir,
	nestedEventsDir,
	resultsDir,
	budgetBytes: Number.MAX_SAFE_INTEGER,
	...(scanFds ? {} : { scanOpenFds: () => ({ complete: true, unreadable: 0, foreignUid: 0, scannedReadableForeign: 0, foreignUnreadable: 0, sameUidUnreadable: 0, uidUnverifiable: 0, procStatusErrors: {}, fdTableErrors: {}, fdEntryErrors: {}, sameUidFdErrorCodes: {}, foreignFdErrorCodes: {}, scanTruncated: false, unreadableForeignUids: [], openPaths: [] }) }),
	log: (line) => console.log(line),
});
console.log(JSON.stringify({ wallMs: +(performance.now() - started).toFixed(1), fdScanMode: scanFds ? "real" : "stubbed", ...summary }));
// Keep the import reachable in the stubbed mode too, so `--scan-fds` and the
// default differ only by the injected scanner and never by the import graph.
void scanProcOpenFds;
