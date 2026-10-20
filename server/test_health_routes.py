"""Health/readiness characterization from core at fixed original 31e4540.

All scheduler, capability, GPU, store and identity collaborators are inert fakes.
"""
import sys
from types import SimpleNamespace

import pytest

import server
from server.routes import core


class IgnoredContext:
    def __getattribute__(self, name):
        raise AssertionError(f"context must remain unused: {name}")


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path / "config"))
    state = SimpleNamespace(fault=None, hook={}, agents=[{"status": "active"}, {"status": "idle"},
                            {}, {"status": "ACTIVE"}, {"status": "active"}], queue=[1, 2],
                            gpu={"gpus": []}, mcp={"connected": 2}, external={"agents": []},
                            diagnostic={"loaded": "fixture"})
    trace = []

    def step(name, value=None):
        trace.append(name)
        if state.fault == name:
            raise RuntimeError(f"failure:{name}")
        if name in state.hook:
            state.hook[name]()
        return value

    identity = SimpleNamespace(snapshot=lambda: step("identity", state.diagnostic))
    fallback = SimpleNamespace(snapshot=lambda: step("fallback", {"fallback": True}))
    runner = SimpleNamespace(_has_openclaw=lambda: step("openclaw", True),
                             _has_claude_code=lambda: step("claude", False),
                             _has_cursor=lambda: step("cursor", "not-coerced"),
                             _has_codex=lambda: step("codex", None))
    bridge = SimpleNamespace(
        _sched=SimpleNamespace(get_agent_status=lambda: step("agents", state.agents),
                               queue_snapshot=lambda: step("queue", state.queue)),
        get_gpu_info=lambda: step("gpu", state.gpu), mcp_status=lambda: step("mcp", state.mcp),
        _es=SimpleNamespace(_store_path="/fake/store"), REPOCIV_TOKEN="fake-token")
    suvadu = SimpleNamespace(status=lambda: step("external", state.external))
    for name, fake in [("agent_runner", runner), ("bridge", bridge),
                       ("suvadu_tracker", suvadu), ("build_identity", fallback)]:
        monkeypatch.setitem(sys.modules, f"server.{name}", fake)
        monkeypatch.setattr(server, name, fake, raising=False)
    monkeypatch.setattr(core, "_build_identity", identity)
    monkeypatch.setattr(core, "time", SimpleNamespace(time=lambda: step("time", 123.5)))
    return SimpleNamespace(state=state, trace=trace, bridge=bridge, runner=runner,
                           identity=identity, suvadu=suvadu, monkeypatch=monkeypatch)


ORDER = ["agents", "queue", "gpu", "time", "openclaw", "claude", "cursor", "codex", "mcp", "external", "identity"]


def test_health_exact_response_and_order(env):
    status, body = core.get_health(IgnoredContext())
    assert status == 200
    assert body == {"ok": True, "version": "0.1.0", "timestamp": 123.5, "openclaw": True,
                    "claudeCode": False, "cursor": "not-coerced", "codex": None,
                    "mcp": env.state.mcp, "defaultTransport": "hermes",
                    "agents": {"active": 2, "total": 5, "queueDepth": 2}, "gpu": env.state.gpu,
                    "eventStore": "/fake/store", "externalAgents": env.state.external,
                    "buildDiagnostic": env.state.diagnostic}
    assert list(body) == ["ok", "version", "timestamp", "openclaw", "claudeCode", "cursor", "codex",
                          "mcp", "defaultTransport", "agents", "gpu", "eventStore", "externalAgents", "buildDiagnostic"]
    for key, value in [("gpu", env.state.gpu), ("mcp", env.state.mcp),
                       ("externalAgents", env.state.external), ("buildDiagnostic", env.state.diagnostic)]:
        assert body[key] is value
    assert env.trace == ORDER


@pytest.mark.parametrize("fault", ORDER)
def test_health_exceptions_propagate_and_stop_at_same_stage(env, fault):
    env.state.fault = fault
    with pytest.raises(RuntimeError, match=f"^failure:{fault}$"):
        core.get_health(None)
    assert env.trace == ORDER[:ORDER.index(fault) + 1]


