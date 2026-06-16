"""Tests for server.wonder_launcher (F2 — wonder auto-start).

Covers:
  - launch_wonder: id allowlist, env-configurable cwd, idempotency, rollback,
    remote rejection, log persistence, state persistence.
  - wonder_launch_status: state machine (offline / starting / ready / degraded / error).
  - stop_wonder: signal process group, clear state, idempotent.
  - list_launchable: returns sorted allowlist ids.
  - HTTP routes: thin layer, error mapping, token/rate-limit left to bridge.

Pattern: monkeypatch Popen / state file / env to keep the tests hermetic.
"""

from __future__ import annotations

import json
import threading

import pytest

from server import wonder_launcher
from server.wonder_launcher import (
    ALLOWED_IDS,
    WonderLauncherError,
    launch_wonder,
    list_launchable,
    reset_state_for_tests,
    stop_wonder,
    wonder_launch_status,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def fake_repos(tmp_path, monkeypatch):
    """Create two fake repos and point the launcher at them.

    Each fake repo has a ``frontend`` subdir for LGB (since the LGB spec
    runs the UI in repo/frontend) and a top-level dir for institutum.
    """
    lgb = tmp_path / "lgb"
    lgb.mkdir()
    (lgb / "frontend").mkdir()
    lgb_python = lgb / "backend" / "library_bridge"
    lgb_python.parent.mkdir(parents=True, exist_ok=True)
    lgb_python.touch()  # so Popen can find python -m backend.library_bridge

    lab = tmp_path / "lab"
    lab.mkdir()
    (lab / "scripts" / "dev-start.sh").parent.mkdir(parents=True, exist_ok=True)
    (lab / "scripts" / "dev-start.sh").touch()

    # Point the launcher at the temp repos + temp config dir
    cfg = tmp_path / "repociv-cfg"
    cfg.mkdir()
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(cfg))
    monkeypatch.setenv("REPOCIV_WONDER_BIBLIOTHECA_DIR", str(lgb))
    monkeypatch.setenv("REPOCIV_WONDER_INSTITUTUM_DIR", str(lab))
    # Reset module-level state derived from env (paths in spec, etc.)
    monkeypatch.setattr(
        wonder_launcher,
        "WONDER_LAUNCH_SPECS",
        {
            "bibliotheca": wonder_launcher.WonderSpec(
                id="bibliotheca",
                repo_dir=str(lgb),
                procs=(
                    wonder_launcher.ProcSpec(
                        name="bridge",
                        argv=("python", "-m", "backend.library_bridge"),
                        cwd=str(lgb),
                        log="bibliotheca-bridge.log",
                    ),
                    wonder_launcher.ProcSpec(
                        name="ui",
                        argv=("npm", "run", "dev"),
                        cwd=str(lgb / "frontend"),
                        log="bibliotheca-ui.log",
                    ),
                ),
                api_url="http://127.0.0.1:3001",
                api_health_path="/api/health",
                ui_url="http://127.0.0.1:5173",
            ),
            "institutum": wonder_launcher.WonderSpec(
                id="institutum",
                repo_dir=str(lab),
                procs=(
                    wonder_launcher.ProcSpec(
                        name="dev",
                        argv=("npm", "start"),
                        cwd=str(lab),
                        log="institutum-dev.log",
                    ),
                ),
                api_url="http://127.0.0.1:5281",
                api_health_path="/health",
                ui_url="http://127.0.0.1:5280",
            ),
        },
    )
    monkeypatch.setattr(
        wonder_launcher, "ALLOWED_IDS", frozenset(wonder_launcher.WONDER_LAUNCH_SPECS.keys())
    )
    monkeypatch.setattr(wonder_launcher, "WONDERS_DIR", cfg / "wonders")
    monkeypatch.setattr(wonder_launcher, "LAUNCHED_JSON", cfg / "wonders" / "launched.json")
    monkeypatch.setattr(wonder_launcher, "LOGS_DIR", cfg / "wonders" / "logs")
    reset_state_for_tests()
    return {"lgb": lgb, "lab": lab, "cfg": cfg}


class _FakeProc:
    """Minimal Popen-like object for tests."""

    def __init__(self, pid: int = 12345):
        self.pid = pid
        self.returncode = None


@pytest.fixture
def fake_popen(monkeypatch):
    """Stub Popen so we never spawn real processes in tests."""
    counter = {"n": 0, "spawned": []}

    def fake_popen(argv, **kwargs):
        counter["n"] += 1
        counter["spawned"].append((argv, kwargs))
        return _FakeProc(pid=100000 + counter["n"])

    monkeypatch.setattr(wonder_launcher.subprocess, "Popen", fake_popen)
    return counter


