/**
 * Worker-thread host for the startup async-run sweep.
 *
 * The sweep walks every retained run directory, parses each status.json (67 MiB across
 * 3,975 files on 2026-11-14) and reads /proc for every open descriptor on the machine.
 * Run inline it blocked the interactive TUI for ~2.5s, 2s after launch, which is the lag
 * a user sees as "typing stops, then catches up". pruneAsyncRunDirs stays synchronous and
 * pure so it can be unit-tested and benchmarked in-process; this file is only the
 * execution host.
 */
import { parentPort, workerData, threadId } from "node:worker_threads";
import { type AsyncRunGcWorkerRequest, pruneAsyncRunDirs } from "./async-run-retention.ts";

if (!parentPort) throw new Error("async-run-retention-worker must run on a worker thread");

const port = parentPort;

function post(message: AsyncRunGcWorkerMessage): void {
	port.postMessage(message);
}

export type AsyncRunGcWorkerMessage =
	| { type: "log"; line: string }
	| { type: "result"; summary: unknown }
	| { type: "error"; message: string };

const request = (workerData ?? {}) as AsyncRunGcWorkerRequest;

try {
	const summary = pruneAsyncRunDirs({
		...request.options,
		// Functions cannot cross the thread boundary; the worker always uses the real
		// /proc scan and the caller's liveness helper is the default one.
		log: (line) => post({ type: "log", line }),
	});
	post({ type: "result", summary: { ...summary, workerThreadId: threadId } });
} catch (error) {
	post({ type: "error", message: error instanceof Error ? error.message : String(error) });
}
