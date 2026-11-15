import { parentPort, workerData } from "node:worker_threads";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";

if (!parentPort) throw new Error("async-status-worker must run on a worker thread");

const request = workerData as {
	asyncDirRoot: string;
	options: { states?: AsyncRunSummary["state"][]; sessionId?: string; resultsDir?: string };
};

try {
	const runs = listAsyncRuns(request.asyncDirRoot, { ...request.options, reconcile: true }) as AsyncRunSummary[];
	parentPort.postMessage({ type: "result", runs });
} catch (error) {
	parentPort.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
}
