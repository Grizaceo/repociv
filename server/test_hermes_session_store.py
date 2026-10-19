"""Characterize the runner's legacy session-cache IO before extracting it."""

import json
from types import SimpleNamespace

import pytest

from server import agent_runner, hermes_session_store


class ProbePath:
    def __init__(self, events, text='{"key": "old"}', *, exists=True, fault=None):
        self.events = events
        self.text = text
        self.present = exists
        self.fault = fault
        self.on_read = None

    def step(self, name):
        self.events.append(name)
        if self.fault == name:
            raise OSError(name)

    def exists(self):
        self.step("exists")
        return self.present

    def read_text(self, *, encoding):
        assert encoding == "utf-8"
        self.step("read")
        if self.on_read:
            self.on_read()
        return self.text

    @property
    def parent(self):
        self.step("parent")
        return self

    def mkdir(self, *, parents, exist_ok):
        assert parents is True and exist_ok is True
        self.step("mkdir")

    def write_text(self, value, *, encoding):
        assert encoding == "utf-8"
        self.step("write")
        self.text = value


@pytest.fixture(params=["runner", "store"])
def cache(request, monkeypatch):
    events = []
    path = ProbePath(events)

    def state_file():
        path.step("path")
        return path

    def session_key(profile, unit, city):
        assert (profile, unit, city) == ("profile", "unit", "city")
        path.step("key")
        return "key"

    monkeypatch.setattr(agent_runner, "_hermes_session_state_file", state_file)
    monkeypatch.setattr(agent_runner, "_hermes_session_key", session_key)
    interface = SimpleNamespace(
        events=events, path=path,
        load=lambda: agent_runner._load_hermes_session_id("profile", "unit", "city"),
        save=lambda value: agent_runner._save_hermes_session_id("profile", "unit", "city", value),
    )
    if request.param == "store":
        callbacks = {
            "state_file": lambda: agent_runner._hermes_session_state_file(),
            "session_key": lambda: agent_runner._hermes_session_key("profile", "unit", "city"),
        }
        interface.load = lambda: hermes_session_store.load_session_id(**callbacks)
        interface.save = lambda value: hermes_session_store.save_session_id(value, **callbacks)
    return interface


@pytest.mark.parametrize(("text", "expected", "key_called"), [
    ('{}', "", True),
    ('{"key":"session"}', "session", True),
    ('{"key":null}', "None", True),
    ('{"key":false}', "False", True),
    ('{"key":7}', "7", True),
    ('{"key":["a",1]}', "['a', 1]", True),
    ('{"key":{"a":2}}', "{'a': 2}", True),
    ('{"key":"  sesión  "}', "  sesión  ", True),
    ('{"other":"session"}', "", True),
    ('{"key":"first","key":"last"}', "last", True),
    ('null', "", False), ('[]', "", False), ('"scalar"', "", False),
    ('12', "", False), ('true', "", False), ('{bad', "", False), ('', "", False),
])
def test_load_legacy_values_and_callback_order(cache, text, expected, key_called):
    cache.path.text = text
    assert cache.load() == expected
    assert cache.events == ["path", "read"] + (["key"] if key_called else [])
    assert cache.path.text == text


@pytest.mark.parametrize("fault", ["path", "read", "key"])
def test_load_errors_are_swallowed_in_order(cache, fault):
    cache.path.fault = fault
    assert cache.load() == ""
    order = ["path", "read", "key"]
    assert cache.events == order[:order.index(fault) + 1]


@pytest.mark.parametrize("value", ["", None, False, 0, [], {}])
def test_empty_session_does_not_touch_paths_or_keys(cache, value):
    assert cache.save(value) is None
    assert cache.events == []


@pytest.mark.parametrize("text", ["null", "[]", '"scalar"', "3", "false", "{bad", ""])
def test_save_invalid_existing_payload_is_not_repaired(cache, text):
    cache.path.text = text
    assert cache.save("new") is None
    assert cache.path.text == text
    # JSON scalars parse, so key evaluation precedes failed item assignment.
    parsed = text not in ("{bad", "")
    assert cache.events == ["path", "exists", "read"] + (["key"] if parsed else [])


@pytest.mark.parametrize("fault", ["path", "exists", "read", "key", "parent", "mkdir", "write"])
def test_save_errors_are_swallowed_at_the_original_stage(cache, fault):
    cache.path.fault = fault
    assert cache.save("new") is None
    order = ["path", "exists", "read", "key", "parent", "mkdir", "write"]
    assert cache.events == order[:order.index(fault) + 1]
    assert cache.path.text == '{"key": "old"}'


@pytest.mark.parametrize("exists", [True, False])
def test_save_exact_json_bytes_and_existing_mapping(cache, exists):
    cache.path.present = exists
    cache.path.text = '{"other":"keep","key":"old"}'
    assert cache.save("sesión") is None
    expected = '{\n  "other": "keep",\n  "key": "sesi\\u00f3n"\n}' if exists else '{\n  "key": "sesi\\u00f3n"\n}'
    assert cache.path.text == expected
    assert cache.events == ["path", "exists"] + (["read"] if exists else []) + ["key", "parent", "mkdir", "write"]


