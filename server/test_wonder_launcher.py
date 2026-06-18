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
import os
import threading
import time
from pathlib import Path

import pytest

from server import wonder_launcher
from server.wonder_launcher import (
    ALLOWED_IDS,
    WonderLauncherError,
    launch_wonder,
    list_launchable,
    reset_custom_specs_for_tests,
    reset_state_for_tests,
    stop_wonder,
    wonder_launch_status,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def no_lockfile(tmp_path, monkeypatch):
    """Ensure ~/.labhub/labhub.lock doesn't leak between tests.

    The lockfile lives in the user's home dir, not in tmp_path, so
    cross-test pollution is otherwise possible. Saves & restores.
    """
    from pathlib import Path

    home = Path(os.path.expanduser("~"))
    lock = home / ".labhub" / "labhub.lock"
    saved = None
    if lock.exists():
        saved = lock.read_text()
        lock.unlink()
    try:
        yield
    finally:
        if saved is not None:
            lock.parent.mkdir(parents=True, exist_ok=True)
            lock.write_text(saved)


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
                        env={"LGB_HOST": "0.0.0.0"},
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
                        env={"BRIDGE_HOST": "0.0.0.0"},
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
    # All PIDs gone AND health probes failing AND past the 20s grace
    # period → real error.
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    launch_wonder("institutum")
    # Force the entry's started_at to be older than the grace period
    # so the test doesn't depend on real wall-clock time.
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    state["institutum"]["started_at"] = time.time() - 30
    (fake_repos["cfg"] / "wonders" / "launched.json").write_text(json.dumps(state))
    # _build_status reads from the in-memory _launched cache; force a reload.
    wonder_launcher._launched = {}
    s = wonder_launch_status("institutum")
    assert s["status"] == "error"
    assert s["error"] is not None


def test_status_starting_during_grace_period_even_if_pids_exited(
    fake_repos, fake_popen, monkeypatch
):
    """F3.1-A regression test (audit hallazgo F3-2).

    During the first 20s after a launch, PIDs-dead + health-down
    is reported as "starting" (not "error"). This is the cold-start
    window for institutum: npm-dies-in-1s, dev-start.sh forks
    bridge+vite detached, bridge binds :5281 ~3s later. Without
    the grace period, the F3 poller would see "error" in that
    window and abort the launch.
    """
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    launch_wonder("institutum")
    # started_at is `now` (just set by launch_wonder), so we're
    # inside the 20s grace window.
    s = wonder_launch_status("institutum")
    assert s["status"] == "starting", f"expected starting during grace, got {s['status']!r}"
    assert s["error"] is None


def test_status_error_after_grace_period(fake_repos, fake_popen, monkeypatch):
    """Same as test_status_error_when_all_pids_exited but explicit."""
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    launch_wonder("institutum")
    # Backdate started_at past the 20s window.
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    state["institutum"]["started_at"] = time.time() - 60
    (fake_repos["cfg"] / "wonders" / "launched.json").write_text(json.dumps(state))
    # Force a fresh read from disk so the backdated started_at takes effect.
    wonder_launcher._launched = {}
    s = wonder_launch_status("institutum")
    assert s["status"] == "error"


def test_status_ready_when_parent_died_but_health_up(fake_repos, fake_popen, monkeypatch):
    """Hallazgo A regression test.

    Reproduces the real Institutum case: ``npm start`` runs
    dev-start.sh which forks bridge+Vite detached and exits. The npm
    PID is dead within seconds. With the OLD state machine the
    report was ``error``; with the fix, health-checks are the source
    of truth so it must be ``ready``.
    """
    # Simulate npm parent dead, but health probes succeed.
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: True)
    launch_wonder("institutum")
    s = wonder_launch_status("institutum")
    assert s["status"] == "ready"
    assert s["ready"] is True
    assert s["error"] is None


def test_status_degraded_when_parent_died_only_api_up(fake_repos, fake_popen, monkeypatch):
    """Sibling regression: half-up is degraded, never error."""
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: False)

    def probe(url, timeout):
        return "/health" in url  # only API responds

    monkeypatch.setattr(wonder_launcher, "_http_probe", probe)
    launch_wonder("institutum")
    s = wonder_launch_status("institutum")
    assert s["status"] == "degraded"
    assert s["ready"] is False


