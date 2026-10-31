import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Assemble the flag so this regression test cannot trigger its own scan.
const FLAG = `${"--test"}-${"force"}-${"exit"}`;

type Source = { where: string; text: string };

function sources(): Source[] {
	const entries: Source[] = [
		{ where: "Makefile", text: fs.readFileSync(path.join(ROOT, "Makefile"), "utf-8") },
		{ where: "package.json", text: fs.readFileSync(path.join(ROOT, "package.json"), "utf-8") },
	];
	const scripts = path.join(ROOT, "scripts");
	for (const name of fs.readdirSync(scripts).filter((entry) => entry.endsWith(".py"))) {
		entries.push({ where: `scripts/${name}`, text: fs.readFileSync(path.join(scripts, name), "utf-8") });
	}
	return entries;
}

function executableLines(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#") && !line.trimStart().startsWith("//"));
}

it("never runs a suite with the flag that silently truncates test results", () => {
	const entries = sources();
	assert.ok(entries.length >= 4, `expected Makefile, package.json and at least two scripts, saw ${entries.length}`);
	const testInvocations = entries.flatMap((entry) => executableLines(entry.text).filter((line) => line.includes("--test")));
	assert.ok(testInvocations.length > 0, "the scan found no test invocation at all, so it proves nothing");

	const offenders = entries
		.filter((entry) => executableLines(entry.text).some((line) => line.includes(FLAG)))
		.map((entry) => entry.where);
	assert.deepEqual(offenders, [], `these invocations pass ${FLAG}: ${offenders.join(", ")}`);
});
