"""Pytest configuration for backend tests."""
import os
import sys
import tempfile
from pathlib import Path
import importlib

import pytest

# ─── Hermetic state ───────────────────────────────────────────────────────────
# Runs at conftest import, before any server module computes its store paths.
# Every store resolves through $HOME, REPOCIV_CONFIG_DIR (server.state_paths)
# or XDG_*, so pointing all of them into one throwaway root keeps the suite out
# of the operator's live ~/.repociv (security log, token ledger, events…) and
# ~/.local/state. Assignments are unconditional on purpose: a developer shell
# or .env exporting REPOCIV_CONFIG_DIR=~/.repociv must not win here.
REAL_HOME = Path.home().resolve()
_ISOLATED_DIRS = {
    "HOME": "home",
    "REPOCIV_CONFIG_DIR": "repociv",
    "XDG_STATE_HOME": "xdg/state",
    "XDG_CONFIG_HOME": "xdg/config",
    "XDG_DATA_HOME": "xdg/data",
    "XDG_CACHE_HOME": "xdg/cache",
}


def _reusable_root() -> Path | None:
    """An isolated root this process already applied (nested pytest.main)."""
    raw = os.environ.get("REPOCIV_TEST_ROOT", "")
    if not raw:
        return None
    root = Path(raw)
    tmp = Path(tempfile.gettempdir()).resolve()
    if not root.is_dir() or not root.resolve().is_relative_to(tmp):
        return None
    if any(os.environ.get(v) != str(root / sub) for v, sub in _ISOLATED_DIRS.items()):
        return None
    return root


TEST_ROOT = _reusable_root() or Path(tempfile.mkdtemp(prefix="repociv-test-")).resolve()
os.environ["REPOCIV_TEST_ROOT"] = str(TEST_ROOT)
for _var, _sub in _ISOLATED_DIRS.items():
    (TEST_ROOT / _sub).mkdir(parents=True, exist_ok=True)
    os.environ[_var] = str(TEST_ROOT / _sub)
# Store-specific overrides and live-service pointers fall back to the isolated
# root (or to "not configured") instead of whatever the shell exported.
for _var in (
    "REPOCIV_DATA_DIR", "REPOCIV_STATE_DIR", "REPOCIV_STATE_FILE", "REPOCIV_WONDERS_DIR",
    "REPOCIV_PENDING_WORK_STATE_FILE", "REPOCIV_PENDING_LOCAL_FILE", "REPOCIV_HERMES_HOME",
    "REPOCIV_MCODE_HOME",
    "REPOCIV_DEVIN_DATA_DIR", "REPOCIV_OPENCODE_DATA_DIR", "REPOCIV_KANBAN_DIR",
    "REPOCIV_MAP_ROOT", "WORKSPACE_ROOT", "REPOCIV_REPOS_ROOT", "REPOCIV_TOKEN",
    "HERMES_ROOT", "HERMES_URL", "HERMES_KEY", "CODEX_HOME", "CDAILY_DB_PATH",
    "HERMES_GATEWAY_LOCK_DIR",
):
    os.environ.pop(_var, None)
os.environ["REPOCIV_SKIP_DOTENV"] = "1"

sys.path.insert(0, str(Path(__file__).parent / "server"))


@pytest.fixture(autouse=True, scope="session")
def _hermetic_state_guard():
    """Fail loudly if anything re-pointed the suite at the real home."""
    from server.state_paths import repociv_home

    assert Path.home().resolve() == TEST_ROOT / "home"
    assert repociv_home().resolve() == TEST_ROOT / "repociv"
    assert REAL_HOME not in repociv_home().resolve().parents
    yield


@pytest.fixture
def isolated_approval_store(tmp_path):
    """Restore both the environment and pre-existing singleton state."""
    from server import approval_store as store

    state = {name: getattr(store, name) for name in
             ("_lock", "_loaded", "_approvals", "_APPROVAL_TTL_S")}
    config = tmp_path / "approval_config"
    config.mkdir()
    try:
        with pytest.MonkeyPatch.context() as mp:
            mp.setenv("REPOCIV_CONFIG_DIR", str(config))
            mp.delenv("REPOCIV_APPROVAL_TTL_S", raising=False)
            importlib.reload(store)
            yield config
    finally:
        # The context restores env first; retain any caller's cached approvals.
        for name, value in state.items():
            setattr(store, name, value)
