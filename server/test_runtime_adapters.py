from server import runtime_adapters


def test_default_agent_runtime_maps_openclaw_unit():
    adapter = runtime_adapters.default_agent_runtime("OPENCLAW")
    assert adapter.harness_id == "openclaw-local"


def test_default_agent_runtime_maps_cursor_unit():
    adapter = runtime_adapters.default_agent_runtime("CURSOR")
    assert adapter.harness_id == "cursor-local"


def test_infer_adapter_for_command_prefers_registered_runtime():
    adapter = runtime_adapters.infer_adapter_for_command("run_tests")
    assert adapter is not None
    assert adapter.supports("run_tests") is True


def test_build_recovery_delegates_to_recovery_plan():
    adapter = runtime_adapters.get_adapter("hermes-local")
    assert adapter is not None
    plan = adapter.build_recovery({"reason": "command_failed", "command_type": "run_tests"})
    assert plan["harness_id"] == "hermes-local"
    assert plan["mode"] == "copy_command"


def test_docker_adapter_available_and_builds_policy_command(tmp_path):
    adapter = runtime_adapters.get_adapter("docker-agent")
    assert isinstance(adapter, runtime_adapters.DockerAdapter)

    command = adapter.build_command(repo_root=tmp_path, mission="do work")
    joined = " ".join(command)

    assert adapter.harness_id == "docker-agent"
    assert adapter.trust_level == "sandboxed"
    assert "--network none" in joined
    assert "readonly" in joined


def test_default_runtime_uses_docker_when_enabled(monkeypatch):
    monkeypatch.setenv("REPOCIV_AGENT_CONTAINER", "1")

    adapter = runtime_adapters.default_agent_runtime("WORKER")

    assert isinstance(adapter, runtime_adapters.DockerAdapter)
    assert adapter.harness_id == "docker-agent"