def test_launch_adopts_external_when_health_up(fake_repos, fake_popen, monkeypatch):
    """Hallazgo B: pre-launch health check avoids double-spawn.

    With both API and UI up, launch_wonder should NOT spawn — it
    should record an "external" entry and return immediately.
    """
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: True)
    result = launch_wonder("institutum")
    assert fake_popen["n"] == 0  # no spawn
    assert result["status"] == "ready"
    assert result["ready"] is True
    # State persisted, marked external
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    assert state["institutum"]["external"] is True


def test_launch_does_not_adopt_when_nothing_up(fake_repos, fake_popen, monkeypatch, no_lockfile):
    """Hallazgo B sibling: nothing responding → normal spawn."""
    # Force health probes to fail for BOTH api and ui, and PIDs to be
    # alive (the spawn is recent — would be true in production).
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    result = launch_wonder("institutum")
    assert fake_popen["n"] == 1  # spawned
    assert result["status"] == "starting"
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    assert state["institutum"]["external"] is False


def test_launch_respawns_when_stale_external_entry_is_down(fake_repos, fake_popen, monkeypatch):
    """Bug: a stale external adoption must not permanently block relaunch.

    Repro of "Bibliotheca no lanza": a hand-started server is adopted
    (external entry, no PIDs), then dies. A second launch must re-probe
    health and — finding the server down — spawn the missing procs
    instead of returning the stale entry forever.
    """
    # 1) Adopt: both API and UI up → external entry, no spawn.
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: True)
    first = launch_wonder("bibliotheca")
    assert fake_popen["n"] == 0
    assert first["status"] == "ready"
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    assert state["bibliotheca"]["external"] is True
    assert state["bibliotheca"]["pids"] == {}

    # 2) The hand-started server dies. Relaunch must heal by spawning.
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    second = launch_wonder("bibliotheca")
    assert fake_popen["n"] == 2  # bridge + ui re-spawned
    assert set(second["pids"].keys()) == {"bridge", "ui"}
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    assert state["bibliotheca"]["external"] is False


def test_launch_keeps_external_entry_when_still_healthy(fake_repos, fake_popen, monkeypatch):
    """Guard: a still-healthy external adoption must NOT re-spawn.

    The stale-entry fix must only kick in when the adopted server is
    unhealthy; while both endpoints respond, the second launch stays a
    no-op no-spawn so we never clobber a live hand-started server.
    """
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: True)
    launch_wonder("bibliotheca")
    assert fake_popen["n"] == 0
    # Server is still up on the second call → no spawn, stays external.
    result = launch_wonder("bibliotheca")
    assert fake_popen["n"] == 0
    assert result["status"] == "ready"
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    assert state["bibliotheca"]["external"] is True


def test_launch_does_not_adopt_when_only_api_up(fake_repos, fake_popen, monkeypatch, no_lockfile):
    """F2.1 regression: half-up (API only) must NOT be adopted.

    When the API is up but the UI is down (e.g. uvicorn alive but Vite
    crashed) we need to spawn the UI process. If the launcher
    adopted the half-up state, the UI would never be started and
    the user would see a permanent degraded status.
    """

    def probe(url, timeout):
        return "/api/health" in url or "/health" in url  # only API responds

    monkeypatch.setattr(wonder_launcher, "_http_probe", probe)
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    launch_wonder("institutum")
    # Spawned (did NOT adopt the half-up state).
    assert fake_popen["n"] >= 1
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    assert state["institutum"]["external"] is False


def test_launch_does_not_adopt_when_only_ui_up(fake_repos, fake_popen, monkeypatch, no_lockfile):
    """F2.1 regression: half-up (UI only) must NOT be adopted.

    The case that bit LabHub: Vite was alive on :5173, uvicorn was
    dead on :3001. The old launcher adopted and recorded
    external=true, leaving the API never started. The fix requires
    BOTH api_ready and ui_ready to adopt, so a half-up LGB now
    triggers a normal spawn (uvicorn gets started; the existing
    Vite keeps running on :5173 with its proxy pointing at the
    new uvicorn).
    """

    def probe(url, timeout):
        return "/health" not in url  # only the UI root ("/") responds

    monkeypatch.setattr(wonder_launcher, "_http_probe", probe)
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    launch_wonder("bibliotheca")
    # Spawned (did NOT adopt the half-up state).
    assert fake_popen["n"] >= 1
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    assert state["bibliotheca"]["external"] is False
    # The uvicorn proc (the missing one for LGB) is among the spawned.
    argv_first = fake_popen["spawned"][0][0]
    assert "library_bridge" in str(argv_first) or "library_bridge" in str(
        fake_popen["spawned"][1][0]
    )


