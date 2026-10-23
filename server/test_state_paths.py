"""State-root resolution and the no-hardcoded-home invariant."""
from __future__ import annotations

import re
from pathlib import Path

from server import state_paths as sp

SERVER_DIR = Path(__file__).parent


def test_root_defaults_to_home_dot_repociv(monkeypatch, tmp_path):
    monkeypatch.delenv("REPOCIV_CONFIG_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert sp.repociv_home() == tmp_path / ".repociv"


def test_root_honors_config_dir_and_expands_user(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", "~/custom-state")
    assert sp.repociv_home() == tmp_path / "custom-state"


def test_blank_config_dir_falls_back(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", "   ")
    assert sp.repociv_home() == tmp_path / ".repociv"


def test_state_path_override_env_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path / "root"))
    monkeypatch.setenv("REPOCIV_STATE_DIR", str(tmp_path / "ledgers"))
    assert sp.state_path("x.json", override_env="REPOCIV_STATE_DIR") == tmp_path / "ledgers" / "x.json"
    monkeypatch.delenv("REPOCIV_STATE_DIR")
    assert sp.state_path("x.json", override_env="REPOCIV_STATE_DIR") == tmp_path / "root" / "x.json"


_HARDCODED_HOME = re.compile(
    r"""Path\.home\(\)\s*/\s*["']\.repociv|expanduser\(\s*["']~/\.repociv|["']~["']\)\s*,\s*["']\.repociv"""
)


def test_no_store_hardcodes_the_live_home():
    """Every store must resolve through state_paths so tests can isolate it."""
    offenders = []
    for path in sorted(SERVER_DIR.rglob("*.py")):
        if path.name.startswith("test_") or path.name == "state_paths.py":
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if _HARDCODED_HOME.search(line):
                offenders.append(f"{path.relative_to(SERVER_DIR)}:{lineno}: {line.strip()}")
    assert offenders == []
