#!/usr/bin/env python3
"""Check and preserve content drift between a source checkout and its runtime mirror."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

EXCLUDES = (".git", "node_modules", "tmp", ".deployed-commit", ".deploy.lock")
TREE_STAMP_RE = re.compile(r"^tree: sha256:([0-9a-f]{64})$", re.MULTILINE)


def tree_hash(runtime: Path) -> str:
    """Hash regular files, excluding deploy-managed paths, deterministically."""
    if not runtime.is_dir():
        raise OSError(f"runtime directory is not readable: {runtime}")

    def raise_walk_error(error: OSError) -> None:
        raise error

    entries: list[tuple[str, str]] = []
    for root, dirs, files in os.walk(runtime, followlinks=False, onerror=raise_walk_error):
        root_path = Path(root)
        rel_root = root_path.relative_to(runtime)
        if rel_root == Path("."):
            dirs[:] = [name for name in dirs if name not in EXCLUDES]
        else:
            dirs[:] = [name for name in dirs if name not in EXCLUDES]
        for name in files:
            path = root_path / name
            rel_path = path.relative_to(runtime).as_posix()
            first_segment = rel_path.split("/", 1)[0]
            if first_segment in EXCLUDES:
                continue
            try:
                mode = path.lstat().st_mode
                if not stat.S_ISREG(mode):
                    continue
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except OSError as error:
                raise OSError(f"cannot hash {path}: {error}") from error
            entries.append((rel_path, digest))

    payload = "".join(f"{digest}  {rel_path}\n" for rel_path, digest in sorted(entries))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def parse_itemize(output: str) -> tuple[list[str], list[str]]:
    """Return (extra, modified) relative paths from rsync itemize output."""
    extra: list[str] = []
    modified: list[str] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        item = line.split(maxsplit=1)
        if len(item) < 2:
            continue
        code, path = item[0], item[1].strip()
        if code.startswith("*deleting"):
            extra.append(path)
        elif code.startswith(">f"):
            modified.append(path)
    return sorted(set(extra)), sorted(set(modified))


def rsync_diff(source: Path, runtime: Path) -> tuple[list[str], list[str], str]:
    command = [
        "rsync",
        "-nrc",
        "--delete",
        "--itemize-changes",
        "--out-format=%i %n",
    ]
    for excluded in EXCLUDES:
        command.extend(("--exclude", f"{excluded}/" if excluded in (".git", "node_modules", "tmp") else excluded))
    command.extend((f"{source}/", f"{runtime}/"))
    try:
        result = subprocess.run(command, check=False, text=True, capture_output=True)
    except FileNotFoundError as error:
        raise RuntimeError("rsync is required for deploy drift checks") from error
    if result.returncode >= 2:
        detail = result.stderr.strip() or result.stdout.strip() or f"rsync exited {result.returncode}"
        raise RuntimeError(f"rsync failed: {detail}")
    raw = result.stdout
    extra, modified = parse_itemize(raw)
    return extra, modified, raw


def timestamp_name(directory: Path) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    candidate = stamp
    suffix = 0
    while any((directory / f"deploy-drift-{candidate}.{extension}").exists() for extension in ("patch", "sha256", "listing.txt")):
        suffix += 1
        candidate = (datetime.now(timezone.utc) + timedelta(seconds=suffix)).strftime("%Y%m%dT%H%M%SZ")
    return candidate


def _git_patch(source: Path, runtime: Path) -> tuple[str, str]:
    """Return a patch (source -> runtime) and a header noting application direction."""
    command = ["git", "diff", "--no-index", "--binary", "--", ".", str(runtime), "--"]
    command.append(".")
    command.extend((f":!{excluded}/**" for excluded in EXCLUDES[:3]))
    command.extend((f":!{excluded}" for excluded in EXCLUDES[3:]))
    try:
        result = subprocess.run(command, cwd=source, check=False, text=True, capture_output=True)
    except FileNotFoundError:
        return _fallback_patch(source, runtime), "git unavailable; fallback is per-file diff -u (text-oriented)"
    if result.returncode not in (0, 1):
        detail = result.stderr.strip() or f"git diff exited {result.returncode}"
        raise RuntimeError(f"could not build drift patch: {detail}")
    header = (
        "# Runtime drift patch: source -> runtime. Apply to RUNTIME to return it to SOURCE state with `git apply -R`.\n"
    )
    return header + result.stdout, "git diff --no-index --binary"


def _fallback_patch(source: Path, runtime: Path) -> str:
    """Best-effort text diff fallback when git is unavailable."""
    import difflib

    lines = ["# Fallback patch; binary files cannot be represented by diff -u.\n"]
    all_paths: set[str] = set()
    for root, dirs, files in os.walk(runtime, followlinks=False):
        rel_root = Path(root).relative_to(runtime)
        dirs[:] = [name for name in dirs if name not in EXCLUDES]
        for name in files:
            rel = (rel_root / name).as_posix()
            if rel.split("/", 1)[0] not in EXCLUDES:
                all_paths.add(rel)
    for root, dirs, files in os.walk(source, followlinks=False):
        rel_root = Path(root).relative_to(source)
        dirs[:] = [name for name in dirs if name not in EXCLUDES]
        for name in files:
            rel = (rel_root / name).as_posix()
            if rel.split("/", 1)[0] not in EXCLUDES:
                all_paths.add(rel)

    for rel in sorted(all_paths):
        src = source / rel
        dst = runtime / rel
        if src.is_file() and dst.is_file():
            try:
                left, right = src.read_text(encoding="utf-8").splitlines(keepends=True), dst.read_text(encoding="utf-8").splitlines(keepends=True)
            except (UnicodeError, OSError):
                lines.append(f"Binary or unreadable file differs: {rel}\n")
                continue
        elif src.is_file():
            left, right = src.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True), []
        elif dst.is_file():
            left, right = [], dst.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
        else:
            continue
        lines.extend(
            difflib.unified_diff(
                left,
                right,
                fromfile=f"a/{rel}" if src.exists() else "/dev/null",
                tofile=f"b/{rel}" if dst.exists() else "/dev/null",
            )
        )
    return "".join(lines)


def save_drift(directory: Path, source: Path, runtime: Path, extra: list[str], modified: list[str], raw: str) -> dict[str, str]:
    directory.mkdir(parents=True, exist_ok=True)
    stamp = timestamp_name(directory)
    patch_path = directory / f"deploy-drift-{stamp}.patch"
    hash_path = directory / f"deploy-drift-{stamp}.sha256"
    listing_path = directory / f"deploy-drift-{stamp}.listing.txt"

    patch, method = _git_patch(source, runtime)
    patch_path.write_text(patch, encoding="utf-8")

    hashes: list[str] = []
    for rel in sorted(set(extra + modified)):
        path = runtime / rel
        try:
            if stat.S_ISREG(path.lstat().st_mode):
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                hashes.append(f"{digest[:16]}  {rel}\n")
        except FileNotFoundError:
            continue
    hash_path.write_text("".join(hashes), encoding="utf-8")
    listing_path.write_text(raw, encoding="utf-8")
    return {
        "patch": str(patch_path),
        "sha256": str(hash_path),
        "listing": str(listing_path),
        "patchMethod": method,
    }


def emit(data: dict[str, Any], as_json: bool, prose: str) -> None:
    if as_json:
        print(json.dumps(data, sort_keys=True))
    else:
        print(prose)


def preflight(args: argparse.Namespace) -> int:
    runtime = args.runtime.resolve()
    source = args.source.resolve()
    if not source.is_dir():
        raise RuntimeError(f"source directory is not readable: {source}")
    if not runtime.exists():
        emit(
            {"mode": "preflight", "runtime": str(runtime), "source": str(source), "status": "clean", "exitCode": 0, "extraFiles": [], "modifiedFiles": []},
            args.json,
            f"drift guard: {runtime} matches {source} (runtime does not exist yet)",
        )
        return 0
    if not runtime.is_dir():
        raise RuntimeError(f"runtime is not a directory: {runtime}")
    with os.scandir(runtime) as entries:
        has_runtime_content = any(entry.name not in EXCLUDES for entry in entries)
    if not has_runtime_content:
        emit(
            {"mode": "preflight", "runtime": str(runtime), "source": str(source), "status": "clean", "exitCode": 0, "extraFiles": [], "modifiedFiles": []},
            args.json,
            f"drift guard: {runtime} matches {source} (runtime is empty)",
        )
        return 0

    extra, modified, raw = rsync_diff(source, runtime)
    artifacts: dict[str, str] = {}
    if args.save_drift and (extra or modified):
        artifacts = save_drift(args.save_drift, source, runtime, extra, modified, raw)

    rejected_extra = bool(extra)
    rejected_modified = bool(modified) and not args.allow_drift
    exit_code = 2 if rejected_extra or rejected_modified else 0
    status = "drift" if exit_code == 2 else ("warning" if extra or modified else "clean")
    data: dict[str, Any] = {
        "mode": "preflight",
        "runtime": str(runtime),
        "source": str(source),
        "status": status,
        "exitCode": exit_code,
        "extraFiles": extra,
        "modifiedFiles": modified,
        "artifacts": artifacts,
    }
    if args.json:
        emit(data, True, "")
        return exit_code

    if not extra and not modified:
        emit(data, False, f"drift guard: {runtime} matches {source}")
        return 0

    prefix = "ERROR" if exit_code == 2 else "WARNING"
    lines = [f"drift guard: {runtime} vs {source}"]
    if extra:
        lines.append(f"{prefix}: {len(extra)} file(s) in the runtime are not in the checkout and would be lost:")
        lines.extend(f"  {path}" for path in extra)
    if modified:
        modified_prefix = "ERROR" if rejected_modified else "WARNING"
        lines.append(f"{modified_prefix}: {len(modified)} file(s) would be overwritten with checkout content:")
        lines.extend(f"  {path}" for path in modified)
    if artifacts:
        lines.extend((f"drift patch: {artifacts['patch']}", f"drift sha256: {artifacts['sha256']}", f"drift listing: {artifacts['listing']}"))
    if rejected_modified:
        lines.append("redeploy deliberately with ALLOW_DRIFT=1 to discard the modifications")
    if rejected_extra:
        lines.append("move or remove extra files after preserving them; ALLOW_DRIFT=1 does not override extra-file protection")
    emit(data, False, "\n".join(lines))
    return exit_code


def check_stamp(args: argparse.Namespace) -> int:
    runtime = args.runtime.resolve()
    stamp_path = runtime / ".deployed-commit"
    if not runtime.is_dir() or not stamp_path.is_file():
        data = {"mode": "check-stamp", "runtime": str(runtime), "status": "missing-stamp", "exitCode": 3}
        emit(data, args.json, f"ERROR: no readable deploy stamp at {stamp_path}")
        return 3
    try:
        stamp_text = stamp_path.read_text(encoding="utf-8")
    except OSError as error:
        data = {"mode": "check-stamp", "runtime": str(runtime), "status": "missing-stamp", "exitCode": 3}
        emit(data, args.json, f"ERROR: cannot read deploy stamp at {stamp_path}: {error}")
        return 3
    match = TREE_STAMP_RE.search(stamp_text)
    if match is None:
        data = {"mode": "check-stamp", "runtime": str(runtime), "status": "invalid-stamp", "exitCode": 3}
        emit(data, args.json, f"ERROR: deploy stamp has no parseable tree hash: {stamp_path}")
        return 3
    expected = "sha256:" + match.group(1)
    try:
        actual = tree_hash(runtime)
    except OSError as error:
        raise RuntimeError(str(error)) from error
    exit_code = 0 if actual == expected else 2
    status = "clean" if exit_code == 0 else "drift"
    data = {
        "mode": "check-stamp",
        "runtime": str(runtime),
        "status": status,
        "exitCode": exit_code,
        "expectedTreeHash": expected,
        "treeHash": actual,
    }
    prose = (
        f"runtime matches deploy stamp ({actual})"
        if exit_code == 0
        else f"ERROR: runtime tree changed since deploy (expected {expected}, found {actual})"
    )
    emit(data, args.json, prose)
    return exit_code


class DriftArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(1, f"{self.prog}: error: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    parser = DriftArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True, type=Path, help="deployed runtime directory")
    parser.add_argument("--source", type=Path, default=Path.cwd(), help="source checkout (default: current directory)")
    parser.add_argument("--save-drift", type=Path, help="directory to preserve drift artifacts")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check-stamp", action="store_true", help="compare runtime tree with its deploy stamp")
    modes.add_argument("--print-tree-hash", action="store_true", help="print runtime tree hash")
    parser.add_argument("--allow-drift", action="store_true", help="allow modified files (extras still fail)")
    parser.add_argument("--json", action="store_true", help="emit a JSON result object")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.save_drift and (args.check_stamp or args.print_tree_hash):
        parser.error("--save-drift is only valid in preflight mode")
    if args.allow_drift and (args.check_stamp or args.print_tree_hash):
        parser.error("--allow-drift is only valid in preflight mode")
    try:
        if args.print_tree_hash:
            result = tree_hash(args.runtime.resolve())
            if args.json:
                print(json.dumps({"mode": "print-tree-hash", "runtime": str(args.runtime.resolve()), "status": "ok", "exitCode": 0, "treeHash": result}, sort_keys=True))
            else:
                print(result)
            return 0
        if args.check_stamp:
            return check_stamp(args)
        return preflight(args)
    except (OSError, RuntimeError) as error:
        if args.json:
            print(json.dumps({"mode": "error", "status": "error", "exitCode": 1, "error": str(error)}, sort_keys=True))
        else:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
