from __future__ import annotations

import base64
import json

from server import http_routes


def _encode_repo_id(path: str) -> str:
    return "repo:" + base64.urlsafe_b64encode(path.encode("utf-8")).decode("ascii").rstrip("=")


def test_get_repo_file_tree_uses_active_root_for_plain_repo_id(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    repo = root / "alpha"
    (repo / "src").mkdir(parents=True)
    (repo / "src" / "main.ts").write_text("console.log('ok')\n", encoding="utf-8")

    state_file = tmp_path / "state.json"
    state_file.write_text(
        json.dumps({"version": 1, "activeRoot": str(root), "roots": {str(root): {"selectedRepoPaths": []}}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))

    status, body = http_routes.get_repo_file_tree({"path": "/api/files/alpha"})

    assert status == 200
    assert body["repoId"] == "alpha"
    assert "alpha/src/main.ts" in body["files"]
    assert body["tree"]["name"] == "alpha"


def test_get_repo_file_tree_decodes_repo_id_and_returns_tree_and_files(monkeypatch, tmp_path):
    repo = tmp_path / "beta"
    (repo / "docs").mkdir(parents=True)
    (repo / "docs" / "README.md").write_text("# beta\n", encoding="utf-8")
    repo_id = _encode_repo_id(str(repo))

    monkeypatch.setenv("REPOCIV_STATE_FILE", str(tmp_path / "missing-state.json"))

    status, body = http_routes.get_repo_file_tree({"path": f"/api/files/{repo_id}"})

    assert status == 200
    assert body["repoId"] == repo_id
    assert "beta/docs/README.md" in body["files"]
    assert body["tree"]["path"] == "beta"
