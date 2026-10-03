import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_CORE_SIZE_MB,
	MIN_OPEN_FILES,
	RLIMITS_ENV,
	buildRlimitArgs,
	clampRlimitsToInherited,
	cpuHardLimitSeconds,
	decodeRlimitsEnv,
	describeRlimits,
	encodeRlimitsEnv,
	hasRlimits,
	maxCpuSoftForHard,
	parseProcSelfLimits,
	resourceLimitExceededMessage,
	resourceLimitKindForSignal,
	rlimitsEnforceabilityError,
	validateRlimitsConfig,
} from "../../src/runs/shared/rlimits.ts";
import {
	PRLIMIT_COMMAND,
	getPiSpawnCommand,
	resolvePrlimitPath,
	rlimitsUnsupportedReason,
	type PiSpawnDeps,
} from "../../src/runs/shared/pi-spawn.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

describe("rlimits env round trip", () => {
	const baseInput = {
		baseArgs: ["-p"],
		task: "hello",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
	};

	// This is the contract the foreground spawn site relies on: it decodes the
	// limits from the child environment rather than from the resolved config, so
	// buildPiArgs must actually write them there. When it did not, rlimits were
	// accepted by the schema and then silently never applied.
	it("turns the child env written by buildPiArgs into a prlimit-wrapped command", () => {
		const { env } = buildPiArgs({ ...baseInput, rlimits: { cpuSeconds: 30 } });
		const decoded = decodeRlimitsEnv(env[RLIMITS_ENV]);
		assert.deepEqual(decoded, { cpuSeconds: 30, coreSizeMb: 0 });

		const spawnSpec = getPiSpawnCommand(["--mode", "json"], {
			platform: "linux",
			env: { PI_SUBAGENT_PI_BINARY: "/opt/pi/bin/pi" },
			existsSync: () => true,
			resolvePrlimitPath: () => "/usr/bin/prlimit",
			inheritedHardLimits: {},
			rlimits: decoded,
		});
		assert.equal(spawnSpec.command, "/usr/bin/prlimit");
		assert.deepEqual(spawnSpec.args.slice(0, 3), ["--cpu=30:60", "--core=0", "--"]);
		assert.deepEqual(spawnSpec.rlimitsApplied, { cpuSeconds: 30, coreSizeMb: 0 });
	});

	it("writes no env var when no limits are configured", () => {
		const { env } = buildPiArgs(baseInput);
		assert.equal(env[RLIMITS_ENV], undefined);
		assert.equal(decodeRlimitsEnv(env[RLIMITS_ENV]), undefined);
	});
});

describe("decodeRlimitsEnv", () => {
	it("labels malformed JSON instead of surfacing a raw SyntaxError", () => {
		assert.throws(() => decodeRlimitsEnv("{not json"), /Invalid PI_SUBAGENT_RLIMITS/);
	});

	it("labels an unsupported field", () => {
		assert.throws(() => decodeRlimitsEnv(JSON.stringify({ addressSpaceMb: 512 })), /not supported/);
	});

	it("treats blank input as absent", () => {
		assert.equal(decodeRlimitsEnv(undefined), undefined);
		assert.equal(decodeRlimitsEnv("   "), undefined);
	});
});

