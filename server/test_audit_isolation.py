"""Regression checks for audit-test isolation, in fresh interpreters."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.parametrize("case", ["hmac", "ttl", "bridge"])
def test_audit_test_restores_process_state(case: str, tmp_path: Path) -> None:
    """Exercise the actual test and its teardown, not a duplicate fixture."""
    home = tmp_path / "home"
    config = tmp_path / "config"
    home.mkdir()
    config.mkdir()
    env = os.environ.copy()
    env.update(
        HOME=str(home),
        REPOCIV_CONFIG_DIR=str(config),
        REPOCIV_APPROVAL_TTL_S="73",
        REPOCIV_HMAC_KEY="isolation-test-key",
    )
    script = '''
import json, os, sys
import pytest
from server import approval_store as store, security_harness as sh
case = sys.argv[1]
store._loaded = True
store._approvals = {"sentinel": {"id": "sentinel"}}
before_store = (store._loaded, store._approvals, store._APPROVAL_TTL_S)
before_env = {k: os.environ.get(k) for k in
              ("REPOCIV_CONFIG_DIR", "REPOCIV_APPROVAL_TTL_S", "REPOCIV_HMAC_KEY")}
before_key = sh._HMAC_KEY
if case == "bridge":
    from server import bridge
    before_config = bridge.CONFIG_DIR
    before_missions = bridge.MISSIONS_FILE
nodes = {
    "hmac": "server/test_security_harness.py::TestHMACKey::test_no_public_default_key",
    "ttl": "server/test_approval_store.py::TestTTLStamp::test_env_ttl_configurable",
    "bridge": "server/test_bridge_integration.py::test_cancel_command_cascades_to_child_pendings",
}
exit_code = pytest.main(["-q", "-p", "no:cacheprovider", nodes[case]])
checks = {
    "test_passed": exit_code == 0,
    "environment_restored": all(os.environ.get(k) == v for k, v in before_env.items()),
    "hmac_key_restored": sh._HMAC_KEY == before_key,
    "store_restored": (store._loaded, store._approvals, store._APPROVAL_TTL_S) == before_store,
}
if case == "bridge":
    checks["bridge_paths_restored"] = (bridge.CONFIG_DIR == before_config and
                                       bridge.MISSIONS_FILE == before_missions)
print("ISOLATION_RESULT=" + json.dumps(checks))
'''
    result = subprocess.run(
        [sys.executable, "-c", script, case],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        text=True,
        capture_output=True,
        timeout=45,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    line = next(line for line in result.stdout.splitlines()
                if line.startswith("ISOLATION_RESULT="))
    checks = json.loads(line.split("=", 1)[1])
    assert all(checks.values()), f"{case}: {checks}\n{result.stdout}\n{result.stderr}"
