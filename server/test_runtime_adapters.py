from server import runtime_adapters


def test_default_agent_runtime_maps_openclaw_unit():
    adapter = runtime_adapters.default_agent_runtime("OPENCLAW")
    assert adapter.harness_id == "openclaw-local"


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