# ─── launch_wonder ───────────────────────────────────────────────────────────


def test_list_launchable_returns_sorted_allowlist():
    # Built-in spec, not the fixture's override
    assert list_launchable() == sorted(ALLOWED_IDS)
    assert "bibliotheca" in list_launchable()
    assert "institutum" in list_launchable()


def test_launch_unknown_id_raises_404():
    with pytest.raises(WonderLauncherError) as exc:
        launch_wonder("nonexistent")
    assert exc.value.status == 404
    assert "unknown" in exc.value.message


def test_launch_remote_mode_rejected_403(monkeypatch, fake_repos, fake_popen):
    monkeypatch.setattr(wonder_launcher, "REPOCIV_REMOTE", True)
    with pytest.raises(WonderLauncherError) as exc:
        launch_wonder("institutum")
    assert exc.value.status == 403
    assert "remote" in exc.value.message
    # No spawn
    assert fake_popen["n"] == 0


def test_launch_repo_not_found_raises_412(monkeypatch, fake_repos, fake_popen):
    # Point at a non-existent repo
    monkeypatch.setattr(
        wonder_launcher,
        "WONDER_LAUNCH_SPECS",
        {
            "bibliotheca": wonder_launcher.WonderSpec(
                id="bibliotheca",
                repo_dir="/nonexistent/path/to/repo",
                procs=(
                    wonder_launcher.ProcSpec(
                        name="bridge",
                        argv=("python", "-m", "x"),
                        cwd="/nonexistent",
                        log="x.log",
                    ),
                ),
                api_url="http://127.0.0.1:1",
                api_health_path="/h",
                ui_url="http://127.0.0.1:1",
            ),
        },
    )
    with pytest.raises(WonderLauncherError) as exc:
        launch_wonder("bibliotheca")
    assert exc.value.status == 412
    assert "repo not found" in exc.value.message.lower()


def test_launch_succeeds_and_persists_state(fake_repos, fake_popen, monkeypatch):
    # Simulate the freshly spawned process is alive so the status is
    # "starting" (not "error" from _pid_alive returning False for our
    # fake PIDs).
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    result = launch_wonder("institutum")
    # One proc spawned
    assert fake_popen["n"] == 1
    argv, kwargs = fake_popen["spawned"][0]
    assert argv == ["npm", "start"]
    assert kwargs["cwd"] == str(fake_repos["lab"])
    assert kwargs["start_new_session"] is True
    # Status reflects starting (no API/UI up)
    assert result["status"] == "starting"
    assert result["ready"] is False
    assert result["pids"] == {"dev": 100001}
    # State persisted to JSON
    state_path = fake_repos["cfg"] / "wonders" / "launched.json"
    assert state_path.exists()
    saved = json.loads(state_path.read_text())
    assert "institutum" in saved
    assert saved["institutum"]["pids"] == {"dev": 100001}


def test_launch_bibliotheca_spawns_two_procs(fake_repos, fake_popen, monkeypatch):
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    result = launch_wonder("bibliotheca")
    assert fake_popen["n"] == 2
    assert set(result["pids"].keys()) == {"bridge", "ui"}
    # Both procs have start_new_session=True
    for _, kwargs in fake_popen["spawned"]:
        assert kwargs["start_new_session"] is True


def test_launch_is_idempotent_when_alive(fake_repos, fake_popen, monkeypatch):
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: True)
    launch_wonder("institutum")
    n_after_first = fake_popen["n"]
    # Second call must NOT spawn again
    result = launch_wonder("institutum")
    assert fake_popen["n"] == n_after_first
    assert result["status"] == "ready"


def test_launch_respawns_when_pids_exited(fake_repos, fake_popen, monkeypatch):
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    launch_wonder("institutum")
    assert fake_popen["n"] == 1
    # Simulate the spawned process dying
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: False)
    # Second call should re-spawn
    launch_wonder("institutum")
    assert fake_popen["n"] == 2


def test_launch_rollback_on_partial_failure(fake_repos, fake_popen, monkeypatch):
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)

    # First Popen succeeds, second raises
    def selective_popen(argv, **kwargs):
        if kwargs["cwd"].endswith("frontend"):
            raise OSError("simulated spawn failure")
        return _FakeProc(pid=99999)

    monkeypatch.setattr(wonder_launcher.subprocess, "Popen", selective_popen)
    with pytest.raises(WonderLauncherError) as exc:
        launch_wonder("bibliotheca")
    assert exc.value.status == 500
    assert exc.value.code == "spawn_failed"


# ─── wonder_launch_status ───────────────────────────────────────────────────