@pytest.mark.parametrize("value", [123, True, ["id"], {"id": 2}])
def test_truthy_nonstring_values_keep_legacy_serialization(cache, value):
    cache.save(value)
    assert json.loads(cache.path.text) == {"key": value}
    assert cache.load() == str(value)


def test_nonserializable_value_fails_after_mkdir_without_writing(cache):
    cache.save(object())
    assert cache.events == ["path", "exists", "read", "key", "parent", "mkdir"]
    assert cache.path.text == '{"key": "old"}'


@pytest.mark.parametrize("operation", ["load", "save"])
def test_key_callback_is_looked_up_after_read(cache, monkeypatch, operation):
    def replacement(*args):
        cache.events.append("new-key")
        return "other"

    cache.path.text = '{"key":"old","other":"updated"}'
    cache.path.on_read = lambda: monkeypatch.setattr(agent_runner, "_hermes_session_key", replacement)
    if operation == "load":
        assert cache.load() == "updated"
        assert cache.events == ["path", "read", "new-key"]
    else:
        cache.save("new")
        assert json.loads(cache.path.text) == {"key": "old", "other": "new"}
        assert cache.events == ["path", "exists", "read", "new-key", "parent", "mkdir", "write"]


def test_save_facade_does_not_expose_dependency_return(tmp_path, monkeypatch):
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path / "isolated"))
    monkeypatch.setattr(hermes_session_store, "save_session_id", lambda *args, **kwargs: "not-a-return-value")
    assert agent_runner._save_hermes_session_id("profile", "unit", "city", "id") is None


def test_runner_real_file_roundtrip_preserves_profile_unit_and_city_scopes(tmp_path, monkeypatch):
    root = tmp_path / "nested" / "config"
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(root))
    assert agent_runner._load_hermes_session_id("/profiles/alpha", "MAIN", "repo-a") == ""
    agent_runner._save_hermes_session_id("/profiles/alpha", "MAIN", "repo-a", "first")
    agent_runner._save_hermes_session_id("/profiles/beta", "MAIN", "repo-a", "second")
    agent_runner._save_hermes_session_id("/profiles/alpha", "MAIN", "repo-b", "third")
    assert agent_runner._load_hermes_session_id("/profiles/alpha", "MAIN", "repo-a") == "first"
    assert agent_runner._load_hermes_session_id("/profiles/beta", "MAIN", "repo-a") == "second"
    assert agent_runner._load_hermes_session_id("/profiles/alpha", "MAIN", "repo-b") == "third"
    assert agent_runner._load_hermes_session_id("/profiles/alpha", "SCOUT", "repo-a") == ""
    stored = json.loads((root / "hermes-sessions.json").read_text())
    assert len(stored) == 3


@pytest.mark.parametrize("stateful", [True, False])
def test_fake_cli_resumes_saved_native_id_only_for_stateful_agents(tmp_path, monkeypatch, stateful):
    from server import agent_processes

    root = tmp_path / "cache"
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(root))
    monkeypatch.setattr(agent_runner, "_find_hermes_cli", lambda: "/fake/hermes")
    monkeypatch.setattr(agent_runner, "_spatial_context_block", lambda *args: "spatial")
    monkeypatch.setattr(agent_runner, "_harness_ctx", lambda *args, **kwargs: None)
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda event: None)
    monkeypatch.setattr(agent_runner._es, "record_output_chunk", lambda *args: None)
    monkeypatch.setattr(agent_runner._subagent_tracker, "process_hermes_stream_line", lambda *args, **kwargs: None)
    monkeypatch.setattr(agent_processes, "record_process_binding", lambda *args: None)
    patches = []
    monkeypatch.setattr(agent_runner._sessions, "patch", lambda *args, **kwargs: patches.append((args, kwargs)))
    calls = []

    def popen(cmd, **kwargs):
        native_id = f"native_{len(calls) + 1}"
        calls.append((list(cmd), kwargs))
        return SimpleNamespace(
            stdout=iter([f"session_id: {native_id}\n"]),
            pid=0, returncode=0, wait=lambda timeout: None,
        )

    monkeypatch.setattr(agent_runner, "subprocess", SimpleNamespace(
        Popen=popen, PIPE=agent_runner.subprocess.PIPE, STDOUT=agent_runner.subprocess.STDOUT,
    ))
    config = {"profile": str(tmp_path / "profile"), "stateful": stateful}
    for i in range(2):
        ok, output = agent_runner._run_hermes_cli_streaming(
            "WORKER", f"mission-{i}", "fake task", config,
            working_dir=str(tmp_path), city_id="repo-a",
        )
        assert ok is True
        assert output == f"session_id: native_{i + 1}\n"
    assert "--resume" not in calls[0][0]
    assert calls[0][1]["cwd"] == str(tmp_path)
    assert calls[0][1]["env"]["HERMES_HOME"] == config["profile"]
    if stateful:
        second = calls[1][0]
        assert second[second.index("--resume") + 1] == "native_1"
        assert agent_runner._load_hermes_session_id(config["profile"], "WORKER", "repo-a") == "native_2"
        assert [kwargs for args, kwargs in patches] == [
            {"nativeSessionId": "native_1"}, {"nativeSessionId": "native_2"},
        ]
    else:
        assert "--resume" not in calls[1][0]
        assert not root.exists()
        assert patches == []
