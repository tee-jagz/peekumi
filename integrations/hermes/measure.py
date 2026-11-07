"""Measure an exported source snapshot in a new private folder, never in the checkout."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import time

from .peekumi_client import Unavailable


def resume_pending(client, private_root):
    """On an explicit measurement call, submit retained evidence before a fresh run."""
    for folder in sorted(Path(private_root).glob("run-*")):
        evidence = folder / ".peekumi-evidence.json"
        if evidence.is_file() and not evidence.is_symlink():
            client.call("coverage", json.loads(evidence.read_text()))
            shutil.rmtree(folder)


def unpack(archive, root):
    """Extract only bounded regular files. Reject paths, links and special files."""
    total = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as stream:
        for index, member in enumerate(stream):
            path = PurePosixPath(member.name)
            if index >= 5000 or not member.isfile() or path.is_absolute() or ".." in path.parts or ".git" in path.parts or "\\" in member.name:
                raise Unavailable("Unsafe or oversized snapshot archive")
            total += member.size
            if total > 64 * 1024 * 1024:
                raise Unavailable("Snapshot exceeds 64 MiB")
            destination = root.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with stream.extractfile(member) as source, destination.open("xb") as output:
                shutil.copyfileobj(source, output)
            destination.chmod(0o755 if member.mode & 0o111 else 0o644)


def measure(client, baseline, private_root, coverage_command, report_command, threshold=30, timeout=120):
    """Measure both revisions when a changed existing function lacks baseline evidence.

    Capture the current SHA before either run. Concurrent checkout edits never move
    either measurement. Failed baseline tests stay unknown, rather than reusing the
    current revision's coverage. New functions need only the current measurement.
    """
    impact = client.call("impact", baseline=baseline, threshold=threshold)
    sha = impact["snapshot_sha"]
    needs_baseline = not impact.get("baseline_coverage_sha") and any(symbol.get("path", "").endswith(".py")
                         and symbol.get("kind") in {"function", "method"}
                         and symbol.get("before", {}).get("state") == "unknown"
                         for symbol in impact.get("changed_symbols", []))
    previous = None
    if needs_baseline:
        previous = measure_snapshot(client, baseline, impact["baseline_sha"], private_root,
                                    coverage_command, report_command, timeout)
    current = measure_snapshot(client, baseline, sha, private_root,
                               coverage_command, report_command, timeout)
    result = client.call("impact", baseline=baseline, threshold=threshold)
    return {**result, **current, **({"baseline_measurement": previous} if previous else {})}


def measure_snapshot(client, baseline, sha, private_root, coverage_command, report_command, timeout):
    """Submit one exact revision with a one-use export receipt and fresh-folder proof.

    Keep the private copy for recovery only until the service records its evidence.
    A successful acknowledgement consumes the receipt, including failed test runs.
    """
    exported = client.call("export", baseline=baseline, snapshot=sha)
    run = exported.get("run_id")
    if not run or exported.get("snapshot") != sha:
        raise Unavailable("Snapshot export has no matching measurement receipt")
    private_root = Path(private_root)
    private_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = Path(tempfile.mkdtemp(prefix="run-" + run + "-", dir=private_root))
    accepted = False
    try:
        unpack(exported["archive"], root)
        report = root / "lcov.info"
        report.unlink(missing_ok=True)
        config = root / ".peekumi-measure.rc"
        config.write_text("[run]\nrelative_files = true\nbranch = true\nsource = .\n")
        env = {key: value for key, value in os.environ.items() if key in {"PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "TMPDIR"}}
        env.update({"COVERAGE_RCFILE": str(config), "COVERAGE_FILE": str(root / ".coverage"),
                    "PYTHONDONTWRITEBYTECODE": "1", "HOME": str(root / ".home")})
        (root / ".home").mkdir()
        started = time.time_ns()

        def run_command(command, log):
            if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
                return -1
            try:
                with (root / log).open("wb") as output:
                    return subprocess.run(command, cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT,
                                          timeout=timeout, check=False).returncode
            except (OSError, subprocess.TimeoutExpired):
                return -1

        test_exit = run_command(coverage_command, ".peekumi-tests.log")
        export_exit = run_command(report_command, ".peekumi-report.log") if test_exit == 0 else -1
        fresh = report.is_file() and not report.is_symlink() and report.resolve().is_relative_to(root.resolve())
        fresh = fresh and report.stat().st_mtime_ns >= started and report.stat().st_size <= 4 * 1024 * 1024
        content = report.read_text() if fresh else ""
        evidence = {"baseline": baseline, "snapshot": sha, "run_id": run,
                    "test_exit": test_exit, "export_exit": export_exit, "fresh_directory": bool(fresh),
                    "report": content, "report_hash": hashlib.sha256(content.encode()).hexdigest()}
        (root / ".peekumi-evidence.json").write_text(json.dumps(evidence))
        try:
            response = client.call("coverage", evidence)
        except Unavailable:
            raise Unavailable("Measurement evidence is waiting for submission", pending_run=run) from None
        accepted = True  # The server recorded success or failure and consumed the receipt.
        return {"measurement": {key: evidence[key] for key in ["snapshot", "run_id", "test_exit", "export_exit", "report_hash"]},
                "measurement_accepted": response.get("accepted", False), "export_limits": exported["limits"]}
    finally:
        if accepted:
            shutil.rmtree(root)
