#!/usr/bin/env python3
"""Mutation-check invocation model defaults in a disposable source copy.

Never edits the working tree or runs providers. Logs and typecheck deltas are
kept under tmp/. Use --typecheck to compare diagnostics against HEAD as well.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HELPER = "src/runs/shared/invocation-model.ts"
EXECUTOR = "src/runs/foreground/subagent-executor.ts"
TESTS = ["test/unit/invocation-model.test.ts", "test/integration/invocation-model.test.ts"]
MUTATIONS = [
    ("routing-bypass", EXECUTOR,
     "applyInvocationModelDefaults(normalizedTimeouts.params!)", "normalizedTimeouts.params!"),
    ("append-routing-bypass", EXECUTOR,
     "params: applyInvocationModelDefaults(paramsWithResolvedCwd), requestCwd, ctx, deps",
     "params: paramsWithResolvedCwd, requestCwd, ctx, deps"),
    ("overwrite-explicit", HELPER,
     "entry.model === undefined ? { ...entry, model } : entry", "({ ...entry, model })"),
    ("drop-task-default", HELPER,
     "params.tasks.map(withDefault)", "params.tasks"),
    ("drop-sequential-default", HELPER,
     "return withDefault(step);", "return step;"),
    ("drop-embedded-parallel-default", HELPER,
     "step.parallel.map(withDefault)", "step.parallel"),
    ("drop-dynamic-default", HELPER,
     "withDefault(step.parallel)", "step.parallel"),
    ("mutate-caller-entry", HELPER,
     "entry.model === undefined ? { ...entry, model } : entry",
     "entry.model === undefined ? Object.assign(entry, { model }) : entry"),
]
# Each mutant must trip its own guarantee, not merely an unrelated assertion.
EXPECTED_FAILURES = {
    "routing-bypass": {"foreground parallel: batch default applies and entry overrides win"},
    "append-routing-bypass": {f"append-step {shape} honors the invocation model and explicit entries"
                              for shape in ("sequential", "parallel", "dynamic")},
    "overwrite-explicit": {"defaults tasks without mutating caller input; explicit inherit and entry models win"},
    "drop-task-default": {"foreground parallel: batch default applies and entry overrides win"},
    "drop-sequential-default": {"foreground sequential chain: batch default applies and entry overrides win"},
    "drop-embedded-parallel-default": {"foreground embedded parallel: batch default applies and entry overrides win"},
    "drop-dynamic-default": {"foreground dynamic fanout materializes the batch default"},
    "mutate-caller-entry": {"defaults tasks without mutating caller input; explicit inherit and entry models win"},
}


def assertion_failures(output: str) -> set[str]:
    """Attribute ERR_ASSERTION to the named TAP test's own diagnostic block."""
    return {match["name"] for match in re.finditer(
        r"^(?P<indent>[ \t]*)not ok \d+ - (?P<name>[^\n]+)\n"
        r"(?P=indent)  ---\n(?P<body>[\s\S]*?)^(?P=indent)  \.\.\.$", output, re.MULTILINE)
        if re.search(r"^" + re.escape(match["indent"]) + r"  code: ['\"]?ERR_ASSERTION['\"]?[ \t]*$",
                     match["body"], re.MULTILINE)}


def mutant_caught(label: str, returncode: int, output: str) -> bool:
    return returncode != 0 and EXPECTED_FAILURES[label].issubset(assertion_failures(output))


BASELINE_TESTS = 20  # `# tests N` for TESTS; fewer means results were lost, not a valid survivor.


def run(cwd: Path, args: list[str], log: Path) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log.write_text(result.stdout)
    return result


def test(cwd: Path, log: Path) -> subprocess.CompletedProcess[str]:
    result = run(cwd, ["node", "--import", "./test/support/register-loader.mjs", "--test",
                       "--test-reporter=tap", *TESTS], log)
    reported = re.search(r"^# tests (\d+)$", result.stdout, re.MULTILINE)
    count = int(reported.group(1)) if reported else 0
    if count < BASELINE_TESTS:
        raise RuntimeError(
            f"the runner reported {count} of {BASELINE_TESTS} tests ({log}); results were lost, so "
            "neither a pass nor a survivor can be concluded from this run")
    return result


