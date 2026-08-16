import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { JsonSchemaObject } from "../../shared/types.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";

export const STRUCTURED_OUTPUT_SCHEMA_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA";
export const STRUCTURED_OUTPUT_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE";

export interface StructuredOutputRuntime {
	schema: JsonSchemaObject;
	schemaPath: string;
	outputPath: string;
}

interface CompiledJsonSchema {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<{ instancePath?: string; message?: string }>;
}

interface CompileModule {
	Compile(schema: unknown): CompiledJsonSchema;
}

let compileModulePromise: Promise<CompileModule> | undefined;

/**
 * Load the `typebox/compile` validator without a static import.
 *
 * The in-process extension receives typebox through the pi extension loader's
 * host aliases, and development/CI installs carry it in local node_modules, so
 * the bare dynamic import covers both. The detached async runner is a plain
 * `node jiti-cli subagent-runner.ts` process that inherits neither: typebox is
 * a Pi-host-owned optional peer, so the runner's production node_modules only
 * contains runtime dependencies (jiti, yaml). That child is spawned with
 * PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT pointing at the installed pi
 * package, so fall back to resolving and importing the host's copy directly.
 */
async function loadCompileModule(): Promise<CompileModule> {
	const piRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	if (piRoot) {
		try {
			const hostRequire = createRequire(path.join(piRoot, "package.json"));
			const compilePath = hostRequire.resolve("typebox/compile");
			const loaded = (await import(pathToFileURL(compilePath).href)) as Partial<CompileModule>;
			if (typeof loaded.Compile === "function") return loaded as CompileModule;
		} catch {
			// Fall through to local/alias resolution below.
		}
	}
	try {
		const loaded = (await import("typebox/compile")) as Partial<CompileModule>;
		if (typeof loaded.Compile !== "function") {
			throw new Error("typebox/compile did not expose a Compile function");
		}
		return loaded as CompileModule;
	} catch (error) {
		const piHint = piRoot
			? `resolved pi package root ${piRoot}`
			: `no pi package root configured (${PI_CODING_AGENT_PACKAGE_ROOT_ENV} unset)`;
		throw new Error(
			`Unable to load typebox/compile (${piHint}): ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function assertJsonSchemaObject(schema: unknown, label = "outputSchema"): asserts schema is JsonSchemaObject {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error(`${label} must be a JSON Schema object.`);
	}
}

export function createStructuredOutputRuntime(schema: JsonSchemaObject, baseDir?: string): StructuredOutputRuntime {
	assertJsonSchemaObject(schema);
	const rootDir = baseDir ?? os.tmpdir();
	fs.mkdirSync(rootDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(rootDir, "pi-subagent-structured-"));
	const schemaPath = path.join(dir, "schema.json");
	const outputPath = path.join(dir, "output.json");
	fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
	return { schema, schemaPath, outputPath };
}

export async function validateStructuredOutputValue(schema: JsonSchemaObject, value: unknown): Promise<{ status: "valid" } | { status: "invalid"; message: string }> {
	let validator: CompiledJsonSchema;
	try {
		const compiler = compileModulePromise ??= loadCompileModule();
		const mod = await compiler;
		validator = mod.Compile(schema);
	} catch (error) {
		return { status: "invalid", message: `invalid outputSchema: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (validator.Check(value)) return { status: "valid" };
	const errors = [...validator.Errors(value)]
		.slice(0, 8)
		.map((error) => {
			const pathText = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "root";
			return `${pathText}: ${error.message}`;
		});
	return { status: "invalid", message: errors.join("; ") || "schema validation failed" };
}

export async function readStructuredOutput(runtime: StructuredOutputRuntime): Promise<{ value?: unknown; error?: string }> {
	if (!fs.existsSync(runtime.outputPath)) {
		return { error: "Missing structured_output call; this step has outputSchema and must finish by calling structured_output." };
	}
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(runtime.outputPath, "utf-8"));
	} catch (error) {
		return { error: `Failed to read structured output: ${error instanceof Error ? error.message : String(error)}` };
	}
	const validation = await validateStructuredOutputValue(runtime.schema, value);
	if (validation.status === "invalid") return { error: `Structured output validation failed: ${validation.message}` };
	return { value };
}

export function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): void {
	if (!runtime) return;
	try {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	} catch {
		// Best-effort temp cleanup.
	}
}