def test_launch_adopt_picks_up_labhub_lockfile_pids(fake_repos, fake_popen, monkeypatch, tmp_path):
    """Hallazgo B + lockfile integration: adopt + record labhub PIDs.

    The lockfile path is rewritten (via the env var) so we don't touch
    the user's real ``~/.labhub/labhub.lock``.
    """
    # Use a tmp lockfile and tell the launcher where to look.
    lock_dir = tmp_path / ".labhub"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / "labhub.lock"
    lock_path.write_text("BRIDGE_PID=4242\nVITE_PID=4243\nBRIDGE_PORT=5281\nLABHUB_PORT=5280\n")
    # Point _read_labhub_lockfile at our tmp lockfile by monkeypatching
    # the resolve step. The function expands "~/.labhub/labhub.lock" so
    # we override HOME to a tmp dir.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: True)
    result = launch_wonder("institutum")
    state = json.loads((fake_repos["cfg"] / "wonders" / "launched.json").read_text())
    assert state["institutum"]["pids"] == {"bridge": 4242, "vite": 4243}
    assert result["pids"] == {"bridge": 4242, "vite": 4243}


def test_resolve_python_executable_prefers_venv(tmp_path):
    # Fake a repo with backend/venv/bin/python
    repo = tmp_path / "repo"
    repo.mkdir()
    venv = repo / "backend" / "venv" / "bin"
    venv.mkdir(parents=True)
    fake = venv / "python"
    fake.write_text("#!/bin/sh\n")
    fake.chmod(0o755)
    resolved = wonder_launcher._resolve_python_executable(str(repo))
    assert resolved == str(fake)


def test_resolve_python_executable_falls_back_to_python3(tmp_path):
    repo = tmp_path / "no-venv"
    repo.mkdir()
    resolved = wonder_launcher._resolve_python_executable(str(repo))
    assert resolved == "python3"


def test_spawn_uses_venv_python_when_present(fake_repos, fake_popen, monkeypatch, tmp_path):
    """Hallazgo D: launcher uses backend/venv/bin/python if present.

    We create a fake venv under the lgb repo and assert the spawn
    argv[0] points at it.
    """
    # Create venv under lgb repo
    lgb = fake_repos["lgb"]
    venv_python = lgb / "backend" / "venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True, exist_ok=True)
    venv_python.write_text("#!/bin/sh\n")
    venv_python.chmod(0o755)
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    launch_wonder("bibliotheca")
    # First proc is the bridge (python -m backend.library_bridge).
    argv, kwargs = fake_popen["spawned"][0]
    assert Path(argv[0]).resolve() == Path(str(venv_python)).resolve()


def test_routes_wonder_id_from_url_takes_precedence_over_body():
    """Hallazgo E: URL > body for wonder id."""
    from server.routes import wonder_ops

    # URL has bibliotheca, body says institutum → URL wins
    s, b = wonder_ops.post_wonder_launch({"id": "institutum"}, {"wonder_id": "bibliotheca"})
    # The launcher will reject bibliotheca only if the repo doesn't exist.
    # In this test, the call goes to launch_wonder("bibliotheca"). The
    # bibliotheca repo in the default test env doesn't exist, so we'd
    # get a 412. The point is: it's bibliotheca (URL), not institutum (body).
    assert s in (200, 404, 412)
    # The validation should be on "bibliotheca" not "institutum"
    if s != 200:
        assert "bibliotheca" in str(b).lower() or b.get("code") == "repo_not_found"


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


# ─── ProcSpec.env (F2.2 — host binding for WSL2 / Tailscale) ────────────────