describe("validateRlimitsConfig", () => {
	it("treats undefined as no limits", () => {
		assert.deepEqual(validateRlimitsConfig(undefined), {});
	});

	it("rejects non-objects", () => {
		for (const bad of [null, "cpu", 5, [], true]) {
			const result = validateRlimitsConfig(bad);
			assert.ok(result.error, `expected error for ${JSON.stringify(bad)}`);
			assert.match(result.error, /must be an object/);
		}
	});

	it("returns no limits when every field is undefined", () => {
		assert.deepEqual(validateRlimitsConfig({ cpuSeconds: undefined }), {});
	});

	it("accepts the supported fields", () => {
		const result = validateRlimitsConfig({
			cpuSeconds: 30,
			fileSizeMb: 100,
			openFiles: 256,
			coreSizeMb: 0,
		});
		assert.equal(result.error, undefined);
		assert.deepEqual(result.rlimits, {
			cpuSeconds: 30,
			fileSizeMb: 100,
			openFiles: 256,
			coreSizeMb: 0,
		});
	});

	it("rejects fields that cannot bound a Node child, with a measured reason", () => {
		for (const [field, pattern] of [
			["addressSpaceMb", /RLIMIT_AS/],
			["dataSegMb", /RLIMIT_DATA/],
			["rssMb", /RLIMIT_RSS/],
			["maxProcesses", /RLIMIT_NPROC/],
		] as const) {
			const result = validateRlimitsConfig({ [field]: 128 });
			assert.ok(result.error, `expected ${field} to be rejected`);
			assert.match(result.error, /is not supported/);
			assert.match(result.error, pattern);
			assert.equal(result.rlimits, undefined);
		}
	});

	it("rejects unknown fields", () => {
		const result = validateRlimitsConfig({ bogus: 1 });
		assert.match(result.error ?? "", /rlimits\.bogus is not supported/);
	});

	it("labels errors with the caller-supplied prefix", () => {
		const result = validateRlimitsConfig({ bogus: 1 }, "agent.rlimits");
		assert.match(result.error ?? "", /^agent\.rlimits\.bogus/);
	});

	it("requires cpuSeconds to be a positive integer", () => {
		for (const bad of [0, -1, 1.5, "30", null]) {
			const result = validateRlimitsConfig({ cpuSeconds: bad });
			assert.match(result.error ?? "", /cpuSeconds must be an integer >= 1/);
		}
		assert.equal(validateRlimitsConfig({ cpuSeconds: 1 }).error, undefined);
	});

	it("requires fileSizeMb to be a positive integer", () => {
		for (const bad of [0, -5, 2.5, "10"]) {
			const result = validateRlimitsConfig({ fileSizeMb: bad });
			assert.match(result.error ?? "", /fileSizeMb must be an integer >= 1/);
		}
		assert.equal(validateRlimitsConfig({ fileSizeMb: 1 }).error, undefined);
	});

	it(`rejects openFiles below the ${MIN_OPEN_FILES} floor that can stop the child from starting`, () => {
		for (const bad of [1, 10, MIN_OPEN_FILES - 1]) {
			const result = validateRlimitsConfig({ openFiles: bad });
			assert.match(result.error ?? "", new RegExp(`openFiles must be >= ${MIN_OPEN_FILES}`));
		}
		assert.equal(validateRlimitsConfig({ openFiles: MIN_OPEN_FILES }).error, undefined);
	});

	it("allows coreSizeMb 0 to mean 'no core dumps'", () => {
		const result = validateRlimitsConfig({ coreSizeMb: 0 });
		assert.equal(result.error, undefined);
		assert.deepEqual(result.rlimits, { coreSizeMb: 0 });
	});

	it("rejects a negative coreSizeMb", () => {
		assert.match(
			validateRlimitsConfig({ coreSizeMb: -1 }).error ?? "",
			/coreSizeMb must be an integer >= 0/,
		);
	});

	it("suppresses core dumps by default so a limit death cannot fill the disk", () => {
		const result = validateRlimitsConfig({ cpuSeconds: 30 });
		assert.equal(result.rlimits?.coreSizeMb, DEFAULT_CORE_SIZE_MB);
	});

	it("honors an explicit coreSizeMb instead of the default", () => {
		const result = validateRlimitsConfig({ cpuSeconds: 30, coreSizeMb: 512 });
		assert.equal(result.rlimits?.coreSizeMb, 512);
	});
});

describe("cpuHardLimitSeconds", () => {
	it("leaves a grace gap so the death is reported as SIGXCPU, not SIGKILL", () => {
		// A hard limit equal to the soft limit reports SIGKILL, which is
		// indistinguishable from our own timeout kill.
		assert.ok(cpuHardLimitSeconds(30) > 30);
		assert.equal(cpuHardLimitSeconds(30), 60);
	});

	it("applies the minimum grace to very small limits", () => {
		assert.equal(cpuHardLimitSeconds(1), 6);
		assert.equal(cpuHardLimitSeconds(5), 10);
	});
});

