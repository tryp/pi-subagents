import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { pruneAsyncRunDirs } from "../src/runs/background/async-run-retention.ts";

const [asyncDir, nestedEventsDir, resultsDir] = process.argv.slice(2);
if (!asyncDir || !nestedEventsDir || !resultsDir) {
	throw new Error("usage: node bench-async-gc-phases.ts ASYNC_DIR NESTED_EVENTS_DIR RESULTS_DIR");
}

const paths = [asyncDir, nestedEventsDir, resultsDir];
const inventory = () => {
	let files = 0;
	let bytes = 0;
	for (const root of paths) {
		const pending = [root];
		while (pending.length) {
			const current = pending.pop()!;
			for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
				const full = `${current}/${entry.name}`;
				if (entry.isDirectory()) pending.push(full);
				else { files++; bytes += fs.lstatSync(full).size; }
			}
		}
	}
	return { files, bytes };
};
console.log(JSON.stringify({ inventoryBefore: inventory() }));

for (let run = 1; run <= 3; run++) {
	const phases: Record<string, number> = {};
	const started = performance.now();
	let scheduledImmediateRan = false;
	setImmediate(() => { scheduledImmediateRan = true; });
	const summary = await pruneAsyncRunDirs({
		asyncDir,
		nestedEventsDir,
		resultsDir,
		dryRun: true,
		onPhase: (name, elapsedMs) => { phases[name] = (phases[name] ?? 0) + elapsedMs; },
	});
	const elapsedMs = performance.now() - started;
	// Synchronous baseline blocks the event loop through the entire sweep.
	await new Promise<void>((resolve) => setImmediate(resolve));
	const statusAndBytesMs = (phases.perRunStatusReads ?? 0) + (phases.directoryBytes ?? 0);
	console.log(JSON.stringify({
		run,
		phases: {
			candidateListingResidualMs: +(Math.max(0, (phases.candidateListing ?? 0) - statusAndBytesMs)).toFixed(1),
			nestedRouteIndexMs: +(phases.nestedRouteIndex ?? 0).toFixed(1),
			perRunStatusReadsMs: +(phases.perRunStatusReads ?? 0).toFixed(1),
			directoryBytesMs: +(phases.directoryBytes ?? 0).toFixed(1),
			livenessFdScanMs: +(phases.livenessFdScan ?? 0).toFixed(1),
			deletionMs: +(phases.deletion ?? 0).toFixed(1),
		},
		totalMs: +elapsedMs.toFixed(1),
		longestSynchronousBlockMs: +summary.longestSynchronousBlockMs.toFixed(1),
		immediateRanDuringSweep: scheduledImmediateRan,
		examined: summary.examined,
		pruned: summary.pruned,
		dryRunWouldPrune: summary.dryRunWouldPrune,
		fdScan: summary.fdScan,
		bytesBefore: summary.bytesBefore,
		bytesAfter: summary.bytesAfter,
	}));
}

console.log(JSON.stringify({ inventoryAfter: inventory() }));
