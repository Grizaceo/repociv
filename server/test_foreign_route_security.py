from __future__ import annotations

import json
from pathlib import Path

from server.routes import foreign


def write_state(path: Path, root: Path, selected: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "activeRoot": str(root),
                "roots": {
                    str(root): {
                        "selectedRepoPaths": [str(selected)],
                        "addedAt": "2026-07-12T00:00:00Z",
                        "lastSeen": "2026-07-12T00:00:00Z",
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def test_foreign_repo_profile_rejects_unselected_path(monkeypatch, tmp_path: Path):
    root = tmp_path / "root"
    selected = root / "selected"
    unselected = root / "unselected"
    selected.mkdir(parents=True)
    unselected.mkdir()
    state_file = tmp_path / "state.json"
    write_state(state_file, root, selected)
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))
    called = []
    monkeypatch.setattr(foreign._rp, "build_profile", lambda path: called.append(path))

    status, body = foreign.get_repo_profile({"params": {"repoPath": str(unselected)}})
    assert status == 403
    assert "selected" in body["error"].lower()
    assert called == []


def test_foreign_repo_profile_accepts_selected_path(monkeypatch, tmp_path: Path):
    root = tmp_path / "root"
    selected = root / "selected"
    selected.mkdir(parents=True)
    state_file = tmp_path / "state.json"
    write_state(state_file, root, selected)
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))
    monkeypatch.setattr(
        foreign._rp,
        "build_profile",
        lambda path: {"repoPath": path, "repoName": Path(path).name},
    )

    status, body = foreign.get_repo_profile({"params": {"repoPath": str(selected)}})
    assert status == 200
    assert body["repoPath"] == str(selected.resolve())