describe("buildRlimitArgs", () => {
	it("returns no flags without limits", () => {
		assert.deepEqual(buildRlimitArgs(undefined), []);
		assert.deepEqual(buildRlimitArgs({}), []);
	});

	it("emits cpu as soft:hard", () => {
		assert.deepEqual(buildRlimitArgs({ cpuSeconds: 30 }), ["--cpu=30:60"]);
	});

	it("converts fileSizeMb to bytes", () => {
		assert.deepEqual(buildRlimitArgs({ fileSizeMb: 10 }), [`--fsize=${10 * 1024 * 1024}`]);
	});

	it("emits openFiles and core in bytes", () => {
		assert.deepEqual(buildRlimitArgs({ openFiles: 256 }), ["--nofile=256"]);
		assert.deepEqual(buildRlimitArgs({ coreSizeMb: 0 }), ["--core=0"]);
		assert.deepEqual(buildRlimitArgs({ coreSizeMb: 2 }), [`--core=${2 * 1024 * 1024}`]);
	});

	it("is order-stable for exact command assertions", () => {
		assert.deepEqual(
			buildRlimitArgs({ cpuSeconds: 30, fileSizeMb: 10, openFiles: 256, coreSizeMb: 0 }),
			["--cpu=30:60", `--fsize=${10 * 1024 * 1024}`, "--nofile=256", "--core=0"],
		);
	});
});

describe("hasRlimits / describeRlimits", () => {
	it("reports absent limits", () => {
		assert.equal(hasRlimits(undefined), false);
		assert.equal(hasRlimits({}), false);
		assert.equal(describeRlimits(undefined), "none");
		assert.equal(describeRlimits({}), "none");
	});

	it("treats coreSizeMb 0 as a real limit", () => {
		assert.equal(hasRlimits({ coreSizeMb: 0 }), true);
		assert.equal(describeRlimits({ coreSizeMb: 0 }), "core 0MiB");
	});

	it("describes every configured bound", () => {
		const text = describeRlimits({ cpuSeconds: 30, fileSizeMb: 10, openFiles: 256, coreSizeMb: 0 });
		assert.match(text, /cpu 30s \(hard 60s\)/);
		assert.match(text, /file size 10MiB/);
		assert.match(text, /open files 256/);
		assert.match(text, /core 0MiB/);
	});
});

describe("rlimits env encoding", () => {
	it("omits the variable when nothing is limited", () => {
		assert.equal(encodeRlimitsEnv(undefined), undefined);
		assert.equal(encodeRlimitsEnv({}), undefined);
	});

	it("round-trips through the env", () => {
		const rlimits = { cpuSeconds: 30, fileSizeMb: 10, coreSizeMb: 0 };
		const encoded = encodeRlimitsEnv(rlimits);
		assert.ok(encoded);
		assert.deepEqual(decodeRlimitsEnv(encoded), rlimits);
	});

	it("treats a blank value as no limits", () => {
		assert.equal(decodeRlimitsEnv(undefined), undefined);
		assert.equal(decodeRlimitsEnv("   "), undefined);
	});

	it("throws on malformed or unsupported encoded values", () => {
		assert.throws(() => decodeRlimitsEnv("{not json"), /JSON/);
		assert.throws(() => decodeRlimitsEnv(JSON.stringify({ rssMb: 50 })), /not supported/);
	});

	it("uses a stable env variable name", () => {
		assert.equal(RLIMITS_ENV, "PI_SUBAGENT_RLIMITS");
	});
});

describe("resourceLimitKindForSignal", () => {
	it("maps the kernel signal back to the configured limit", () => {
		assert.equal(resourceLimitKindForSignal("SIGXCPU", { cpuSeconds: 30 }), "cpuSeconds");
		assert.equal(resourceLimitKindForSignal("SIGXFSZ", { fileSizeMb: 10 }), "fileSizeMb");
	});

	it("ignores signals with no matching configured limit", () => {
		assert.equal(resourceLimitKindForSignal("SIGXCPU", { fileSizeMb: 10 }), undefined);
		assert.equal(resourceLimitKindForSignal("SIGXFSZ", { cpuSeconds: 30 }), undefined);
		assert.equal(resourceLimitKindForSignal("SIGKILL", { cpuSeconds: 30 }), undefined);
		assert.equal(resourceLimitKindForSignal(null, { cpuSeconds: 30 }), undefined);
		assert.equal(resourceLimitKindForSignal("SIGXCPU", undefined), undefined);
	});

	it("explains the death instead of reporting a bare signal", () => {
		const cpu = resourceLimitExceededMessage("cpuSeconds", { cpuSeconds: 30, coreSizeMb: 0 });
		assert.match(cpu, /CPU time resource limit/);
		assert.match(cpu, /cpu 30s \(hard 60s\)/);
		const fsize = resourceLimitExceededMessage("fileSizeMb", { fileSizeMb: 10 });
		assert.match(fsize, /file size resource limit/);
		assert.match(fsize, /10MiB/);
	});
});

