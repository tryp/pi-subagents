#!/usr/bin/env python3
"""Run each unit test file in its own process, twice, and report which totals moved.

Why per file: the whole-suite count is not reproducible (1507 vs 1594 back to back on the same
commit), and a single total cannot say which file moved. Running one file per process makes the
per-file count a fact, so the difference is attributed to a file instead of to the run.

Why twice: a count that is stable once is not stable. The two runs must agree per file.

Usage:
  python3 scripts/test_count_stability.py [--runs 2] [--jobs 4] [--json PATH] [FILE ...]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUMMARY_RE = {
    "tests": re.compile(r"^\u2139 tests (\d+)$", re.M),
    "suites": re.compile(r"^\u2139 suites (\d+)$", re.M),
    "pass": re.compile(r"^\u2139 pass (\d+)$", re.M),
    "fail": re.compile(r"^\u2139 fail (\d+)$", re.M),
    "skipped": re.compile(r"^\u2139 skipped (\d+)$", re.M),
}


def run_file(path: str, timeout: int) -> dict:
    started = time.time()
    # No `--test-force-exit`: with it, a per-file run reported 18 of this file's 34 tests, exit 0,
    # zero failures. The count is the measurement, so the measurement must not be able to truncate
    # itself. Without the flag the same file reports 34 every time.
    try:
        proc = subprocess.run(
            ["node", "--experimental-strip-types", "--test", path],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        returncode, stdout = proc.returncode, proc.stdout
    except subprocess.TimeoutExpired as expired:
        # A file that never finishes has no count at all; recording it as "no count" keeps it visible
        # instead of letting a traceback end the run before the other files are measured.
        returncode, stdout = None, (expired.stdout or "") if isinstance(expired.stdout, str) else ""
    counts = {name: int(m.group(1)) if (m := rx.search(stdout)) else None
              for name, rx in SUMMARY_RE.items()}
    return {
        "file": os.path.relpath(path, ROOT),
        "returncode": returncode,
        "counts": counts,
        "seconds": round(time.time() - started, 2),
        "tail": "\n".join(stdout.strip().splitlines()[-8:]),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", help="test files (default: committed files from git ls-files)")
    ap.add_argument("--runs", type=int, default=2, help="how many times to run each file (default 2)")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) // 2), help="parallel files")
    ap.add_argument("--timeout", type=int, default=600, help="per-file timeout in seconds")
    ap.add_argument("--json", help="write the per-run table here")
    args = ap.parse_args()

    if args.files:
        files = args.files
    else:
        try:
            tracked = subprocess.run(
                ["git", "ls-files", "-z", "--", "test/unit"],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.split("\0")
        except (OSError, subprocess.CalledProcessError) as error:
            print(f"could not resolve committed unit test files: {error}", file=sys.stderr)
            return 2
        files = sorted(path for path in tracked if path.endswith(".test.ts"))
        missing = [path for path in files if not os.path.isfile(os.path.join(ROOT, path))]
        if missing:
            print("committed unit test files missing from checkout:\n  " + "\n  ".join(missing), file=sys.stderr)
            return 2
    if not files:
        print("no test files found", file=sys.stderr)
        return 2

    runs: list[dict[str, dict]] = []
    for index in range(args.runs):
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            results = list(pool.map(lambda p: run_file(p, args.timeout), files))
        runs.append({r["file"]: r for r in results})
        total = sum((r["counts"]["tests"] or 0) for r in results)
        print(f"run {index + 1}: {len(results)} files, {total} tests", flush=True)

    stable = True
    print("\nfile                                     " + "  ".join(f"run{i + 1}" for i in range(args.runs)))
    for path in sorted(runs[0]):
        counts = [run.get(path, {}).get("counts", {}).get("tests") for run in runs]
        moved = len(set(counts)) > 1
        stable = stable and not moved
        flag = "  <-- MOVED" if moved else ""
        print(f"{path:<40} " + "  ".join(f"{c!s:>5}" for c in counts) + flag)

    # A file that reports no test at all is stable and vacuous at the same time: a broken import or a
    # glob that stopped matching would hold the total constant while covering nothing. Floor it.
    empty = [path for path in sorted(runs[0])
             if not any(run.get(path, {}).get("counts", {}).get("tests") for run in runs)]
    for path in empty:
        stable = False
        print(f"\n{path} reported no tests in any run")
        print(runs[0][path]["tail"])

    for path in sorted(runs[0]):
        bad = [run[path]["returncode"] for run in runs if path in run and run[path]["returncode"] != 0]
        if bad:
            stable = False
            print(f"\n{path} exited {bad}")
            print(runs[0][path]["tail"])

    if args.json:
        os.makedirs(os.path.dirname(os.path.abspath(args.json)), exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(runs, handle, indent=2)
        print(f"\nreport: {args.json}")

    print("\nverdict: " + ("STABLE -- every file reported the same test count in every run"
                            if stable else "UNSTABLE -- see the flagged files above"))
    return 0 if stable else 1


if __name__ == "__main__":
    raise SystemExit(main())
