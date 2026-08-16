import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scenarioPath = path.join(projectRoot, "test", "support", "structured-output-scenario.ts");
const structuredOutputSourcePath = path.join(projectRoot, "src", "runs", "shared", "structured-output.ts");

interface ScenarioResult {
	scenario: string;
	valid: { status: string };
	invalid: { status: string; message?: string };
	roundTrip: { value?: unknown; error?: string };
	mismatchError?: string;
}

function runScenario(scenario: string, piRootEnv?: string): ScenarioResult {
	const env: NodeJS.ProcessEnv = { ...process.env, SCENARIO: scenario };
	if (piRootEnv === undefined) delete env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	else env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = piRootEnv;

	const result = execFileSync(process.execPath, ["--experimental-strip-types", scenarioPath], {
		cwd: projectRoot,
		env,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lastLine = result.trim().split("\n").pop();
	assert.ok(lastLine, `scenario ${scenario} produced no output`);
	return JSON.parse(lastLine) as ScenarioResult;
}

describe("structured output typebox resolution (async runner regression)", () => {
	let fakeHostRoot: string;

	before(() => {
		// Stub pi host package root: a real node_modules/typebox copy that the
		// loader must resolve through createRequire(piRoot/package.json), with a
		// deliberately recognizable validator so tests can prove host usage.
		fakeHostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-fake-host-"));
		fs.writeFileSync(path.join(fakeHostRoot, "package.json"), JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version: "0.0.0-fake",
		}));
		const typeboxDir = path.join(fakeHostRoot, "node_modules", "typebox");
		fs.mkdirSync(typeboxDir, { recursive: true });
		fs.writeFileSync(path.join(typeboxDir, "package.json"), JSON.stringify({
			name: "typebox",
			version: "1.1.38-fake",
			type: "module",
			exports: {
				"./compile": { import: "./index.mjs", default: "./index.mjs" },
			},
		}));
		fs.writeFileSync(
			path.join(typeboxDir, "index.mjs"),
			"export function Compile(schema) {\n" +
				"  if (schema && schema.required && schema.required.includes(\"id\")) {\n" +
				"    return {\n" +
				"      Check: (v) => !!v && typeof v.id === \"number\",\n" +
				"      Errors: (v) => (!!v && typeof v.id === \"number\") ? [] : [{ instancePath: \"/id\", message: \"STUB-VALIDATOR expects a numeric id\" }],\n" +
				"    };\n" +
				"  }\n" +
				"  return { Check: () => true, Errors: () => [] };\n" +
				"}\n",
		);
	});

	after(() => {
		fs.rmSync(fakeHostRoot, { recursive: true, force: true });
	});

	it("loads and validates against the pi host package root, like the detached runner", () => {
		const result = runScenario("host-root", fakeHostRoot);
		assert.equal(result.scenario, "host-root");
		assert.equal(result.valid.status, "valid");
		assert.equal(result.invalid.status, "invalid");
		// The STUB-VALIDATOR marker proves the host copy was loaded, not the
		// dev node_modules copy, i.e. the runner's createRequire fallback works.
		assert.match(result.invalid.message ?? "", /STUB-VALIDATOR/);
		assert.deepEqual(result.roundTrip.value, { ok: 1 });
		assert.match(result.mismatchError ?? "", /STUB-VALIDATOR/);
	});

	it("falls back to the local bare import when no pi root is configured (dev/CI installs)", () => {
		const result = runScenario("local");
		assert.equal(result.scenario, "local");
		assert.equal(result.valid.status, "valid");
		assert.equal(result.invalid.status, "invalid");
		// Real typebox wording, not the stub marker.
		assert.doesNotMatch(result.invalid.message ?? "", /STUB-VALIDATOR/);
		assert.deepEqual(result.roundTrip.value, { ok: 1 });
	});

	it("never statically imports typebox/compile (regression guard for the runner boot crash)", () => {
		const source = fs.readFileSync(structuredOutputSourcePath, "utf-8");
		assert.doesNotMatch(
			source,
			/^\s*import\s[^;]*\bfrom\s+["']typebox\/(?:compile)["'];?$/m,
			"a static import of typebox/compile breaks the detached runner, which has no typebox in node_modules",
		);
		// The host-root fallback must stay wired to the runner-spawned env var.
		assert.match(source, /PI_CODING_AGENT_PACKAGE_ROOT_ENV/);
		assert.match(source, /createRequire/);
		// The lazy fallback for dev/CI must stay a bare dynamic import (jiti
		// alias in-process, local node_modules in dev/test).
		assert.match(source, /await import\(["']typebox\/compile["']\)/);
	});
});