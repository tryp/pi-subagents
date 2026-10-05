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
import tarfile
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any

EXCLUDES = (".git", "node_modules", "tmp", ".deployed-commit", ".deploy.lock")
TREE_STAMP_RE = re.compile(r"^tree: sha256:([0-9a-f]{64})$", re.MULTILINE)
COMMIT_STAMP_RE = re.compile(r"^commit:\s*([0-9a-f]{7,64})\s*$", re.MULTILINE)


def file_digest(path: Path) -> str:
    """Stream a file through sha256 so large trees do not land in memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scan_symlinks(root: Path) -> dict[str, str]:
    """Map every symlink under root to its target, without following links."""
    found: dict[str, str] = {}
    pending = [Path(".")]
    while pending:
        relative = pending.pop()
        base = root if str(relative) == "." else root / relative
        with os.scandir(base) as entries:
            for entry in entries:
                if entry.name in EXCLUDES:
                    continue
                child = Path(entry.name) if str(relative) == "." else relative / entry.name
                if entry.is_symlink():
                    found[child.as_posix()] = os.readlink(entry.path)
                elif entry.is_dir(follow_symlinks=False):
                    pending.append(child)
    return found


def symlink_diff(baseline: Path, runtime: Path) -> tuple[list[str], list[str]]:
    """Return (runtime-only, changed-or-replaced) symlink paths relative to the baseline.

    rsync has no -l, so it never itemizes symlinks; their drift has to be
    compared here. A baseline link that the runtime no longer has as a link is
    drift too when the runtime holds a real object in its place.
    """
    baseline_links = scan_symlinks(baseline)
    runtime_links = scan_symlinks(runtime)
    shared = set(baseline_links) & set(runtime_links)
    changed = {relative for relative in shared if baseline_links[relative] != runtime_links[relative]}
    extra = set(runtime_links) - set(baseline_links)
    replaced = {
        relative
        for relative in set(baseline_links) - set(runtime_links)
        if (runtime / relative).is_symlink() or (runtime / relative).exists()
    }
    return sorted(extra), sorted(changed | replaced)


def symlink_digest(path: Path) -> str:
    """Stable digest of a symlink's target text.

    Symlinks are deployed content (rsync -a copies them), so a changed target
    must be visible to both preflight and --check-stamp.
    """
    return hashlib.sha256(b"symlink\0" + os.readlink(path).encode("utf-8")).hexdigest()


def tree_hash(runtime: Path) -> str:
    """Hash regular files and symlinks, excluding deploy-managed paths, deterministically."""
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
        # A symlink to a directory is listed under `dirs`, not `files`, so it
        # has to be hashed here or a retargeted link would not change the
        # stamp at all.
        linked_dirs: list[str] = []
        for name in list(dirs):
            path = root_path / name
            rel_path = path.relative_to(runtime).as_posix()
            if rel_path.split("/", 1)[0] in EXCLUDES:
                continue
            try:
                if stat.S_ISLNK(path.lstat().st_mode):
                    entries.append((rel_path, symlink_digest(path)))
                    linked_dirs.append(name)
            except OSError as error:
                raise OSError(f"cannot hash {path}: {error}") from error
        dirs[:] = [name for name in dirs if name not in linked_dirs]
        for name in files:
            path = root_path / name
            rel_path = path.relative_to(runtime).as_posix()
            first_segment = rel_path.split("/", 1)[0]
            if first_segment in EXCLUDES:
                continue
            try:
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode):
                    digest = symlink_digest(path)
                elif stat.S_ISREG(mode):
                    digest = file_digest(path)
                else:
                    continue
            except OSError as error:
                raise OSError(f"cannot hash {path}: {error}") from error
            entries.append((rel_path, digest))

    payload = "".join(f"{digest}  {rel_path}\n" for rel_path, digest in sorted(entries))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def parse_itemize(output: str) -> tuple[list[str], list[str], list[str], list[str]]:
    """Return (extra, modified, created, retyped) relative paths from rsync itemize output.

    `>f+++++++++` and `cd+++++++++` are ambiguous. Measured with the flags
    preflight uses, a genuinely absent runtime file arrives as `>f+++++++++`
    and an absent runtime directory as `cd+++++++++`, while a file replaced by
    a directory, symlink or fifo arrives with those same codes. The caller
    disambiguates by inspecting the runtime's object type.
    """
    extra: list[str] = []
    modified: list[str] = []
    created: list[str] = []
    retyped: list[str] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        item = line.split(maxsplit=1)
        if len(item) < 2:
            continue
        code, path = item[0], item[1].strip()
        if code.startswith("*deleting"):
            extra.append(path)
        elif code == ">f+++++++++":
            created.append(path)
        elif code.startswith("c"):
            # Type changes (cd+++++++++, cL+++++++++, ...) replace a runtime
            # object with one of a different kind; rsync -a will overwrite it.
            retyped.append(path)
        elif code.startswith(">f") and any(flag in "cst" for flag in code[2:5].lower()):
            modified.append(path)
    return sorted(set(extra)), sorted(set(modified)), sorted(set(created)), sorted(set(retyped))


def rsync_diff(source: Path, runtime: Path) -> tuple[list[str], list[str], list[str], list[str], str]:
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
    return (*parse_itemize(raw), raw)


def timestamp_name(directory: Path) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    candidate = stamp
    suffix = 0
    while any((directory / f"deploy-drift-{candidate}.{extension}").exists() for extension in ("patch", "sha256", "listing.txt")):
        suffix += 1
        candidate = (datetime.now(timezone.utc) + timedelta(seconds=suffix)).strftime("%Y%m%dT%H%M%SZ")
    return candidate


def stamp_state(runtime: Path) -> str | None:
    """Return the stamped commit, or a reason string when it is unusable."""
    stamp_path = runtime / ".deployed-commit"
    if not stamp_path.is_file():
        return None
    try:
        stamp_text = stamp_path.read_text(encoding="utf-8")
    except OSError as error:
        return f"deploy stamp unreadable ({error.strerror or error})"
    match = COMMIT_STAMP_RE.search(stamp_text)
    if match is None:
        return "deploy stamp has no parseable commit"
    return match.group(1)


def stamped_commit(runtime: Path) -> str | None:
    """Return the commit recorded in the runtime deploy stamp, if it is parseable."""
    state = stamp_state(runtime)
    return state if state is not None and re.fullmatch(r"[0-9a-f]{7,64}", state) else None


def export_commit(source: Path, commit: str, destination: Path) -> str | None:
    """Export `commit`'s tree into `destination`; return the resolved sha, or None.

    Preflight compares the runtime against the tree that was actually deployed,
    so a checkout that has since advanced is not mistaken for runtime drift.
    The archive streams through a file on disk rather than into memory.
    """
    try:
        resolved = subprocess.run(
            ["git", "-C", str(source), "rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}"],
            check=False,
            text=True,
            capture_output=True,
        )
    except OSError:
        return None
    sha = resolved.stdout.strip()
    if resolved.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40,64}", sha):
        return None
    archive_path = destination.parent / f"{destination.name}.tar"
    try:
        with archive_path.open("wb") as sink:
            archive = subprocess.run(
                ["git", "-C", str(source), "archive", "--format=tar", sha],
                check=False,
                stdout=sink,
                stderr=subprocess.PIPE,
            )
        if archive.returncode != 0:
            return None
        with tarfile.open(archive_path, mode="r|") as tar:
            # "data", not "tar": the data filter rejects absolute and
            # escaping symlink targets, which git happily tracks. Rejecting
            # them made export_commit fail and silently degraded the baseline
            # to the checkout comparison. Nothing here follows links, so the
            # stricter filter's real value does not apply to this tree.
            tar.extractall(destination, filter="tar")
    except (tarfile.TarError, OSError):
        return None
    finally:
        archive_path.unlink(missing_ok=True)
    return sha


def _git_patch(source: Path, runtime: Path, label: str) -> tuple[str, str]:
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
        f"# Runtime drift patch: {label} -> runtime. Apply to RUNTIME with `git apply -R` to return it to {label}.\n"
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


def save_drift(directory: Path, baseline: Path, runtime: Path, extra: list[str], modified: list[str], raw: str, label: str) -> dict[str, str]:
    directory.mkdir(parents=True, exist_ok=True)
    stamp = timestamp_name(directory)
    patch_path = directory / f"deploy-drift-{stamp}.patch"
    hash_path = directory / f"deploy-drift-{stamp}.sha256"
    listing_path = directory / f"deploy-drift-{stamp}.listing.txt"

    patch, method = _git_patch(baseline, runtime, label)
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


def deployable_from(source: Path, runtime: Path, relative: str) -> bool:
    """True when the checkout still provides this runtime path with identical content.

    The deploy mirrors the checkout working tree, not just the committed tree, so
    gitignored scratch content (for example .pi-subagents/artifacts/) is copied
    to the runtime on every deploy. Such files are absent from the stamped
    commit yet are not drift; only content that the checkout no longer provides
    (or would overwrite with something different) is at risk.
    """
    source_path = source / relative
    runtime_path = runtime / relative
    if source_path.is_symlink() or runtime_path.is_symlink():
        if not (source_path.is_symlink() and runtime_path.is_symlink()):
            return False
        return os.readlink(source_path) == os.readlink(runtime_path)
    if source_path.is_dir():
        return True
    if not source_path.is_file() or not runtime_path.is_file():
        return False
    try:
        if not stat.S_ISREG(runtime_path.lstat().st_mode):
            return False
        if source_path.stat().st_size != runtime_path.stat().st_size:
            return False
        return file_digest(source_path) == file_digest(runtime_path)
    except OSError:
        return False


def filter_extra(source: Path, runtime: Path, extra: list[str]) -> list[str]:
    """Drop runtime paths the checkout still mirrors byte for byte."""
    return [relative for relative in extra if not deployable_from(source, runtime, relative)]


def retype_drift(runtime: Path, candidates: list[str]) -> list[str]:
    """Baseline paths the runtime holds with a different kind of object.

    A candidate is benign only when the runtime truly lacks the path: the
    deploy then recreates it from the checkout. If the runtime holds anything
    at that path, `rsync -a` overwrites a runtime object the guard never saw,
    which is drift. The same path must not also be reported as extra, or
    --allow-drift could not authorize the overwrite.
    """
    drift: list[str] = []
    for relative in candidates:
        runtime_path = runtime / relative
        if runtime_path.is_symlink() or runtime_path.exists():
            drift.append(relative)
    return sorted(set(drift))


def resolve_baseline(source: Path, runtime: Path) -> tuple[Path, str, str | None, Path | None]:
    """Pick the tree the runtime should match: the stamped commit, else the checkout.

    Returns (baseline_dir, label, stamped_sha_or_None, temp_dir_to_clean_up).
    A checkout that has advanced past the deployed commit is normal after any
    commit, so comparing against it would report every changed file as runtime
    drift and force ALLOW_DRIFT on routine deploys.
    """
    stamp = stamp_state(runtime)
    if stamp is None:
        return source, f"checkout {source} (no deploy stamp)", None, None
    if re.fullmatch(r"[0-9a-f]{7,64}", stamp) is None:
        return source, f"checkout {source} ({stamp})", None, None
    temp_dir = Path(tempfile.mkdtemp(prefix="pi-deploy-baseline-"))
    resolved = export_commit(source, stamp, temp_dir)
    if resolved is None:
        shutil.rmtree(temp_dir, ignore_errors=True)
        return source, f"checkout {source} (stamped commit {stamp[:12]} is not resolvable here)", stamp, None
    return temp_dir, f"deployed baseline {resolved[:12]}", resolved, temp_dir


def preflight(args: argparse.Namespace) -> int:
    runtime = args.runtime.resolve()
    source = args.source.resolve()
    if not source.is_dir():
        raise RuntimeError(f"source directory is not readable: {source}")
    if not runtime.exists():
        emit(
            {"mode": "preflight", "runtime": str(runtime), "source": str(source), "baseline": None, "baselineCommit": None, "status": "clean", "exitCode": 0, "extraFiles": [], "modifiedFiles": []},
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
            {"mode": "preflight", "runtime": str(runtime), "source": str(source), "baseline": None, "baselineCommit": None, "status": "clean", "exitCode": 0, "extraFiles": [], "modifiedFiles": []},
            args.json,
            f"drift guard: {runtime} matches {source} (runtime is empty)",
        )
        return 0

    temp_dir: Path | None = None
    try:
        baseline, baseline_label, baseline_commit, temp_dir = resolve_baseline(source, runtime)
        extra, modified, created, retyped, raw = rsync_diff(baseline, runtime)
        # rsync skips symlinks entirely ("skipping non-regular file"), so a
        # changed link target would otherwise be invisible to both preflight and
        # --check-stamp while `rsync -a` overwrites it.
        link_extra, link_changed = symlink_diff(baseline, runtime)
        typed = set(retype_drift(runtime, created + retyped))
        extra = filter_extra(source, runtime, sorted((set(extra) | set(link_extra)) - typed))
        modified = sorted(set(modified) | set(link_changed) | typed)
        artifacts: dict[str, str] = {}
        if args.save_drift and (extra or modified):
            artifacts = save_drift(args.save_drift, baseline, runtime, extra, modified, raw, baseline_label)
    finally:
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)

    rejected_extra = bool(extra)
    rejected_modified = bool(modified) and not args.allow_drift
    exit_code = 2 if rejected_extra or rejected_modified else 0
    status = "drift" if exit_code == 2 else ("warning" if extra or modified else "clean")
    data: dict[str, Any] = {
        "mode": "preflight",
        "runtime": str(runtime),
        "source": str(source),
        "baseline": baseline_label,
        "baselineCommit": baseline_commit if baseline != source else None,
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
        emit(data, False, f"drift guard: {runtime} matches {baseline_label}")
        return 0

    prefix = "ERROR" if exit_code == 2 else "WARNING"
    lines = [f"drift guard: {runtime} vs {baseline_label}"]
    if extra:
        lines.append(
            f"{prefix}: {len(extra)} file(s) in the runtime are not in {baseline_label} and are no longer "
            "provided by the checkout; they would be lost:"
        )
        lines.extend(f"  {path}" for path in extra)
    if modified:
        modified_prefix = "ERROR" if rejected_modified else "WARNING"
        lines.append(
            f"{modified_prefix}: {len(modified)} file(s) were edited in the runtime after {baseline_label} "
            "and would be overwritten with checkout content:"
        )
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