def diagnostics(text: str) -> Counter[str]:
    # Ignore shifted line numbers, but retain file, code, message and multiplicity.
    return Counter(f"{m[1]}: {m[2]}: {m[3]}" for m in re.finditer(
        r"^([^\n]+)\(\d+,\d+\): error (TS\d+): (.*)$", text, re.MULTILINE))


def type_delta(sandbox: Path, logs: Path) -> bool:
    compiler = shutil.which("tsc")
    if compiler is None:
        raise RuntimeError("TypeScript compiler not found on PATH")
    fixed = run(sandbox, [compiler, "--noEmit"], logs / "types-fixed.log")
    if fixed.returncode not in (0, 2):
        raise RuntimeError(f"typecheck failed to run: {fixed.stdout[:500]}")
    # Restore tracked source/tests from HEAD in this copy only; remove new files.
    for directory in ("src", "test"):
        shutil.rmtree(sandbox / directory)
    names = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "HEAD", "src", "test"], cwd=ROOT, text=True)
    for name in names.splitlines():
        target = sandbox / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(subprocess.check_output(["git", "show", f"HEAD:{name}"], cwd=ROOT))
    baseline = run(sandbox, [compiler, "--noEmit"], logs / "types-head.log")
    if baseline.returncode not in (0, 2):
        raise RuntimeError(f"baseline typecheck failed to run: {baseline.stdout[:500]}")
    added = diagnostics(fixed.stdout) - diagnostics(baseline.stdout)
    (logs / "types-delta.json").write_text(json.dumps(dict(added), indent=2) + "\n")
    print(f"Typecheck: HEAD={sum(diagnostics(baseline.stdout).values())}, fixed={sum(diagnostics(fixed.stdout).values())}, new={sum(added.values())}", flush=True)
    for issue, count in added.items():
        print(f"  {count}x {issue}", flush=True)
    return not added


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--typecheck", action="store_true", help="also compare repository TypeScript diagnostics with HEAD")
    parser.add_argument("--typecheck-only", action="store_true")
    parser.add_argument("--mutant", choices=[entry[0] for entry in MUTATIONS], help="run one mutation")
    args = parser.parse_args()
    (ROOT / "tmp").mkdir(exist_ok=True)
    logs = Path(tempfile.mkdtemp(prefix="invocation-model-check-", dir=ROOT / "tmp"))
    print(f"Logs: {logs}", flush=True)
    failed = False
    with tempfile.TemporaryDirectory(prefix="sandbox-", dir=logs) as directory:
        sandbox = Path(directory)
        for name in ("src", "test"):
            shutil.copytree(ROOT / name, sandbox / name)
        for name in ("package.json", "tsconfig.json"):
            shutil.copy2(ROOT / name, sandbox / name)
        (sandbox / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        if not args.typecheck_only:
            baseline = test(sandbox, logs / "baseline.log")
            if baseline.returncode:
                raise RuntimeError(f"unmutated tests failed; see {logs / 'baseline.log'}")
            print("Baseline: PASS", flush=True)
            for label, filename, old, new in MUTATIONS:
                if args.mutant and label != args.mutant:
                    continue
                target = sandbox / filename
                original = target.read_text()
                if original.count(old) != 1:
                    raise RuntimeError(f"{label}: expected unique anchor")
                try:
                    target.write_text(original.replace(old, new))
                    result = test(sandbox, logs / f"{label}.log")
                finally:
                    target.write_text(original)
                names = re.findall(r"^\s*not ok \d+ - (.+)$", result.stdout, re.MULTILINE)
                caught = mutant_caught(label, result.returncode, result.stdout)
                failed |= not caught
                print(f"{label}: {'CAUGHT' if caught else 'SURVIVED/INVALID'}", flush=True)
                print(f"  failing: {'; '.join(names)}", flush=True)
        if args.typecheck or args.typecheck_only:
            failed |= not type_delta(sandbox, logs)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
