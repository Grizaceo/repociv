"""R04 route tests: no agent, Docker daemon, provider or live store access."""
from pathlib import Path
from unittest.mock import Mock

import pytest

from server import agent_runner, container_runtime
from server.security_harness import SecurityHarness


@pytest.fixture
def isolated_route(monkeypatch, tmp_path):
    security = SecurityHarness(alert_log_dir=tmp_path / "alerts", quarantine_dir=tmp_path / "quarantine")
    monkeypatch.setattr(agent_runner._security_harness, "get_harness", lambda: security)
    monkeypatch.setattr(agent_runner, "_get_agent_config", lambda _unit: {})
    monkeypatch.setattr(agent_runner, "_record_execution_identity", lambda *a, **kw: None)
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda _event: None)
    monkeypatch.setattr(agent_runner._es, "record_output_chunk", lambda *a: None)
    monkeypatch.setenv("REPOCIV_AGENT_CONTAINER", "1")
    return security


@pytest.mark.parametrize("unsafe", [
    ["docker", "run", "--network", "host", "--mount", "type=bind,src=/repo,dst=/repo,readonly", "image"],
    ["docker", "run", "--network", "none", "--mount", "type=bind,src=/repo,dst=/repo,rw", "image"],
    ["docker", "run", "--network", "none", "--mount", "type=bind,src=/root/.ssh,dst=/repo,readonly", "image"],
])
def test_supported_container_route_rejects_before_launch(monkeypatch, tmp_path, isolated_route, unsafe):
    launch = Mock(side_effect=AssertionError("unsafe container reached launch"))
    monkeypatch.setattr(container_runtime, "build_docker_run_command", lambda **kw: unsafe)
    monkeypatch.setattr(container_runtime, "run_agent_container", launch)
    ok, output = agent_runner._execute_streaming("WORKER", "inert-r04", "implement feature", str(tmp_path))
    assert ok is False
    assert "blocked" in output
    launch.assert_not_called()


def test_direct_container_helper_rejects_unsafe_policy(monkeypatch, tmp_path, isolated_route):
    launch = Mock(side_effect=AssertionError("unsafe helper reached subprocess"))
    monkeypatch.setattr(container_runtime.subprocess, "run", launch)
    with pytest.raises(ValueError, match="security blocked"):
        container_runtime.run_agent_container(repo_root=tmp_path, mission="implement feature",
                                             policy=container_runtime.ContainerPolicy(network="host"))
    launch.assert_not_called()


def test_runtime_configuration_check_is_not_process_monitor(tmp_path: Path):
    security = SecurityHarness(alert_log_dir=tmp_path / "alerts", quarantine_dir=tmp_path / "quarantine")
    # No OS observation or signalling is implemented by this compatibility API.
    result = security.runtime_enforce(agent_pid=2**30)
    assert not result.blocked
    assert result.findings == []
