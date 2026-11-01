import { performance } from "node:perf_hooks";
import { pruneAsyncRunDirs } from "../src/runs/background/async-run-retention.ts";

const [asyncDir, nestedEventsDir, resultsDir] = process.argv.slice(2);
if (!asyncDir || !nestedEventsDir || !resultsDir) throw new Error("usage: node bench-async-gc.ts ASYNC_DIR NESTED_EVENTS_DIR RESULTS_DIR");
const started = performance.now();
const summary = pruneAsyncRunDirs({
	asyncDir,
	nestedEventsDir,
	resultsDir,
	budgetBytes: Number.MAX_SAFE_INTEGER,
	scanOpenFds: () => ({ complete: true, unreadable: 0, openPaths: [] }),
	log: (line) => console.log(line),
});
console.log(JSON.stringify({ wallMs: +(performance.now() - started).toFixed(1), ...summary }));
