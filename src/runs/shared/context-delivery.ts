import * as fs from "node:fs";
import * as path from "node:path";

export interface ContextFiles {
	required?: string[];
	optional?: string[];
}

export interface ContextDeliveryReceipt {
	version: 1;
	cwd: string;
	preparedAt: string;
	references: Array<{ path: string; requirement: "required" | "optional"; status: "available" | "missing"; bytes?: number }>;
	projectContext: { loaded: "unknown"; truncation: "unknown" };
}

export function prepareContextDelivery(cwd: string, contextFiles: ContextFiles = {}): { prompt: string; receipt: ContextDeliveryReceipt } {
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
			try {
				const stat = fs.statSync(filePath);
				if (!stat.isFile()) throw new Error("not a regular file");
				const content = fs.readFileSync(filePath, "utf8");
				entries.push({ path: filePath, requirement, status: "available", bytes: Buffer.byteLength(content) });
				sections.push(`## ${filePath}\n\n${content}`);
			} catch (error) {
				if (requirement === "required") {
					throw new Error(`Cannot start subagent: required context file '${reference}' is unavailable from cwd '${cwd}' (${error instanceof Error ? error.message : String(error)}). Restore the file or correct contextFiles.required.`);
				}
				entries.push({ path: filePath, requirement, status: "missing" });
			}
		}
	}
	const receipt: ContextDeliveryReceipt = {
		version: 1,
		cwd: path.resolve(cwd),
		preparedAt: new Date().toISOString(),
		references: entries,
		projectContext: { loaded: "unknown", truncation: "unknown" },
	};
	return {
		prompt: sections.length ? `# Explicit Task Context\n\nThe following required/optional task context was supplied to this prompt.\n\n${sections.join("\n\n")}` : "",
		receipt,
	};
}

export function writeContextDeliveryReceipt(filePath: string, receipt: ContextDeliveryReceipt): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}
