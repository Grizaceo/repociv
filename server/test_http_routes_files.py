from __future__ import annotations

import base64
import json

from server import http_routes
from server.routes import foreign as foreign_routes


def _encode_repo_id(path: str) -> str:
    return "repo:" + base64.urlsafe_b64encode(path.encode("utf-8")).decode("ascii").rstrip("=")


def _write_state(monkeypatch, tmp_path, root: str) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text(
        json.dumps({"version": 1, "activeRoot": root, "roots": {root: {"selectedRepoPaths": []}}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))


def test_get_repo_file_tree_uses_active_root_for_plain_repo_id(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    repo = root / "alpha"
    (repo / "src").mkdir(parents=True)
    (repo / "src" / "main.ts").write_text("console.log('ok')\n", encoding="utf-8")

    _write_state(monkeypatch, tmp_path, str(root))

    status, body = http_routes.get_repo_file_tree({"path": "/api/files/alpha"})

    assert status == 200
    assert body["repoId"] == "alpha"
    assert "alpha/src/main.ts" in body["files"]
    assert body["tree"]["name"] == "alpha"


def test_get_repo_file_tree_decodes_repo_id_and_returns_tree_and_files(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    repo = root / "beta"
    (repo / "docs").mkdir(parents=True)
    (repo / "docs" / "README.md").write_text("# beta\n", encoding="utf-8")
    repo_id = _encode_repo_id(str(repo))

    _write_state(monkeypatch, tmp_path, str(root))

    status, body = http_routes.get_repo_file_tree({"path": f"/api/files/{repo_id}"})

    assert status == 200
    assert body["repoId"] == repo_id
    assert "beta/docs/README.md" in body["files"]
    assert body["tree"]["path"] == "beta"


def test_get_repo_file_tree_rejects_repo_symlink_outside_root(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "leak.txt").write_text("secret\n", encoding="utf-8")
    (root / "evil").symlink_to(outside)

    _write_state(monkeypatch, tmp_path, str(root))

    status, body = http_routes.get_repo_file_tree({"path": "/api/files/evil"})

    assert status == 403
    assert "outside allowed root" in body["error"]


def test_get_repo_file_tree_skips_symlink_escape_inside_repo(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    repo = root / "alpha"
    repo.mkdir(parents=True)
    (repo / "ok.txt").write_text("ok\n", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret\n", encoding="utf-8")
    (repo / "escape").symlink_to(outside)

    _write_state(monkeypatch, tmp_path, str(root))

    status, body = http_routes.get_repo_file_tree({"path": "/api/files/alpha"})

    assert status == 200
    assert "alpha/ok.txt" in body["files"]
    assert not any("secret" in path for path in body["files"])


def test_get_repo_file_tree_rejects_encoded_path_outside_root(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "x.txt").write_text("x\n", encoding="utf-8")

    _write_state(monkeypatch, tmp_path, str(root))

    repo_id = _encode_repo_id(str(outside))
    status, body = http_routes.get_repo_file_tree({"path": f"/api/files/{repo_id}"})

    assert status == 403
    assert "outside allowed root" in body["error"]


def test_get_repo_file_tree_rejects_excessive_depth(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    repo = root / "deep"
    path = repo
    for i in range(foreign_routes._FILE_TREE_MAX_DEPTH + 2):
        path.mkdir(parents=True, exist_ok=True)
        path = path / f"level{i}"

    _write_state(monkeypatch, tmp_path, str(root))

    status, body = http_routes.get_repo_file_tree({"path": "/api/files/deep"})

    assert status == 400
    assert "max depth" in body["error"]


def test_get_repo_file_tree_rejects_too_many_files(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    repo = root / "many"
    repo.mkdir(parents=True)
    monkeypatch.setattr(foreign_routes, "_FILE_TREE_MAX_FILES", 5)
    for i in range(6):
        (repo / f"file{i}.txt").write_text(f"{i}\n", encoding="utf-8")

    _write_state(monkeypatch, tmp_path, str(root))

    status, body = http_routes.get_repo_file_tree({"path": "/api/files/many"})

    assert status == 400
    assert "max file count" in body["error"]