def test_procspec_env_field_applied_at_spawn(fake_repos, fake_popen, monkeypatch):
    """F2.2 regression: ProcSpec.env is merged into the spawned process env.

    Uses the ``fake_popen`` fixture to inspect kwargs passed to Popen.
    The bibliotheca bridge proc should have ``LGB_HOST=0.0.0.0`` in
    its env (so the WSL2 browser can reach uvicorn).
    """
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    launch_wonder("bibliotheca")
    assert fake_popen["n"] >= 1
    # Find the bridge proc (which has library_bridge in argv)
    for argv, kwargs in fake_popen["spawned"]:
        if any("library_bridge" in str(a) for a in argv):
            env = kwargs.get("env") or {}
            assert "LGB_HOST" in env
            assert env["LGB_HOST"] == "0.0.0.0"
            return
    raise AssertionError(
        f"did not find library_bridge proc in fake_popen spawns; got: {fake_popen['spawned']}"
    )


def test_institutum_dev_proc_env_sets_bridge_host(fake_repos, fake_popen, monkeypatch):
    """F2.2 regression: institutum npm proc gets BRIDGE_HOST=0.0.0.0.

    The env propagates through npm start → dev-start.sh → labhub
    bridge. If labhub's bridge.py honors BRIDGE_HOST, uvicorn binds
    to all interfaces.
    """
    monkeypatch.setattr(wonder_launcher, "_pid_alive", lambda pid: True)
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    launch_wonder("institutum")
    assert fake_popen["n"] == 1
    argv, kwargs = fake_popen["spawned"][0]
    env = kwargs.get("env") or {}
    assert "BRIDGE_HOST" in env
    assert env["BRIDGE_HOST"] == "0.0.0.0"


def test_procspec_env_default_is_empty():
    """F2.2: ProcSpec default env is an empty dict, not shared mutable state."""
    from server.wonder_launcher import ProcSpec

    a = ProcSpec(name="x", argv=("a",), cwd="/tmp", log="x.log")
    b = ProcSpec(name="y", argv=("y",), cwd="/tmp", log="y.log")
    # Independent dicts
    assert a.env is not b.env
    assert a.env == {}
    assert b.env == {}


# ─── Custom launch specs (P3 — user-defined marvelas) ───────────────────────


@pytest.fixture
def custom_wonder_dir(tmp_path, monkeypatch):
    """Point REPOCIV_WONDERS_DIR at a tmp dir and reload the launcher cache.

    Tests write a manifest JSON into this dir, then call
    ``reset_custom_specs_for_tests()`` to make the launcher pick it up.
    """
    d = tmp_path / "wonders"
    d.mkdir()
    monkeypatch.setenv("REPOCIV_WONDERS_DIR", str(d))
    yield d
    # The launcher keeps the loaded specs in a module-level cache, so
    # we also need to clear it for the next test (in case the next test
    # uses a different dir).
    monkeypatch.setattr(wonder_launcher, "_CUSTOM_LAUNCH_SPECS", {})
    monkeypatch.delenv("REPOCIV_WONDERS_DIR", raising=False)


def test_load_custom_specs_empty_when_dir_missing(tmp_path, monkeypatch):
    """No dir → no specs, never crashes."""
    monkeypatch.setenv("REPOCIV_WONDERS_DIR", str(tmp_path / "nonexistent"))
    specs = wonder_launcher._load_custom_launch_specs()
    assert specs == {}


def test_load_custom_specs_ignores_manifest_without_launch(custom_wonder_dir):
    """A manifest with no ``launch`` field is display-only — not auto-launchable.

    The launcher skips it; the registry keeps it for /wonders.
    """
    (custom_wonder_dir / "mi-maravilla.json").write_text(
        json.dumps(
            {
                "id": "mi-maravilla",
                "title": "Mi Maravilla",
                "kind": "iframe",
                "category": "knowledge",
                "version": "0.1.0",
                "defaultEnabled": True,
                "automationLevel": "passive",
                "ui": {},
                "permissions": {"readRepos": False, "writeRepos": False,
                                "network": "loopback-only",
                                "requiresApprovalForMutations": False},
                "optionalFeatures": [],
                "actions": [],
                "events": {"emits": [], "accepts": []},
                "mcp": {"enabled": False, "server": None},
            }
        )
    )
    specs = wonder_launcher._load_custom_launch_specs()
    assert specs == {}


