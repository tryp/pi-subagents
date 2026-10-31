import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	JsonRpcLspClient,
	WatchdogLspDiagnosticsLedger,
	collectWatchdogLspDiagnostics,
	formatWatchdogLspDiagnosticsBlock,
	watchdogWarningFromLspDiagnostics,
} from "../../src/watchdog/lsp-diagnostics.ts";
import type { WatchdogLspResult } from "../../src/watchdog/types.ts";

function result(diagnostics: WatchdogLspResult["diagnostics"]): WatchdogLspResult {
	return {
		status: "ok",
		provider: "stub-lsp",
		checkedPaths: ["src/file.ts"],
		skippedPaths: [],
		diagnostics,
	};
}

describe("watchdog LSP diagnostics", () => {
	it("formats diagnostics for watchdog review input", () => {
		const block = formatWatchdogLspDiagnosticsBlock(result([{
			path: "src/file.ts",
			line: 2,
			column: 3,
			severity: "error",
			source: "typescript",
			code: "TS2322",
			message: "Type mismatch.",
		}]));

		assert.match(block, /^LSP diagnostics:/);
		assert.match(block, /src\/file\.ts:2:3 error TS2322 typescript: Type mismatch\./);
	});

	it("omits info and hints from watchdog review input", () => {
		const block = formatWatchdogLspDiagnosticsBlock(result([{
			path: "src/file.ts",
			line: 2,
			column: 3,
			severity: "info",
			source: "typescript",
			message: "Helpful note.",
		}, {
			path: "src/file.ts",
			line: 3,
			column: 4,
			severity: "hint",
			source: "typescript",
			message: "Suggestion.",
		}]));

		assert.equal(block, "");
	});

	it("maps errors to blockers and warnings to concerns", () => {
		const blocker = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "error",
			source: "typescript",
			message: "Cannot find name 'x'.",
		}]));
		assert.equal(blocker?.severity, "blocker");
		assert.equal(blocker?.source, "lsp");

		const concern = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "warning",
			source: "typescript",
			message: "Unused value.",
		}]));
		assert.equal(concern?.severity, "concern");

		const info = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "info",
			source: "typescript",
			message: "Helpful note.",
		}]));
		assert.equal(info, undefined);
	});

	it("returns a failed result for malformed language-server JSON", async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-"));
		try {
			const binDir = path.join(temp, "node_modules", ".bin");
			fs.mkdirSync(path.join(temp, "src"), { recursive: true });
			fs.mkdirSync(binDir, { recursive: true });
			fs.writeFileSync(path.join(temp, "src", "file.ts"), "export const value = 1;\n", "utf-8");
			const scriptPath = path.join(binDir, "tls-malformed.js");
			fs.writeFileSync(scriptPath, "process.stdout.write('Content-Length: 8\\r\\n\\r\\nnot-json'); setTimeout(() => process.exit(0), 50);\n", "utf-8");
			if (process.platform === "win32") {
				fs.writeFileSync(path.join(binDir, "typescript-language-server.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0\\tls-malformed.js" %*\r\n`, "utf-8");
			} else {
				const commandPath = path.join(binDir, "typescript-language-server");
				fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/tls-malformed.js" "$@"\n`, { encoding: "utf-8", mode: 0o755 });
			}

			const diagnostics = await collectWatchdogLspDiagnostics({
				cwd: temp,
				root: temp,
				changedPaths: ["src/file.ts"],
				config: { enabled: true, timeoutMs: 500, maxFiles: 10, maxDiagnostics: 10 },
			});

			assert.equal(diagnostics.status, "failed");
			assert.match(diagnostics.message ?? "", /Invalid LSP JSON-RPC response/);
		} finally {
			try {
				fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			} catch (error) {
				if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			}
		}
	});

	it("rejects a request instead of writing into a closed language-server pipe", async () => {
		// Deterministic form of the same fault: the pipe is already gone before the
		// first write, so the client cannot observe the exit event in time. Writing
		// anyway is where EPIPE used to escape as an uncaught exception.
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "pipe" });
		const client = new JsonRpcLspClient(child);
		try {
			child.stdin.destroy();
			await assert.rejects(client.request("initialize", {}, 200), /stdin is closed|already exited/);
		} finally {
			client.kill();
		}
	});

	it("settles pending requests when the language-server pipe errors, leaving nothing uncaught", async () => {
		// The guard above cannot cover this one: the socket had not seen EOF yet when
		// the write went out, so EPIPE arrives as an error event on stdin. With no
		// listener that is an uncaught exception in the host process and the request
		// never settles.
		const stdin = new EventEmitter() as EventEmitter & { write: () => boolean };
		stdin.write = () => true;
		const fakeChild = Object.assign(new EventEmitter(), {
			stdin,
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill: () => true,
		}) as unknown as ChildProcessWithoutNullStreams;
		const client = new JsonRpcLspClient(fakeChild);

		const pending = client.request("initialize", {}, 1000);
		const writeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
		stdin.emit("error", writeError);

		await assert.rejects(pending, /write EPIPE/);
	});

	it("treats a language server that closes its input as a failure, not an uncaught exception", async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-"));
		try {
			const binDir = path.join(temp, "node_modules", ".bin");
			fs.mkdirSync(path.join(temp, "src"), { recursive: true });
			fs.mkdirSync(binDir, { recursive: true });
			fs.writeFileSync(path.join(temp, "src", "file.ts"), "export const value = 1;\n", "utf-8");
			// Reads the first frame, closes its own stdin, then outlives the run. The
			// parent's *next* write therefore hits a closed pipe while the child is
			// still alive, so no exit event can settle the request. That write used to
			// surface as an uncaught EPIPE in the host process: the request never
			// settled, and under the test runner the failure landed on whichever test
			// happened to be writing -- a 13% flake in this file, and a crashed agent
			// in a real session.
			const scriptPath = path.join(binDir, "tls-closes-stdin.js");
			fs.writeFileSync(
				scriptPath,
				"process.stdin.once('data', () => process.stdin.destroy()); setTimeout(() => process.exit(0), 3000);\n",
				"utf-8",
			);
			if (process.platform === "win32") {
				fs.writeFileSync(path.join(binDir, "typescript-language-server.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0\\tls-closes-stdin.js" %*\r\n`, "utf-8");
			} else {
				const commandPath = path.join(binDir, "typescript-language-server");
				fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/tls-closes-stdin.js" "$@"\n`, { encoding: "utf-8", mode: 0o755 });
			}

			const diagnostics = await collectWatchdogLspDiagnostics({
				cwd: temp,
				root: temp,
				changedPaths: ["src/file.ts"],
				config: { enabled: true, timeoutMs: 400, maxFiles: 10, maxDiagnostics: 10 },
			});

			assert.notEqual(diagnostics.status, "ok", "a server that closed its input cannot have reported diagnostics");
			assert.equal(diagnostics.diagnostics.length, 0);
		} finally {
			try {
				fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			} catch (error) {
				if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			}
		}
	});

	it("suppresses repeated diagnostic identities until the file clears", () => {
		const ledger = new WatchdogLspDiagnosticsLedger();
		const diagnostic = {
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "warning" as const,
			source: "typescript",
			code: "TS6133",
			message: "Unused value.",
		};

		assert.equal(ledger.reduce(result([diagnostic])).diagnostics.length, 1);
		assert.equal(ledger.reduce(result([{ ...diagnostic, line: 4, column: 9 }])).diagnostics.length, 0);
		assert.equal(ledger.reduce(result([])).diagnostics.length, 0);
		assert.equal(ledger.reduce(result([{ ...diagnostic, line: 8 }])).diagnostics.length, 1);
	});
});