def test_none_identity_uses_import_fallback(env):
    env.monkeypatch.setattr(core, "_build_identity", None)
    assert core.get_health({})[1]["buildDiagnostic"] == {"fallback": True}
    assert env.trace == ORDER[:-1] + ["fallback"]


def test_falsey_identity_is_not_replaced_by_fallback(env):
    class Identity:
        def __bool__(self):
            return False

        def snapshot(self):
            env.trace.append("falsey")
            return "falsey-snapshot"

    env.monkeypatch.setattr(core, "_build_identity", Identity())
    assert core.get_health({})[1]["buildDiagnostic"] == "falsey-snapshot"
    assert env.trace == ORDER[:-1] + ["falsey"]


def test_identity_selection_is_after_gpu_but_before_capabilities(env):
    selected = SimpleNamespace(snapshot=lambda: "selected-after-gpu")
    env.state.hook["gpu"] = lambda: env.monkeypatch.setattr(core, "_build_identity", selected)
    env.state.hook["openclaw"] = lambda: env.monkeypatch.setattr(core, "_build_identity", None)
    assert core.get_health(None)[1]["buildDiagnostic"] == "selected-after-gpu"
    assert env.trace == ORDER[:-1]


def test_time_global_is_resolved_after_gpu(env):
    env.state.hook["gpu"] = lambda: env.monkeypatch.setattr(core, "time", SimpleNamespace(time=lambda: 999))
    assert core.get_health(None)[1]["timestamp"] == 999
    assert env.trace == [x for x in ORDER if x != "time"]


def test_imported_capabilities_and_bridge_functions_stay_captured(env):
    def replace():
        env.runner._has_claude_code = lambda: pytest.fail("must retain imported function")
        env.bridge.mcp_status = lambda: pytest.fail("must retain imported function")
        env.bridge._es = SimpleNamespace(_store_path="wrong-store")

    env.state.hook["gpu"] = replace
    body = core.get_health(None)[1]
    assert body["claudeCode"] is False
    assert body["eventStore"] == "/fake/store"
    assert env.trace == ORDER


def test_suvadu_attribute_stays_late_and_store_path_stays_live(env):
    def replace():
        env.suvadu.status = lambda: "updated-status"
        env.bridge._es._store_path = "updated-path"

    env.state.hook["mcp"] = replace
    body = core.get_health(None)[1]
    assert body["externalAgents"] == "updated-status"
    assert body["eventStore"] == "updated-path"
    assert env.trace == [x for x in ORDER if x != "external"]


@pytest.mark.parametrize("path", [None, "", 0, "relative/store"])
def test_store_path_coercion_unchanged(env, path):
    env.bridge._es._store_path = path
    assert core.get_health(None)[1]["eventStore"] == str(path)
    assert core.get_ready(None) == (200, {"ok": True, "eventStore": str(path), "token": True})


def test_missing_store_is_optional_only_for_health(env):
    env.bridge._es = SimpleNamespace()
    assert core.get_health(None)[1]["eventStore"] is None
    with pytest.raises(AttributeError):
        core.get_ready(None)


def test_health_store_descriptor_is_read_twice(env):
    class Store:
        @property
        def _store_path(self):
            env.trace.append("path")
            return "property"

    env.bridge._es = Store()
    assert core.get_health(None)[1]["eventStore"] == "property"
    assert env.trace == ORDER[:9] + ["path", "path"] + ORDER[9:]


@pytest.mark.parametrize("token", [None, "", "fake", 0, 1, [], [1]])
def test_ready_token_is_boolean_without_exposing_value(env, token):
    env.bridge.REPOCIV_TOKEN = token
    assert core.get_ready(IgnoredContext()) == (200, {"ok": True, "eventStore": "/fake/store", "token": bool(token)})
    assert env.trace == []


def test_registry_and_shim_keep_original_facade_identity():
    from server import http_routes
    from server.routes import registry

    assert http_routes.get_health is core.get_health is registry.GET_EXACT["/health"]
    assert http_routes.get_ready is core.get_ready is registry.GET_EXACT["/ready"]
