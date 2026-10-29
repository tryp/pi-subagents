import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

export interface ContextFiles {
	required?: string[];
	optional?: string[];
}

export interface ContextDeliveryReceipt {
	version: 1;
	cwd: string;
	revision: string | null;
	runId: string | null;
	childId: string | null;
	attemptId: string;
	taskSha256: string;
	preparedAt: string;
	lifecycle: { state: "prepared"; modelDelivery: "unknown" };
	references: Array<{ path: string; requirement: "required" | "optional"; status: "available" | "missing" | "unreadable" | "unsupported"; bytes?: number }>;
	projectContext: { inventory: "unknown"; loaded: "unknown"; truncation: "unknown" };
}

const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;

export function prepareContextDelivery(
	cwd: string,
	contextFiles: ContextFiles = {},
	identity: { runId?: string; childId?: string; task?: string } = {},
): { prompt: string; receipt: ContextDeliveryReceipt } {
	let cwdStat: fs.Stats;
	try {
		cwdStat = fs.statSync(cwd);
	} catch (error) {
		throw new Error(`Cannot start subagent: working directory '${cwd}' is unavailable (${error instanceof Error ? error.message : String(error)}). Choose an existing cwd and retry.`);
	}
	if (!cwdStat.isDirectory()) throw new Error(`Cannot start subagent: working directory '${cwd}' is not a directory.`);

	const entries: ContextDeliveryReceipt["references"] = [];
	const sections: string[] = [];
	for (const [requirement, references] of [["required", contextFiles.required ?? []], ["optional", contextFiles.optional ?? []]] as const) {
		for (const reference of references) {
			const filePath = path.resolve(cwd, reference);
			let status: "missing" | "unreadable" | "unsupported" = "missing";
			try {
				const stat = fs.statSync(filePath);
				if (!stat.isFile()) {
					status = "unsupported";
					throw new Error("not a regular file");
				}
				if (stat.size > MAX_CONTEXT_FILE_BYTES) {
					status = "unsupported";
					throw new Error(`file exceeds the ${MAX_CONTEXT_FILE_BYTES}-byte text limit`);
				}
				const bytes = fs.readFileSync(filePath);
				let content: string;
				try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
				catch { status = "unsupported"; throw new Error("file is not valid UTF-8 text"); }
				if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) {
					status = "unsupported";
					throw new Error("file contains binary data");
				}
				entries.push({ path: filePath, requirement, status: "available", bytes: bytes.byteLength });
				sections.push(`## ${filePath}\n\n${content}`);
			} catch (error) {
				if (status === "missing" && fs.existsSync(filePath)) status = "unreadable";
				if (requirement === "required") {
					const detail = error instanceof Error ? error.message : String(error);
					throw new Error(`Cannot start subagent: required context file '${reference}' is ${status} from cwd '${cwd}' (${detail}). Use a readable UTF-8 text file no larger than ${MAX_CONTEXT_FILE_BYTES} bytes, or correct contextFiles.required.`);
				}
				entries.push({ path: filePath, requirement, status });
			}
		}
	}
	let revision: string | null = null;
	try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim() || null; } catch { /* outside a readable Git worktree */ }
	const receipt: ContextDeliveryReceipt = {
		version: 1,
		cwd: path.resolve(cwd),
		revision,
		runId: identity.runId ?? null,
		childId: identity.childId ?? null,
		attemptId: crypto.randomUUID(),
		taskSha256: crypto.createHash("sha256").update(identity.task ?? "").digest("hex"),
		preparedAt: new Date().toISOString(),
		lifecycle: { state: "prepared", modelDelivery: "unknown" },
		references: entries,
		projectContext: { inventory: "unknown", loaded: "unknown", truncation: "unknown" },
	};
	return {
		prompt: sections.length ? `# Explicit Task Context\n\nThe following required/optional task context was supplied to this prompt.\n\n${sections.join("\n\n")}` : "",
		receipt,
	};
}

export function writeContextDeliveryReceipt(filePath: string, receipt: ContextDeliveryReceipt): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tempPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		fs.renameSync(tempPath, filePath);
	} finally {
		try { fs.unlinkSync(tempPath); } catch { /* already renamed or absent */ }
	}
}