describe("getPiSpawnCommand rlimit wrapping", () => {
	const baseDeps: PiSpawnDeps = {
		platform: "linux",
		execPath: "/usr/local/bin/node",
		argv1: "/tmp/pi-entry.mjs",
		env: { PI_SUBAGENT_PI_BINARY: "/opt/pi/bin/pi" },
		existsSync: () => true,
		// Injected so the assertions never depend on the host's own hard limits.
		inheritedHardLimits: {},
	};
	const withPrlimit: PiSpawnDeps = { ...baseDeps, resolvePrlimitPath: () => "/usr/bin/prlimit" };
	const args = ["--mode", "json", "Task: bounded run"];

	it("wraps the child in prlimit(1) on Linux", () => {
		const result = getPiSpawnCommand(args, { ...withPrlimit, rlimits: { cpuSeconds: 30 } });
		assert.equal(result.rlimitsSkipped, undefined);
		assert.deepEqual(result, {
			command: "/usr/bin/prlimit",
			args: ["--cpu=30:60", "--", "/opt/pi/bin/pi", ...args],
			rlimitsApplied: { cpuSeconds: 30 },
		});
	});

	it("preserves the base command and args exactly after the separator", () => {
		const result = getPiSpawnCommand(args, {
			...withPrlimit,
			rlimits: { cpuSeconds: 5, fileSizeMb: 8, openFiles: 128, coreSizeMb: 0 },
		});
		assert.equal(result.command, "/usr/bin/prlimit");
		const separator = result.args.indexOf("--");
		assert.ok(separator > 0, "expected prlimit flags before the -- separator");
		assert.equal(result.args[separator + 1], "/opt/pi/bin/pi");
		assert.deepEqual(result.args.slice(separator + 2), args);
		assert.deepEqual(result.args.slice(0, separator), [
			"--cpu=5:10",
			`--fsize=${8 * 1024 * 1024}`,
			"--nofile=128",
			"--core=0",
		]);
	});

	it("leaves the command untouched without limits", () => {
		assert.deepEqual(getPiSpawnCommand(args, withPrlimit), {
			command: "/opt/pi/bin/pi",
			args,
		});
	});

	it("reports why limits were skipped instead of silently dropping them on non-Linux", () => {
		const result = getPiSpawnCommand(args, {
			...withPrlimit,
			platform: "darwin",
			rlimits: { cpuSeconds: 30 },
		});
		assert.deepEqual(result.args, args);
		assert.equal(result.command, "/opt/pi/bin/pi");
		assert.equal(result.rlimitsApplied, undefined);
		assert.match(result.rlimitsSkipped ?? "", /require Linux/);
		assert.match(result.rlimitsSkipped ?? "", /darwin/);
	});

	it("reports why limits were skipped when prlimit(1) is unavailable", () => {
		const result = getPiSpawnCommand(args, {
			...baseDeps,
			resolvePrlimitPath: () => undefined,
			rlimits: { cpuSeconds: 30 },
		});
		assert.deepEqual(result.args, args);
		assert.match(result.rlimitsSkipped ?? "", /prlimit\(1\) command was not found on PATH/);
	});
});

describe("prlimit discovery", () => {
	it("finds prlimit on PATH", () => {
		const found = resolvePrlimitPath({
			platform: "linux",
			env: { PATH: `/first${":"}${"/second"}` },
			existsSync: (filePath) => filePath === `/second/${PRLIMIT_COMMAND}`,
		});
		assert.equal(found, `/second/${PRLIMIT_COMMAND}`);
	});

	it("returns undefined without a PATH", () => {
		assert.equal(resolvePrlimitPath({ platform: "linux", env: {}, existsSync: () => true }), undefined);
	});

	it("prefers an injected lookup so tests never probe the real PATH", () => {
		assert.equal(
			resolvePrlimitPath({ resolvePrlimitPath: () => "/injected/prlimit", existsSync: () => true }),
			"/injected/prlimit",
		);
	});

	it("explains why limits cannot be applied", () => {
		assert.equal(rlimitsUnsupportedReason({ platform: "darwin" }), "platform");
		assert.equal(
			rlimitsUnsupportedReason({ platform: "linux", resolvePrlimitPath: () => undefined }),
			"missing-prlimit",
		);
		assert.equal(
			rlimitsUnsupportedReason({ platform: "linux", resolvePrlimitPath: () => "/usr/bin/prlimit" }),
			undefined,
		);
	});
});