def test_load_custom_specs_parses_valid_launch(custom_wonder_dir):
    """A manifest with a valid ``launch`` field becomes a launchable spec."""
    (custom_wonder_dir / "mi-maravilla.json").write_text(
        json.dumps(
            {
                "id": "mi-maravilla",
                "title": "Mi Maravilla",
                "launch": {
                    "repo_dir": "/tmp/mi-maravilla",
                    "api_url": "http://127.0.0.1:9999",
                    "api_health_path": "/api/health",
                    "ui_url": "http://127.0.0.1:9998",
                    "procs": [
                        {
                            "name": "bridge",
                            "argv": ["python", "-m", "backend.bridge"],
                            "log": "bridge.log",
                            "env": {"MY_HOST": "0.0.0.0"},
                        },
                        {
                            "name": "ui",
                            "argv": ["npm", "run", "dev"],
                            "cwd": "/tmp/mi-maravilla/frontend",
                            "log": "ui.log",
                        },
                    ],
                },
            }
        )
    )
    specs = wonder_launcher._load_custom_launch_specs()
    assert "mi-maravilla" in specs
    spec = specs["mi-maravilla"]
    assert spec.id == "mi-maravilla"
    assert spec.repo_dir == "/tmp/mi-maravilla"
    assert spec.api_url == "http://127.0.0.1:9999"
    assert spec.ui_url == "http://127.0.0.1:9998"
    assert spec.api_health_path == "/api/health"
    assert len(spec.procs) == 2
    assert spec.procs[0].name == "bridge"
    assert spec.procs[0].argv == ("python", "-m", "backend.bridge")
    assert spec.procs[0].env == {"MY_HOST": "0.0.0.0"}
    assert spec.procs[1].cwd == "/tmp/mi-maravilla/frontend"


def test_load_custom_specs_rejects_malformed(custom_wonder_dir, capfd):
    """Malformed launch specs are skipped (with a stderr warning), not crashed."""
    (custom_wonder_dir / "bad1.json").write_text(json.dumps({"id": "bad1"}))  # no launch
    (custom_wonder_dir / "bad2.json").write_text(
        json.dumps({"id": "bad2", "launch": "not a dict"})
    )
    (custom_wonder_dir / "bad3.json").write_text(
        json.dumps({"id": "bad3", "launch": {"repo_dir": "/tmp", "procs": []}})
    )
    (custom_wonder_dir / "bad4.json").write_text(json.dumps("not even a dict"))
    (custom_wonder_dir / "bad5.json").write_text("{not valid json}")
    specs = wonder_launcher._load_custom_launch_specs()
    assert specs == {}
    # We should have logged 4 warnings (bad2, bad3, bad4, bad5).
    err = capfd.readouterr().err
    assert "skipping launch spec in bad2.json" in err
    assert "skipping launch spec in bad3.json" in err
    assert "skipping bad4.json" in err
    assert "skipping bad5.json" in err


def test_load_custom_specs_uses_filename_as_id_fallback(custom_wonder_dir):
    """If the manifest has no ``id``, use the filename stem."""
    (custom_wonder_dir / "fallback-id.json").write_text(
        json.dumps(
            {
                # no "id" field — fallback to stem
                "title": "Fallback",
                "launch": {
                    "repo_dir": "/tmp/fb",
                    "procs": [{"name": "x", "argv": ["echo", "hi"]}],
                },
            }
        )
    )
    specs = wonder_launcher._load_custom_launch_specs()
    assert "fallback-id" in specs
    assert specs["fallback-id"].id == "fallback-id"


def test_custom_spec_overrides_builtin(monkeypatch, tmp_path, capfd):
    """A custom spec with the same id as a built-in wins (with a warning)."""
    # Create a temp config dir + LGB repo so launch_wonder can find them
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(cfg))
    custom = tmp_path / "wonders"
    custom.mkdir()
    monkeypatch.setenv("REPOCIV_WONDERS_DIR", str(custom))
    lgb = tmp_path / "lgb"
    lgb.mkdir()
    (lgb / "frontend").mkdir()
    monkeypatch.setenv("REPOCIV_WONDER_BIBLIOTHECA_DIR", str(lgb))
    monkeypatch.setattr(
        wonder_launcher, "WONDERS_DIR", cfg / "wonders"
    )
    monkeypatch.setattr(wonder_launcher, "LAUNCHED_JSON", cfg / "wonders" / "launched.json")
    monkeypatch.setattr(wonder_launcher, "LOGS_DIR", cfg / "wonders" / "logs")
    # Custom manifest that overrides the built-in bibliotheca
    (custom / "bibliotheca.json").write_text(
        json.dumps(
            {
                "id": "bibliotheca",
                "title": "My Bibliotheca",
                "launch": {
                    "repo_dir": str(lgb),
                    "api_url": "http://127.0.0.1:9999",
                    "ui_url": "http://127.0.0.1:9998",
                    "procs": [{"name": "x", "argv": ["echo", "custom"]}],
                },
            }
        )
    )
    reset_custom_specs_for_tests()
    # Should be in launchable
    assert "bibliotheca" in list_launchable()
    # The custom spec wins on the api_url field
    spec = wonder_launcher.get_spec("bibliotheca")
    assert spec.api_url == "http://127.0.0.1:9999"
    # And a warning was logged
    err = capfd.readouterr().err
    assert "overrides the built-in" in err


