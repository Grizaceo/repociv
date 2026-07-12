from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path


def test_backup_covers_runtime_config_and_repo_roots(tmp_path: Path):
    state = tmp_path / "state"
    config = tmp_path / "config"
    backups = tmp_path / "backups"
    roots = tmp_path / "repo-roots.json"
    state.mkdir()
    config.mkdir()
    for name in (
        "events.jsonl",
        "missions.json",
        "scheduler-queue.json",
        "approvals.json",
        "workspace-state.json",
        "ledger.duckdb",
    ):
        (state / name).write_text(f"fixture:{name}", encoding="utf-8")
    (state / "sessions" / "MAIN").mkdir(parents=True)
    (state / "sessions" / "MAIN" / "session.json").write_text("{}", encoding="utf-8")
    (state / "run-state").mkdir()
    (state / "run-state" / "cmd-1.json").write_text("{}", encoding="utf-8")
    (config / "profiles.json").write_text("{}", encoding="utf-8")
    roots.write_text(json.dumps({"version": 1}), encoding="utf-8")

    env = {
        **os.environ,
        "REPOCIV_STATE_DIR": str(state),
        "REPOCIV_CONFIG_DIR": str(config),
        "REPOCIV_BACKUP_DIR": str(backups),
        "REPOCIV_STATE_FILE": str(roots),
    }
    result = subprocess.run(
        ["bash", "scripts/repociv-backup.sh"],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    snapshots = [path for path in backups.iterdir() if path.is_dir()]
    assert len(snapshots) == 1
    snapshot = snapshots[0]
    expected = {
        "state/events.jsonl",
        "state/missions.json",
        "state/scheduler-queue.json",
        "state/approvals.json",
        "state/workspace-state.json",
        "state/ledger.duckdb",
        "state/sessions/MAIN/session.json",
        "state/run-state/cmd-1.json",
        "config/profiles.json",
        "vite/repo-roots.json",
        "SHA256SUMS",
    }
    actual = {
        str(path.relative_to(snapshot))
        for path in snapshot.rglob("*")
        if path.is_file()
    }
    assert expected <= actual

    verify = subprocess.run(
        ["sha256sum", "--check", "SHA256SUMS"],
        cwd=snapshot,
        check=False,
        capture_output=True,
        text=True,
    )
    assert verify.returncode == 0, verify.stderr

    restored = tmp_path / "restored-state"
    shutil.copytree(snapshot / "state", restored)
    assert (restored / "events.jsonl").read_text(encoding="utf-8") == "fixture:events.jsonl"
    assert (restored / "sessions" / "MAIN" / "session.json").read_text(
        encoding="utf-8"
    ) == "{}"
    assert (restored / "run-state" / "cmd-1.json").read_text(encoding="utf-8") == "{}"