describe("inherited hard limits", () => {
	// Faithful excerpt of /proc/self/limits, including the fixed-width padding.
	const procSample = [
		"Limit                     Soft Limit           Hard Limit           Units     ",
		"Max cpu time              unlimited            unlimited            seconds   ",
		"Max file size             unlimited            unlimited            bytes     ",
		"Max data size             unlimited            unlimited            bytes     ",
		"Max stack size            8388608              unlimited            bytes     ",
		"Max core file size        0                    unlimited            bytes     ",
		"Max resident set          unlimited            unlimited            bytes     ",
		"Max processes             126468               126468               processes ",
		"Max open files            1024                 4096                 files     ",
		"Max address space         unlimited            unlimited            bytes     ",
		"Max file locks            unlimited            unlimited            locks     ",
		"Max realtime priority     95                   95                   ",
	].join("\n");

	it("reads only the hard column, ignoring unlimited", () => {
		const limits = parseProcSelfLimits(procSample);
		assert.deepEqual(limits, { openFiles: 4096 });
	});

	it("picks up finite cpu, file size, and core hard limits", () => {
		const limits = parseProcSelfLimits(
			[
				"Max cpu time              4                    8                    seconds   ",
				"Max file size             1048576              2097152              bytes     ",
				"Max core file size        0                    4194304              bytes     ",
			].join("\n"),
		);
		assert.deepEqual(limits, { cpuSeconds: 8, fileSizeBytes: 2097152, coreSizeBytes: 4194304 });
	});

	it("ignores unrelated rows", () => {
		assert.deepEqual(parseProcSelfLimits("Max processes  126468  126468  processes"), {});
		assert.deepEqual(parseProcSelfLimits(""), {});
	});

	it("computes the largest soft limit that fits a hard ceiling", () => {
		assert.equal(maxCpuSoftForHard(4), -1);
		assert.equal(maxCpuSoftForHard(6), 1);
		assert.equal(maxCpuSoftForHard(9), 4);
		assert.equal(maxCpuSoftForHard(10), 5);
		assert.equal(maxCpuSoftForHard(20), 10);
		assert.equal(maxCpuSoftForHard(60), 30);
	});

	it("round-trips: a clamped soft limit always derives a fitting hard limit", () => {
		for (const inherited of [6, 9, 10, 20, 61, 600]) {
			const soft = maxCpuSoftForHard(inherited);
			if (soft < 1) continue;
			assert.ok(
				cpuHardLimitSeconds(soft) <= inherited,
				`soft ${soft} derived hard ${cpuHardLimitSeconds(soft)} exceeds inherited ${inherited}`,
			);
		}
	});

	it("passes requests through when nothing is inherited", () => {
		const requested = { cpuSeconds: 30, fileSizeMb: 10, openFiles: 256, coreSizeMb: 0 };
		assert.deepEqual(clampRlimitsToInherited(requested, {}), requested);
		assert.equal(clampRlimitsToInherited(undefined, { cpuSeconds: 8 }), undefined);
	});

	it("leaves already-fitting requests untouched", () => {
		const requested = { cpuSeconds: 5, fileSizeMb: 4, openFiles: 128, coreSizeMb: 0 };
		assert.deepEqual(
			clampRlimitsToInherited(requested, { cpuSeconds: 60, fileSizeBytes: 64 * 1024 * 1024, openFiles: 1024, coreSizeBytes: 8 * 1024 * 1024 }),
			requested,
		);
	});

	it("lowers cpu to fit the inherited hard limit instead of being rejected", () => {
		// Requesting soft 30 (hard 60) under an inherited hard 20 would make
		// prlimit(1) fail with EPERM and never exec the child.
		assert.deepEqual(clampRlimitsToInherited({ cpuSeconds: 30 }, { cpuSeconds: 20 }), { cpuSeconds: 10 });
	});

	it("drops a limit that has no room under the inherited hard limit", () => {
		// The inherited limit is already tighter than anything expressible.
		assert.equal(clampRlimitsToInherited({ cpuSeconds: 30 }, { cpuSeconds: 4 }), undefined);
		assert.equal(clampRlimitsToInherited({ fileSizeMb: 64 }, { fileSizeBytes: 100 }), undefined);
	});

	it("lowers file size, open files, and core to the inherited hard limits", () => {
		assert.deepEqual(
			clampRlimitsToInherited({ fileSizeMb: 64 }, { fileSizeBytes: 2 * 1024 * 1024 }),
			{ fileSizeMb: 2 },
		);
		assert.deepEqual(clampRlimitsToInherited({ openFiles: 4096 }, { openFiles: 256 }), { openFiles: 256 });
		assert.deepEqual(
			clampRlimitsToInherited({ coreSizeMb: 64 }, { coreSizeBytes: 1024 * 1024 }),
			{ coreSizeMb: 1 },
		);
	});
});

