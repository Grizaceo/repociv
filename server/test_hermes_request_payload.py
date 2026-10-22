"""Request-body characterization captured from runner at 63de7d2.

Transport, persistence, token ledger and callbacks are isolated fakes.
"""

import json
from types import SimpleNamespace

import pytest

from server import agent_runner as runner

QUICK_NOTE = (
    "\nRespuesta rápida de chat: responde de forma directa y breve sin invocar "
    "herramientas salvo que el usuario lo pida explícitamente."
)


@pytest.fixture
def run(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("HERMES_URL", "http://fake.invalid/chat")
    monkeypatch.setenv("HERMES_KEY", "fake-key")
    monkeypatch.setenv("HERMES_MODEL", "env-model")
    state = SimpleNamespace(quick=False, spatial="<spatial>", fault=None, config={"system": "SYS"},
                            override={}, body=None, on_quick=None, on_spatial=None)
    trace = []

    def step(name, *args):
        trace.append((name, *args))
        if state.fault == name:
            raise RuntimeError(f"failure:{name}")

    def config(unit):
        step("config", unit)
        return state.config

    def session(unit, city, mission, *, stateful):
        step("session", unit, city, mission, stateful)
        return "thread"

    def quick(mission):
        step("quick", mission)
        if state.on_quick:
            state.on_quick()
        return state.quick

    def spatial(city, work):
        step("spatial", city, work)
        if state.on_spatial:
            state.on_spatial()
        return state.spatial

    def dumps(payload):
        step("serialize")
        state.body = payload
        return json.dumps(payload)

    def request(url, *, data, headers, method):
        step("request")
        assert url == "http://fake.invalid/chat"
        assert json.loads(data) == state.body
        assert headers == {"Content-Type": "application/json", "X-Hermes-Session-Id": "thread",
                           "X-Hermes-Session-Key": "thread", "Authorization": "Bearer fake-key"}
        assert method == "POST"
        return "request"

    class Response:
        def __enter__(self):
            step("enter")
            return self

        def read(self):
            step("read")
            return b'{"choices":[{"message":{"content":"answer"}}]}'

        def __exit__(self, *_args):
            step("exit")

    def urlopen(req, *, timeout):
        step("open", req, timeout)
        return Response()

    monkeypatch.setattr(runner, "_model_overrides", SimpleNamespace(get=lambda unit: state.override))
    monkeypatch.setattr(runner, "_get_agent_config", config)
    monkeypatch.setattr(runner, "_build_stateful_session_id", session)
    monkeypatch.setattr(runner, "_is_quick_chat_message", quick)
    monkeypatch.setattr(runner, "_spatial_context_block", spatial)
    monkeypatch.setattr(runner, "json", SimpleNamespace(dumps=dumps, loads=json.loads))
    monkeypatch.setattr(runner, "urllib", SimpleNamespace(request=SimpleNamespace(Request=request, urlopen=urlopen)))
    monkeypatch.setattr(runner, "send_to_repociv", lambda event: step("send", event))
    monkeypatch.setattr(runner, "_es", SimpleNamespace(record_output_chunk=lambda *args: step("record", *args)))
    monkeypatch.setattr(runner, "_token_ledger", SimpleNamespace(get_ledger=lambda: pytest.fail("unexpected ledger")))

    def call(mission="mission", cfg=None, work="work", model="", provider=""):
        return runner._run_hermes_streaming("U", "M", mission, cfg, work, "city", model, provider)

    return SimpleNamespace(state=state, trace=trace, call=call, monkeypatch=monkeypatch)


@pytest.mark.parametrize("quick", [False, True, "truthy", 0])
@pytest.mark.parametrize("work", [None, "", "repo dir", " "])
def test_body_and_order(run, quick, work):
    run.state.quick = quick
    assert run.call(work=work) == (True, "answer")
    expected = {
        "model": "env-model",
        "messages": [
            {"role": "system", "content": "SYS<spatial>" + (QUICK_NOTE if quick else "")},
            {"role": "user", "content": f"cd {work}\n\nmission" if work and not quick else "mission"},
        ],
        "stream": False,
        "max_tokens": 1024 if quick else 4096,
    }
    if quick:
        expected["model_options"] = {"reasoning_effort": "low"}
    if work:
        expected["working_directory"] = work
    assert run.state.body == expected
    assert run.trace[:4] == [("config", "U"), ("session", "U", "city", "M", True),
                            ("quick", "mission"), ("spatial", "city", work)]
    assert [e[0] for e in run.trace[4:]] == ["serialize", "request", "open", "enter", "read", "exit", "send", "record"]


@pytest.mark.parametrize(("cfg", "system"), [({}, "Eres un agente util."), ({"system": ""}, ""),
                                               ({"system": "á\n "}, "á\n ")])
def test_explicit_config_default_and_empty_system(run, cfg, system):
    cfg["stateful"] = False
    assert run.call(cfg=cfg) == (True, "answer")
    assert run.state.body["messages"][0]["content"] == system + "<spatial>"
    assert run.trace[:3] == [("session", "U", "city", "M", False), ("quick", "mission"), ("spatial", "city", "work")]


@pytest.mark.parametrize(("model", "provider", "override", "expected_model", "expected_provider"), [
    (" chosen ", " p ", {"model": "over", "provider": "q"}, "chosen", "p"),
    (" ", " ", {"model": " over ", "provider": " q "}, "over", "q"),
    ("", "AUTO", {"provider": "q"}, "env-model", None),
    ("", " auto ", {}, "env-model", None),
    ("", "", {"model": 12, "provider": 34}, "12", "34"),
    ("", "", {"model": 0, "provider": False}, "env-model", None),
])
def test_selected_values_not_reinterpreted(run, model, provider, override, expected_model, expected_provider):
    run.state.override = override
    assert run.call(model=model, provider=provider) == (True, "answer")
    assert run.state.body["model"] == expected_model
    if expected_provider is None:
        assert "provider" not in run.state.body
    else:
        assert run.state.body["provider"] == expected_provider


@pytest.mark.parametrize("fault", ["config", "session", "quick", "spatial"])
def test_preparation_exceptions_remain_outside_transport_catch(run, fault):
    run.state.fault = fault
    with pytest.raises(RuntimeError, match=f"^failure:{fault}$"):
        run.call()
    assert run.trace[-1][0] == fault
    assert run.state.body is None
    assert not any(e[0] in {"send", "record", "open"} for e in run.trace)


@pytest.mark.parametrize("fault", ["serialize", "request", "open", "read"])
def test_transport_exceptions_keep_original_error_fallback(run, fault):
    run.state.fault = fault
    assert run.call() == (False, f"failure:{fault}")
    assert run.trace[-2:] == [
        ("send", {"type": "chat_chunk", "unit": "U", "missionId": "M", "text": f"[hermes error] failure:{fault}\n"}),
        ("record", "M", "U", f"[hermes error] failure:{fault}\n"),
    ]


def test_spatial_global_is_looked_up_after_quick_callback(run):
    def replacement(city, work):
        run.trace.append(("replacement-spatial", city, work))
        return "NEW"

    run.state.on_quick = lambda: run.monkeypatch.setattr(runner, "_spatial_context_block", replacement)
    assert run.call() == (True, "answer")
    assert run.trace[3] == ("replacement-spatial", "city", "work")
    assert run.state.body["messages"][0]["content"] == "SYSNEW"


def test_config_is_read_after_spatial_not_copied_early(run):
    cfg = {"system": "OLD"}
    run.state.on_spatial = lambda: cfg.update(system="NEW")
    assert run.call(cfg=cfg) == (True, "answer")
    assert run.state.body["messages"][0]["content"] == "NEW<spatial>"


@pytest.mark.parametrize("system", [None, 12])
def test_bad_system_types_still_raise_before_http(run, system):
    with pytest.raises(TypeError):
        run.call(cfg={"system": system})
    assert [e[0] for e in run.trace] == ["session", "quick", "spatial"]
