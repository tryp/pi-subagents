#!/usr/bin/env python3
"""Revert each compaction-abort recovery guarantee in an isolated source copy.

Each mutant runs only the named unit or background integration test that must
observe it. The source checkout is never edited; each temporary project copy
contains src/ and test/ plus a dependency link to this checkout's node_modules.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node") or "node"


@dataclass(frozen=True)
class Mutation:
    name: str
    source: str
    old: str
    new: str
    test_command: tuple[str, ...]
    expected_test: str


MUTATIONS = [
    Mutation(
        name="SIGKILL remains authoritative",
        source="src/runs/shared/abort-recovery.ts",
        old='''\tif (input.processSignal && !(input.processSignal === "SIGTERM" && compactionAbortCandidate)) {
\t\treturn settle(`process terminated by signal: ${input.processSignal}`);
\t}''',
        new='''\tif (input.processSignal && !compactionAbortCandidate) return settle("process terminated by signal");''',
        test_command=("test/unit/abort-recovery.test.ts", "exempts only the runner drain SIGTERM for a verified compaction abort candidate"),
        expected_test="exempts only the runner drain SIGTERM for a verified compaction abort candidate",
    ),
    Mutation(
        name="missing structured output blocks recovery",
        source="src/runs/background/subagent-runner.ts",
        old="structuredOutputFailed: attempt.structuredOutputFailed === true,",
        new="structuredOutputFailed: false,",
        test_command=("test/integration/async-execution.test.ts", "background refuses abort recovery when required structured output is missing"),
        expected_test="background refuses abort recovery when required structured output is missing",
    ),
    Mutation(
        name="post-resume abort has distinct non-retryable classification",
        source="src/runs/shared/compaction-tail.ts",
        old='? input.recoveryAttempted ? "compacted_abort_after_resume" : "compacted_then_aborted"',
        new='? "compacted_then_aborted"',
        test_command=("test/unit/compaction-tail.test.ts", "classifies a second abort after the one recovery as non-retryable"),
        expected_test="classifies a second abort after the one recovery as non-retryable",
    ),

    Mutation(
        name="marker never set",
        source="src/runs/shared/abort-recovery.ts",
        old='''\t\tif (event.type === "compaction_start") {
\t\t\tthis.compactionTimes.push(observedAt);
\t\t\tthis.recompute();
\t\t}''',
        new='''\t\tif (event.type === "compaction_start") {
\t\t\tthis.recompute();
\t\t}''',
        test_command=("test/unit/abort-recovery.test.ts", "recognizes the observed settle-then-manual-compaction order"),
        expected_test="recognizes the observed settle-then-manual-compaction order",
    ),
    Mutation(
        name="nearest compaction replaced by latest",
        source="src/runs/shared/abort-recovery.ts",
        old='''\t\tconst nearestDistance = this.compactionTimes.reduce(
\t\t\t(nearest, at) => Math.min(nearest, Math.abs(settlementAt - at)),
\t\t\tNumber.POSITIVE_INFINITY,
\t\t);''',
        new='''\t\tconst nearestDistance = this.compactionTimes.length > 0
\t\t\t? Math.abs(settlementAt - this.compactionTimes[this.compactionTimes.length - 1])
\t\t\t: Number.POSITIVE_INFINITY;''',
        test_command=("test/unit/abort-recovery.test.ts", "uses the nearest compaction to the last settlement"),
        expected_test="uses the nearest compaction to the last settlement",
    ),
    Mutation(
        name="marker not reset on agent_start",
        source="src/runs/shared/abort-recovery.ts",
        old='''\t\tif (event.type === "agent_start" || event.type === "auto_retry_start") {
\t\t\tthis.reset();
\t\t\treturn;
\t\t}''',
        new='''\t\tif (event.type === "agent_start" || event.type === "auto_retry_start") {
\t\t\tthis.verified = false;
\t\t\treturn;
\t\t}''',
        test_command=("test/unit/abort-recovery.test.ts", "resets on a new agent turn, auto-retry"),
        expected_test="resets on a new agent turn, auto-retry",
    ),
    Mutation(
        name="resume allowed twice",
        source="src/runs/shared/abort-recovery.ts",
        old='\tif (input.alreadyResumed) return settle("resume already attempted");\n',
        new='',
        test_command=("test/unit/abort-recovery.test.ts", "settles a second abort once with the unsafe-recovery diagnostic"),
        expected_test="settles a second abort once with the unsafe-recovery diagnostic",
    ),
    Mutation(
        name="sessionAvailable gate removed",
        source="src/runs/shared/abort-recovery.ts",
        old='\tif (!input.sessionAvailable) return settle("retained session unavailable");\n',
        new='',
        test_command=("test/unit/abort-recovery.test.ts", "fails closed for every refusal gate"),
        expected_test="fails closed for every refusal gate",
    ),
    Mutation(
        name="afterCompactionSettlement gate removed",
        source="src/runs/shared/abort-recovery.ts",
        old='\tif (!input.afterCompactionSettlement) return settle("compaction settlement not verified");\n',
        new='',
        test_command=("test/unit/abort-recovery.test.ts", "fails closed for every refusal gate"),
        expected_test="fails closed for every refusal gate",
    ),
    Mutation(
        name="diagnostic dropped on settle",
        source="src/runs/shared/abort-recovery.ts",
        old='\t\t...(compactionAbortCandidate\n\t\t\t? { diagnostic: `Compaction-induced child abort could not be resumed safely: ${reason}.` }\n\t\t\t: {}),\n',
        new='',
        test_command=("test/unit/abort-recovery.test.ts", "carries a recovery diagnostic when a verified compaction abort cannot safely resume"),
        expected_test="carries a recovery diagnostic when a verified compaction abort cannot safely resume",
    ),
]


def node_test(test_path: str, test_name: str) -> tuple[str, ...]:
    return (
        NODE,
        "--experimental-strip-types",
        "--test",
        f"--test-name-pattern={test_name}",
        test_path,
    )


def make_project_copy(directory: Path) -> None:
    directory.mkdir(parents=True)
    shutil.copytree(ROOT / "src", directory / "src", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(ROOT / "test", directory / "test", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copy2(ROOT / "package.json", directory / "package.json")
    node_modules = ROOT / "node_modules"
    if node_modules.exists():
        (directory / "node_modules").symlink_to(node_modules, target_is_directory=True)


def run_test(directory: Path, test_path: str, test_name: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        node_test(test_path, test_name),
        cwd=directory,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def main() -> int:
    failed = 0
    for mutation in MUTATIONS:
        test_path, test_name = mutation.test_command
        source_path = ROOT / mutation.source
        source = source_path.read_text(encoding="utf-8")
        if source.count(mutation.old) != 1:
            print(f"ANCHOR {mutation.name}: expected one mutation target, found {source.count(mutation.old)}")
            failed += 1
            continue

        baseline = subprocess.run(
            node_test(test_path, test_name),
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        if baseline.returncode != 0:
            print(f"ANCHOR baseline failed for {mutation.expected_test}")
            print(baseline.stdout[-3000:])
            failed += 1
            continue

        with tempfile.TemporaryDirectory(prefix="pi-subagent-abort-mutcheck-") as temp:
            project = Path(temp) / "project"
            make_project_copy(project)
            mutant_path = project / mutation.source
            mutant_source = (ROOT / mutation.source).read_text(encoding="utf-8")
            mutant_path.write_text(mutant_source.replace(mutation.old, mutation.new, 1), encoding="utf-8")
            result = run_test(project, test_path, test_name)
            test_failed = result.returncode != 0 and re.search(
                rf"(?:✖|not ok).*{re.escape(mutation.expected_test)}",
                result.stdout,
                flags=re.IGNORECASE,
            ) is not None
            if test_failed:
                print(f"CAUGHT {mutation.name} | failing test id: {mutation.expected_test}")
            else:
                print(f"SURVIVED {mutation.name} | expected failure: {mutation.expected_test}")
                if result.stdout:
                    print(result.stdout[-3000:])
                failed += 1

    print(f"RESULT caught={len(MUTATIONS) - failed} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