def test_status_offline_when_never_launched(fake_repos, monkeypatch):
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    s = wonder_launch_status("institutum")
    assert s["status"] == "offline"
    assert s["ready"] is False
    assert s["pids"] == {}
    assert s["api_url"] == "http://127.0.0.1:5281"
    assert s["ui_url"] == "http://127.0.0.1:5280"


def test_status_ready_when_api_and_ui_up(fake_repos, fake_popen, monkeypatch):
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: True)
    launch_wonder("institutum")
    s = wonder_launch_status("institutum")
    assert s["status"] == "ready"
    assert s["ready"] is True
    assert s["api_ready"] is True
    assert s["ui_ready"] is True


def test_status_degraded_when_only_api_up(fake_repos, fake_popen, monkeypatch):
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)

    def probe(url, timeout):
        return "/health" in url  # only API responds

    monkeypatch.setattr(wonder_launcher, "_http_probe", probe)
    launch_wonder("institutum")
    s = wonder_launch_status("institutum")
    assert s["status"] == "degraded"
    assert s["ready"] is False
    assert s["api_ready"] is True
    assert s["ui_ready"] is False


def test_status_error_when_all_pids_exited(fake_repos, fake_popen, monkeypatch):
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    launch_wonder("institutum")
    s = wonder_launch_status("institutum")
    assert s["status"] == "error"
    assert s["error"] is not None


def test_status_unknown_id_raises_404():
    with pytest.raises(WonderLauncherError) as exc:
        wonder_launch_status("nonexistent")
    assert exc.value.status == 404


# ─── stop_wonder ────────────────────────────────────────────────────────────


def test_stop_unknown_id_raises_404():
    with pytest.raises(WonderLauncherError) as exc:
        stop_wonder("nonexistent")
    assert exc.value.status == 404


def test_stop_when_not_launched_returns_ok_false(fake_repos, monkeypatch):
    result = stop_wonder("institutum")
    assert result["ok"] is False
    assert "not launched" in result["error"]


def test_stop_kills_pids_and_clears_state(fake_repos, fake_popen, monkeypatch):
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    launch_wonder("institutum")
    killed: list[int] = []

    def fake_killpg(pid, sig):
        killed.append(pid)

    monkeypatch.setattr(wonder_launcher.os, "killpg", fake_killpg)
    result = stop_wonder("institutum")
    assert result["ok"] is True
    assert killed == [100001]
    # State cleared from disk
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    assert "institutum" not in state
    # And the in-memory cache
    s = wonder_launch_status("institutum")
    assert s["status"] == "offline"


# ─── get_spec / safety ──────────────────────────────────────────────────────


def test_get_spec_rejects_unknown():
    with pytest.raises(WonderLauncherError) as exc:
        wonder_launcher.get_spec("gaceta")  # gaceta is native, not launchable
    assert exc.value.status == 404


def test_log_file_written_on_spawn(fake_repos, fake_popen, monkeypatch):
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    launch_wonder("institutum")
    # Use the live module attribute so the monkeypatch is respected
    # (LOG_FILES_DIR was re-pointed by fake_repos).
    log = wonder_launcher.LOGS_DIR / "institutum-dev.log"
    assert log.exists()
    # The file handle was opened in "ab" (append) mode; we don't assert content
    # because the process never actually wrote anything (fake Popen).


def test_concurrent_launch_uses_lock(fake_repos, fake_popen, monkeypatch):
    """Two threads calling launch_wonder for the same id should spawn at most once."""
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    results = []

    def worker():
        try:
            results.append(launch_wonder("institutum"))
        except Exception as e:
            results.append(e)

    t1 = threading.Thread(target=worker)
    t2 = threading.Thread(target=worker)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    # One spawn (the second call short-circuited on the lock)
    assert fake_popen["n"] == 1


# ─── routes/wonder_ops thin layer ───────────────────────────────────────────


def test_routes_map_wonder_launcher_errors():
    from server.routes import wonder_ops

    with pytest.raises(WonderLauncherError):
        launch_wonder("nonexistent")
    status, body = wonder_ops.post_wonder_launch({"id": "nonexistent"}, {})
    assert status == 404
    assert body["ok"] is False
    assert body["code"] == "unknown_wonder"


def test_routes_stop_returns_200_or_400(fake_repos):
    from server.routes import wonder_ops

    # Not launched → 400
    s, b = wonder_ops.post_wonder_stop({"id": "institutum"}, {})
    assert s == 400
    assert b["ok"] is False


def test_routes_launchable_lists_ids():
    from server.routes import wonder_ops

    s, b = wonder_ops.get_wonder_launchable({})
    assert s == 200
    assert b["ok"] is True
    assert sorted(b["launchable"]) == sorted(ALLOWED_IDS)
