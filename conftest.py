"""Pytest configuration for backend tests."""
import os
import sys
import tempfile
from pathlib import Path
import importlib

import pytest

os.environ.setdefault("REPOCIV_CONFIG_DIR", tempfile.mkdtemp(prefix="repociv-test-"))

sys.path.insert(0, str(Path(__file__).parent / "server"))


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