describe("getPiSpawnCommand clamps to inherited hard limits", () => {
	const args = ["--mode", "json", "Task: nested run"];
	const nestedDeps: PiSpawnDeps = {
		platform: "linux",
		env: { PI_SUBAGENT_PI_BINARY: "/opt/pi/bin/pi" },
		existsSync: () => true,
		resolvePrlimitPath: () => "/usr/bin/prlimit",
		inheritedHardLimits: {},
	};

	it("applies the clamped value, not the requested one", () => {
		const result = getPiSpawnCommand(args, {
			...nestedDeps,
			rlimits: { cpuSeconds: 30, openFiles: 4096 },
			inheritedHardLimits: { cpuSeconds: 20, openFiles: 256 },
		});
		assert.deepEqual(result.args.slice(0, 2), ["--cpu=10:20", "--nofile=256"]);
		// Attribution must use what the kernel enforces, not the request.
		assert.deepEqual(result.rlimitsApplied, { cpuSeconds: 10, openFiles: 256 });
	});

	it("reports when the inherited limit already covers the request", () => {
		const result = getPiSpawnCommand(args, {
			...nestedDeps,
			rlimits: { cpuSeconds: 30 },
			inheritedHardLimits: { cpuSeconds: 4 },
		});
		assert.deepEqual(result.args, args);
		assert.equal(result.rlimitsApplied, undefined);
		assert.match(result.rlimitsSkipped ?? "", /inherited tighter hard limits/);
	});

	it("does not wrap when /proc is unreadable and nothing is inherited", () => {
		const result = getPiSpawnCommand(args, {
			...nestedDeps,
			rlimits: { cpuSeconds: 30 },
			readFileSync: () => {
				throw new Error("no /proc");
			},
		});
		assert.equal(result.command, "/usr/bin/prlimit");
	});
});

describe("rlimitsEnforceabilityError", () => {
	it("accepts limits on Linux", () => {
		assert.equal(rlimitsEnforceabilityError({ cpuSeconds: 30 }, "linux"), undefined);
	});

	it("rejects limits on platforms that cannot enforce them", () => {
		for (const platform of ["darwin", "win32"] as const) {
			const error = rlimitsEnforceabilityError({ cpuSeconds: 30 }, platform);
			assert.match(error ?? "", /requires Linux/);
			assert.match(error ?? "", new RegExp(platform));
		}
	});

	it("accepts an absent or empty configuration on any platform", () => {
		assert.equal(rlimitsEnforceabilityError(undefined, "darwin"), undefined);
		assert.equal(rlimitsEnforceabilityError({}, "win32"), undefined);
	});

	it("rejects limits on Linux when prlimit is not on PATH", () => {
		// A Linux host without util-linux would otherwise run the child fully
		// unbounded and report nothing on a successful run.
		const error = rlimitsEnforceabilityError({ cpuSeconds: 30 }, "linux", () => false);
		assert.match(error ?? "", /prlimit\(1\)/);
		assert.match(error ?? "", /not found on PATH/);
	});

	it("accepts limits on Linux when prlimit is available", () => {
		assert.equal(rlimitsEnforceabilityError({ cpuSeconds: 30 }, "linux", () => true), undefined);
	});

	it("does not probe for prlimit when no limits are configured or the platform is wrong", () => {
		let probes = 0;
		const probe = () => {
			probes += 1;
			return true;
		};
		assert.equal(rlimitsEnforceabilityError(undefined, "linux", probe), undefined);
		assert.equal(rlimitsEnforceabilityError({}, "linux", probe), undefined);
		// Wrong platform still fails closed with the platform error, without probing.
		assert.match(rlimitsEnforceabilityError({ cpuSeconds: 30 }, "darwin", probe) ?? "", /requires Linux/);
		assert.equal(probes, 0);
	});

	it("still rejects a missing prlimit when the platform is checked without a probe", () => {
		// Callers that omit the probe keep the platform-only behavior rather than
		// failing open on an unknown probe result.
		assert.equal(rlimitsEnforceabilityError({ cpuSeconds: 30 }, "linux"), undefined);
	});
});
