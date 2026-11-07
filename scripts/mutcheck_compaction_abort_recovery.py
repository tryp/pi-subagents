#!/usr/bin/env python3
"""Revert each compaction-abort recovery guarantee in an isolated test copy."""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src/runs/shared/abort-recovery.ts"
TEST = ROOT / "test/unit/abort-recovery.test.ts"
CHILD_PROTOCOL = ROOT / "src/runs/shared/child-protocol.ts"
NODE = shutil.which("node") or "node"

MUTATIONS = [
    (
		"marker never set",
		"""\t\tif (event.type === "compaction_start") {\n\t\t\tthis.compactionTimes.push(observedAt);\n\t\t\tthis.recompute();\n\t\t}""",
		"""\t\tif (event.type === "compaction_start") {\n\t\t\tthis.recompute();\n\t\t}""",
		"recognizes the observed settle-then-manual-compaction order",
	),
	(
		"nearest compaction replaced by latest",
		"""\t\tconst nearestDistance = this.compactionTimes.reduce(\n\t\t\t(nearest, at) => Math.min(nearest, Math.abs(settlementAt - at)),\n\t\t\tNumber.POSITIVE_INFINITY,\n\t\t);""",
		"""\t\tconst nearestDistance = this.compactionTimes.length > 0\n\t\t\t? Math.abs(settlementAt - this.compactionTimes[this.compactionTimes.length - 1])\n\t\t\t: Number.POSITIVE_INFINITY;""",
		"uses the nearest compaction to the last settlement",
	),
    (
        "marker not reset on agent_start",
        """\t\tif (event.type === "agent_start" || event.type === "auto_retry_start") {\n\t\t\tthis.reset();\n\t\t\treturn;\n\t\t}""",
        """\t\tif (event.type === "agent_start" || event.type === "auto_retry_start") {\n\t\t\tthis.verified = false;\n\t\t\treturn;\n\t\t}""",
        "resets on a new agent turn, auto-retry",
    ),
    (
        "resume allowed twice",
        "\tif (input.alreadyResumed) return settle(\"resume already attempted\");\n",
        "",
        "settles a second abort once with the unsafe-recovery diagnostic",
    ),
    (
        "processSignal gate removed",
        "\tif (input.processSignal && !compactionAbortCandidate) return settle(\"process terminated by signal\");\n",
        "",
        "fails closed for every refusal gate",
    ),
    (
        "sessionAvailable gate removed",
        "\tif (!input.sessionAvailable) return settle(\"retained session unavailable\");\n",
        "",
        "fails closed for every refusal gate",
    ),
    (
        "afterCompactionSettlement gate removed",
        "\tif (!input.afterCompactionSettlement) return settle(\"compaction settlement not verified\");\n",
        "",
        "fails closed for every refusal gate",
    ),
    (
        "diagnostic dropped on settle",
        "\t\t...(compactionAbortCandidate\n\t\t\t? { diagnostic: `Compaction-induced child abort could not be resumed safely: ${reason}.` }\n\t\t\t: {}),\n",
        "",
        "carries a recovery diagnostic when a verified compaction abort cannot safely resume",
    ),
]


def run_test(source: str, directory: Path) -> subprocess.CompletedProcess[str]:
    (directory / "src/runs/shared").mkdir(parents=True, exist_ok=True)
    (directory / "test/unit").mkdir(parents=True, exist_ok=True)
    (directory / "src/runs/shared/abort-recovery.ts").write_text(source, encoding="utf-8")
    shutil.copy2(TEST, directory / "test/unit/abort-recovery.test.ts")
    shutil.copy2(CHILD_PROTOCOL, directory / "src/runs/shared/child-protocol.ts")
    return subprocess.run(
        [NODE, "--experimental-strip-types", "--test", "test/unit/abort-recovery.test.ts"],
        cwd=directory,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def main() -> int:
    source = SOURCE.read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="pi-subagent-abort-mutcheck-") as temp:
        root = Path(temp)
        baseline = run_test(source, root / "baseline")
        if baseline.returncode != 0:
            print("ANCHOR baseline test suite failed")
            print(baseline.stdout)
            return 1
        passed = re.search(r"ℹ pass (\d+)", baseline.stdout)
        print(f"BASELINE pass={passed.group(1) if passed else 'unknown'}")

        failed = 0
        for index, (label, old, new, expected) in enumerate(MUTATIONS):
            if source.count(old) != 1:
                print(f"ANCHOR {label}: expected one mutation target, found {source.count(old)}")
                failed += 1
                continue
            mutant = source.replace(old, new, 1)
            result = run_test(mutant, root / f"mutant-{index}")
            failures = re.findall(r"^✖ ([^\n(]+)", result.stdout, flags=re.MULTILINE)
            matching = [case.strip() for case in failures if expected in case]
            if result.returncode != 0 and matching:
                print(f"CAUGHT {label} | failing test id: {matching[-1]}")
            else:
                print(f"SURVIVED {label} | expected failure: {expected}")
                if result.stdout:
                    print(result.stdout[-2400:])
                failed += 1
        print(f"RESULT caught={len(MUTATIONS) - failed} failed={failed}")
        return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
