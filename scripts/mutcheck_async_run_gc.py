#!/usr/bin/env python3
"""Revert each async-run GC startup guarantee in an isolated source copy.

The sweep is the largest single-threaded job on pi's startup path: before this
work it blocked the interactive TUI for ~2.5s, two seconds after launch. The
guarantees below are the ones a future edit can quietly drop, so each is
reverted in a temporary project copy and the named unit test must fail.

A `SURVIVED` row means the test no longer pins the property. The cost
regression itself (per-pair path.resolve in the /proc scan) is deliberately not
a mutation row: no unit test measures elapsed time, and the instrument for that
claim is scripts/bench-async-gc.ts --scan-fds.
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
RETENTION = "src/runs/background/async-run-retention.ts"
TEST_PATH = "test/unit/async-run-retention.test.ts"


@dataclass(frozen=True)
class Mutation:
    name: str
    source: str
    old: str
    new: str
    expected_test: str


MUTATIONS = [
    Mutation(
        name="sweep runs inline on the main thread again",
        source=RETENTION,
        old="\t\tworker.unref();\n",
        new="\t\tworker.unref();\n\t\tif (1 as number) return pruneAsyncRunDirs({ ...hostOptions, log });\n",
        expected_test="runs the startup sweep on a worker thread instead of blocking the main thread",
    ),
    Mutation(
        name="worker failure is swallowed instead of logged",
        source=RETENTION,
        old='\t\t\tworker.on("error", (error: Error) => {\n\t\t\t\tlog?.(`[subagent async-run GC] failed: ${error.message}`);\n\t\t\t\tfinish(null);\n\t\t\t});',
        new='\t\t\tworker.on("error", () => {\n\t\t\t\tfinish(null);\n\t\t\t});',
        expected_test="reports a worker that exits or errors instead of failing silently",
    ),
    Mutation(
        name="worker exit before reporting is silent",
        source=RETENTION,
        old='\t\t\tworker.on("exit", (code: number) => {\n\t\t\t\tif (settled) return;\n\t\t\t\tlog?.(`[subagent async-run GC] failed: worker exited before reporting (code ${code})`);\n\t\t\t\tfinish(null);\n\t\t\t});',
        new='\t\t\tworker.on("exit", () => {\n\t\t\t\tfinish(null);\n\t\t\t});',
        expected_test="reports a worker that exits or errors instead of failing silently",
    ),
    Mutation(
        name="open-fd containment index reports no root",
        source=RETENTION,
        old="\t\t\tconst match = this.rootByPath.get(current);\n\t\t\tif (match !== undefined) return match;",
        new="\t\t\tconst match = this.rootByPath.get(current);\n\t\t\tif (match !== undefined) return undefined;",
        expected_test="keeps a tree with an open fd or an incomplete /proc scan",
    ),
    Mutation(
        name="descendant index drops the separator",
        source=RETENTION,
        old="\t\tconst prefix = resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;",
        new="\t\tconst prefix = resolved;",
        expected_test="prunes when no open path shares a directory with the candidate",
    ),
    Mutation(
        name="an injected scanner is passed to the worker instead of refused",
        source=RETENTION,
        old='\t\t\tlog?.(`[subagent async-run GC] failed: ${injectable} cannot cross a worker thread; call pruneAsyncRunDirs directly`);\n\t\t\treturn null;',
        new='\t\t\tvoid injectable;',
        expected_test="refuses an injected scanner instead of running a different sweep in the worker",
    ),
    Mutation(
        name="deleted-inode suffix is no longer stripped before matching",
        source=RETENTION,
        old='\treturn path.resolve(item.replace(DELETED_SUFFIX, ""));',
        new="\treturn path.resolve(item);",
        expected_test="keeps a candidate whose open descriptor names a deleted file",
    ),
]


def node_test(test_name: str) -> tuple[str, ...]:
    return (
        NODE,
        "--experimental-strip-types",
        "--test",
        f"--test-name-pattern={test_name}",
        TEST_PATH,
    )


def make_project_copy(directory: Path) -> None:
    directory.mkdir(parents=True)
    shutil.copytree(ROOT / "src", directory / "src", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(ROOT / "test", directory / "test", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copy2(ROOT / "package.json", directory / "package.json")
    node_modules = ROOT / "node_modules"
    if node_modules.exists():
        (directory / "node_modules").symlink_to(node_modules, target_is_directory=True)


def main() -> int:
    failed = 0
    for mutation in MUTATIONS:
        source_path = ROOT / mutation.source
        source = source_path.read_text(encoding="utf-8")
        if source.count(mutation.old) != 1:
            print(f"ANCHOR {mutation.name}: expected one mutation target, found {source.count(mutation.old)}")
            failed += 1
            continue

        with tempfile.TemporaryDirectory(prefix="pi-subagent-gc-mutcheck-") as temp:
            project = Path(temp) / "project"
            make_project_copy(project)
            mutant_path = project / mutation.source
            mutant_path.write_text(
                (ROOT / mutation.source).read_text(encoding="utf-8").replace(mutation.old, mutation.new, 1),
                encoding="utf-8",
            )
            result = subprocess.run(
                node_test(mutation.expected_test),
                cwd=project,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
            caught = result.returncode != 0 and re.search(
                rf"(?:✖|not ok).*{re.escape(mutation.expected_test)}", result.stdout, flags=re.IGNORECASE
            ) is not None
            if caught:
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