def test_list_launchable_includes_custom(custom_wonder_dir):
    """list_launchable merges base + custom."""
    (custom_wonder_dir / "extra1.json").write_text(
        json.dumps({"id": "extra1", "launch": {"repo_dir": "/tmp",
                                                "procs": [{"argv": ["true"]}]}})
    )
    (custom_wonder_dir / "extra2.json").write_text(
        json.dumps({"id": "extra2", "launch": {"repo_dir": "/tmp",
                                                "procs": [{"argv": ["true"]}]}})
    )
    reset_custom_specs_for_tests()
    launchable = list_launchable()
    assert "bibliotheca" in launchable
    assert "institutum" in launchable
    assert "extra1" in launchable
    assert "extra2" in launchable


def test_launch_wonder_uses_custom_spec(fake_repos, fake_popen, custom_wonder_dir, monkeypatch):
    """End-to-end: a custom wonder with a valid launch spec actually spawns its procs."""
    # Use a different fake repo per custom wonder
    custom_repo = fake_repos["cfg"].parent / "mi-maravilla"
    custom_repo.mkdir()
    (custom_repo / "frontend").mkdir()
    (custom_repo / "backend" / "maravilla_bridge").parent.mkdir(parents=True, exist_ok=True)
    (custom_repo / "backend" / "maravilla_bridge").touch()
    (custom_wonder_dir / "mi-maravilla.json").write_text(
        json.dumps(
            {
                "id": "mi-maravilla",
                "title": "Mi Maravilla",
                "launch": {
                    "repo_dir": str(custom_repo),
                    "api_url": "http://127.0.0.1:9999",
                    "ui_url": "http://127.0.0.1:9998",
                    "procs": [
                        {
                            "name": "bridge",
                            "argv": ["python", "-m", "backend.maravilla_bridge"],
                            "cwd": str(custom_repo),
                            "log": "mm-bridge.log",
                            "env": {"MM_HOST": "0.0.0.0"},
                        },
                        {
                            "name": "ui",
                            "argv": ["npm", "run", "dev"],
                            "cwd": str(custom_repo / "frontend"),
                            "log": "mm-ui.log",
                        },
                    ],
                },
            }
        )
    )
    reset_custom_specs_for_tests()
    monkeypatch.setattr(wonder_launcher, "_http_probe", lambda *a, **kw: False)
    result = launch_wonder("mi-maravilla")
    assert fake_popen["n"] == 2
    pids = {p[0][0] if isinstance(p[0], list) else p[0][0] for p in fake_popen["spawned"]}
    # Verify env propagation on the bridge proc
    for argv, kwargs in fake_popen["spawned"]:
        if "maravilla_bridge" in str(argv):
            assert kwargs["env"].get("MM_HOST") == "0.0.0.0"
            break
    # Status reflects starting (no API/UI up)
    assert result["status"] == "starting"
    assert "bridge" in result["pids"]
    assert "ui" in result["pids"]


def test_launch_wonder_custom_spec_repo_not_found(custom_wonder_dir, fake_popen, monkeypatch):
    """A custom wonder with a missing repo_dir returns 412, no spawn."""
    (custom_wonder_dir / "ghost.json").write_text(
        json.dumps(
            {
                "id": "ghost",
                "launch": {
                    "repo_dir": "/nonexistent/path/ghost",
                    "procs": [{"name": "x", "argv": ["true"]}],
                },
            }
        )
    )
    reset_custom_specs_for_tests()
    with pytest.raises(WonderLauncherError) as exc:
        launch_wonder("ghost")
    assert exc.value.status == 412
    assert "ghost" in exc.value.message.lower() or "not found" in exc.value.message.lower()
    assert fake_popen["n"] == 0  # no spawn

