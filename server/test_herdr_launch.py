from __future__ import annotations

import asyncio
import json
import re
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest

from server import herdr_runtime, policy, repo_roots_state
from server.command_schema import Command, validate_command
from server.routes.core import _validate_command_target


class FakeLaunch:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.instance: str | None = "123:456"
        self.status = herdr_runtime.RuntimeStatus("ready", "0.9.1", "/fake/herdr")
        self.workspaces = {"w1": "City"}
        self.start_error: herdr_runtime.HerdrError | None = None
        self.rows = [{"pane_id": "w2:p1", "terminal_id": "term2", "agent": "claude",
                      "agent_status": "idle", "launch_pending": False}]
        self.rows_sequence: list[list[dict]] = []
        self.tab_error: str | None = None
        monkeypatch.setattr(herdr_runtime, "probe", lambda path=None: self.status)
        monkeypatch.setattr(herdr_runtime, "server_instance", lambda path=None: self.instance, raising=False)
        monkeypatch.setattr(herdr_runtime, "request", self.request)

    def request(self, method: str, params: dict | None = None, **kwargs: Any) -> dict:
        params = params or {}
        if kwargs.get("instance") != self.instance:
            raise herdr_runtime.HerdrError("server_changed")
        self.calls.append((method, params))
        if method == "ping":
            return {"type": "pong", "version": "0.9.1"}
        if method == "workspace.get":
            label = self.workspaces.get(params["workspace_id"])
            if label is None:
                raise herdr_runtime.HerdrError("workspace_not_found")
            return {"workspace": {"workspace_id": params["workspace_id"], "label": label}}
        if method == "workspace.create":
            return {"workspace": {"workspace_id": "w2"}, "root_pane": {"pane_id": "w2:p1", "terminal_id": "term2"}}
        if method == "tab.create":
            if self.tab_error:
                raise herdr_runtime.HerdrError(self.tab_error)
            return {"root_pane": {"pane_id": "w2:p1", "terminal_id": "term2"}}
        if method == "pane.process_info":
            return {"process_info": {"shell_pid": 123, "foreground_processes": [{"pid": 123}]}}
        if method == "agent.start":
            if self.start_error:
                raise self.start_error
            return {"type": "agent_started", "agent": {"launch_pending": True}}
        if method == "agent.list":
            return {"agents": self.rows_sequence.pop(0) if self.rows_sequence else self.rows}
        raise AssertionError(method)


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeLaunch:
    return FakeLaunch(monkeypatch)


def go(fake: FakeLaunch, book: dict | None = None, **kwargs: Any) -> Any:
    timeout_ms = kwargs.pop("timeout_ms", 4000)
    return herdr_runtime.launch(
        "claude", city_id="city", cwd="/selected/city", label="City", path="/private/h.sock",
        book={} if book is None else book, timeout_ms=timeout_ms, **kwargs,
    )


@pytest.mark.parametrize("state", ["missing", "stopped", "outdated", "incompatible"])
def test_unready_never_creates_a_workspace(fake: FakeLaunch, state: str) -> None:
    fake.status = replace(fake.status, state=state)
    result = go(fake)
    assert (result.state, result.reason) == ("failed", f"herdr_{state}")
    assert fake.calls == []


def test_new_workspace_uses_root_pane_and_starts_once_after_callback(fake: FakeLaunch) -> None:
    book: dict = {}
    result = go(fake, book, on_pane=lambda pane, term: fake.calls.append(("on_pane", (pane, term))))
    assert result.state == "ready"
    assert (result.pane_id, result.terminal_id, result.workspace_id) == ("w2:p1", "term2", "w2")
    assert book["city"] == {"server": "123:456", "workspaceId": "w2"}
    create = next(p for method, p in fake.calls if method == "workspace.create")
    assert create == {"cwd": "/selected/city", "label": "City", "focus": False}
    methods = [method for method, _ in fake.calls]
    assert methods.index("on_pane") < methods.index("agent.start")
    start = next(p for method, p in fake.calls if method == "agent.start")
    assert start == {"name": result.name, "kind": "claude", "pane_id": "w2:p1", "timeout_ms": 4000}
    assert methods.count("agent.start") == 1
    assert re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", result.name)
    assert "/selected" not in json.dumps(result.to_dict())
    assert "instance" not in result.to_dict()


def test_existing_owned_workspace_gets_a_tab(fake: FakeLaunch) -> None:
    result = go(fake, {"city": {"server": "123:456", "workspaceId": "w1"}})
    assert result.state == "ready"
    assert "tab.create" in [method for method, _ in fake.calls]
    assert "workspace.create" not in [method for method, _ in fake.calls]


def test_restart_between_verification_and_tab_creation_never_uses_the_other_server(
    fake: FakeLaunch, monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_request = fake.request
    alien_tabs: list[str] = []

    def request(method: str, params: dict | None = None, **kwargs: Any) -> dict:
        if method == "tab.create":
            fake.instance = "789:999"
            fake.workspaces = {"w1": "Someone else's workspace"}
            if kwargs.get("instance") == fake.instance:
                alien_tabs.append(params["workspace_id"])  # type: ignore[index]
            return original_request(method, params, **kwargs)
        return original_request(method, params, **kwargs)

    monkeypatch.setattr(herdr_runtime, "request", request)
    result = go(fake, {"city": {"server": "123:456", "workspaceId": "w1"}})
    assert (result.state, result.reason) == ("failed", "server_changed")
    assert alien_tabs == []


@pytest.mark.parametrize("change", ["different_instance", "different_label", "missing"])
def test_unverifiable_ownership_creates_a_new_workspace(fake: FakeLaunch, change: str) -> None:
    book = {"city": {"server": "123:456", "workspaceId": "w1"}}
    if change == "different_instance":
        fake.instance = "123:999"
    elif change == "different_label":
        fake.workspaces["w1"] = "Other"
    else:
        fake.workspaces.clear()
    assert go(fake, book).state == "ready"
    assert "workspace.create" in [method for method, _ in fake.calls]
    assert "tab.create" not in [method for method, _ in fake.calls]


def test_tab_workspace_disappearing_creates_once_without_retrying_tab(fake: FakeLaunch) -> None:
    fake.tab_error = "workspace_not_found"
    assert go(fake, {"city": {"server": "123:456", "workspaceId": "w1"}}).state == "ready"
    methods = [method for method, _ in fake.calls]
    assert methods.count("tab.create") == methods.count("workspace.create") == 1


def test_unreadable_instance_fails_closed_without_creating(fake: FakeLaunch) -> None:
    fake.instance = None
    result = go(fake)
    assert (result.state, result.reason) == ("failed", "server_changed")
    assert not fake.calls


@pytest.mark.parametrize("code", ["agent_pane_busy", "timeout", "agent_not_ready"])
def test_start_errors_fail_without_retry(fake: FakeLaunch, code: str) -> None:
    fake.start_error = herdr_runtime.HerdrError(code)
    assert (result := go(fake)).state == "failed" and result.reason == code
    assert [method for method, _ in fake.calls].count("agent.start") == 1


def test_server_restart_immediately_before_start_fails_without_sending(fake: FakeLaunch) -> None:
    result = go(fake, on_pane=lambda _pane, _term: setattr(fake, "instance", "789:999"))
    assert (result.state, result.reason) == ("failed", "server_changed")
    assert "agent.start" not in [method for method, _ in fake.calls]


def test_server_restart_after_shell_check_fails_before_start(
    fake: FakeLaunch, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def ready(*_args: Any) -> bool:
        fake.instance = "789:999"
        return True

    monkeypatch.setattr(herdr_runtime, "_shell_ready", ready)
    result = go(fake)
    assert (result.state, result.reason) == ("failed", "server_changed")
    assert "agent.start" not in [method for method, _ in fake.calls]


@pytest.mark.parametrize(("rows", "expected"), [
    ([{"agent_status": "idle", "launch_pending": False}], ("ready", None)),
    ([{"agent_status": "blocked", "launch_pending": False}], ("blocked", "agent_not_ready")),
    ([], ("failed", "agent_exited")),
    ([{"agent_status": "unknown", "launch_pending": True}], ("unknown", "launch_unconfirmed")),
])
def test_poll_waits_without_restarting(fake: FakeLaunch, rows: list[dict], expected: tuple[str, str | None]) -> None:
    fake.rows = [{**{"pane_id": "w2:p1", "terminal_id": "term2", "agent": "claude"}, **row} for row in rows]
    result = go(fake, timeout_ms=1 if expected[0] == "unknown" else 4000)
    assert (result.state, result.reason) == expected
    assert [method for method, _ in fake.calls].count("agent.start") == 1


def test_poll_waits_through_pending_then_ready(fake: FakeLaunch) -> None:
    fake.rows_sequence = [[{**fake.rows[0], "agent_status": "unknown", "launch_pending": True}], fake.rows]
    assert go(fake).state == "ready"
    assert [method for method, _ in fake.calls].count("agent.list") == 2


def test_poll_reports_blocked_even_before_kind_is_detected(fake: FakeLaunch) -> None:
    fake.rows[0].update(agent="", agent_status="blocked", launch_pending=True)
    result = go(fake)
    assert (result.state, result.reason) == ("blocked", "agent_not_ready")


def test_server_restart_during_poll_is_unknown_and_never_retried(
    fake: FakeLaunch, monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = fake.request

    def request(method: str, params: dict | None = None, **kwargs: Any) -> dict:
        if method == "agent.list":
            fake.instance = "789:999"
        return original(method, params, **kwargs)

    monkeypatch.setattr(herdr_runtime, "request", request)
    result = go(fake)
    assert (result.state, result.reason) == ("unknown", "server_changed")
    assert [method for method, _ in fake.calls].count("agent.start") == 1


@pytest.mark.parametrize(("sent", "expected"), [
    (False, ("failed", "server_changed")),
    (True, ("unknown", "launch_unconfirmed")),
])
def test_unavailable_start_distinguishes_sent_from_unsent(
    fake: FakeLaunch, sent: bool, expected: tuple[str, str],
) -> None:
    fake.start_error = herdr_runtime.HerdrError("unavailable", sent=sent)
    result = go(fake)
    assert (result.state, result.reason) == expected
    assert [method for method, _ in fake.calls].count("agent.start") == 1


def test_shell_not_ready_keeps_panel_and_never_invokes_cli(fake: FakeLaunch, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(herdr_runtime, "_shell_ready", lambda *_: False)
    result = go(fake)
    assert (result.state, result.reason, result.pane_id) == ("failed", "shell_not_ready", "w2:p1")
    assert "agent.start" not in [method for method, _ in fake.calls]


def test_persistent_workspace_book_is_reused(fake: FakeLaunch, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path))
    fake.workspaces["w2"] = "City"
    kwargs = {"city_id": "city", "cwd": "/selected/city", "label": "City",
              "path": "/private/h.sock", "timeout_ms": 4000}
    assert herdr_runtime.launch("claude", **kwargs).state == "ready"
    assert json.loads((tmp_path / "herdr-workspaces.json").read_text()) == {
        "city": {"server": "123:456", "workspaceId": "w2"},
    }
    assert herdr_runtime.launch("claude", **kwargs).state == "ready"
    assert [method for method, _ in fake.calls].count("workspace.create") == 1
    assert [method for method, _ in fake.calls].count("tab.create") == 1


@pytest.mark.parametrize("patch", [{"agent": "codex"}, {"agent_status": "unknown"}, {"launch_pending": True}])
def test_poll_requires_matching_ready_agent(fake: FakeLaunch, patch: dict) -> None:
    fake.rows[0].update(patch)
    result = go(fake, timeout_ms=1)
    assert (result.state, result.reason) == ("unknown", "launch_unconfirmed")


def test_invalid_kind_never_creates(fake: FakeLaunch) -> None:
    result = herdr_runtime.launch("other", city_id="city", cwd="/x", label="City", book={})
    assert (result.state, result.reason) == ("failed", "invalid_kind")
    assert not fake.calls


@pytest.mark.parametrize("payload", [
    {"city": "missing", "kind": "claude"},
    {"city": "city", "kind": "invalid"},
    {"city": "city", "kind": "claude", "repoPath": "/attacker"},
    {"city": "city", "kind": "claude", "cwd": "/attacker"},
    {"city": "city", "kind": "claude", "mission": "x" * 100001},
])
def test_target_validation_rejects_bad_inputs(monkeypatch: pytest.MonkeyPatch, payload: dict) -> None:
    monkeypatch.setattr(repo_roots_state, "resolve_selected_repo", lambda city: "/selected/city" if city == "city" else None)
    command = validate_command({"type": "herdr_launch", "target": payload["city"], "payload": payload})
    assert _validate_command_target(command)


def test_target_validation_resolves_city_and_forces_scheduler_unit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(repo_roots_state, "resolve_selected_repo", lambda city: "/selected/city" if city == "city" else None)
    command = validate_command({"type": "herdr_launch", "target": "city",
                                "payload": {"city": "city", "kind": "claude", "unit": "EVIL"}})
    assert _validate_command_target(command) is None
    assert command.payload["repoPath"] == "/selected/city"
    assert command.payload["unit"] == "HERDR"
    assert command.risk == "low"
    assert policy.decide(command)[0] == "auto-safe"


def test_policy_overlay_keeps_launch_waiting_for_approval(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from server import policies_yaml

    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path))
    policies = tmp_path / "policies.d"
    policies.mkdir()
    (policies / "herdr.yaml").write_text("""policies:
  - name: approve_herdr
    applies_to: {command_types: [herdr_launch]}
    effect: {decision: approve}
""")
    policies_yaml.reset_for_tests()
    try:
        cmd = Command(type="herdr_launch", target="city", payload={"kind": "claude", "city": "city"})
        decision, _ = policy.apply_policy(cmd)
        assert decision.status == "waiting_approval"
        assert decision.requires_approval
    finally:
        policies_yaml.reset_for_tests()


def test_policy_approval_never_dispatches_and_hides_server_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from server import bridge, policies_yaml
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path))
    policies = tmp_path / "policies.d"
    policies.mkdir()
    (policies / "herdr.yaml").write_text("""policies:
  - name: approve_herdr
    applies_to: {command_types: [herdr_launch]}
    effect: {decision: approve}
""")
    policies_yaml.reset_for_tests()
    enqueue, add_approval, created = Mock(), Mock(), Mock()
    monkeypatch.setattr(bridge._sched, "enqueue", enqueue)
    monkeypatch.setattr(bridge, "_add_approval", add_approval)
    monkeypatch.setattr(bridge, "build_context_pack", lambda *_: {})
    monkeypatch.setattr(bridge, "send_to_repociv", Mock())
    monkeypatch.setattr(bridge._es, "record_created", created)
    monkeypatch.setattr(bridge._es, "record_waiting_approval", Mock())
    try:
        cmd = Command(type="herdr_launch", target="city", payload={
            "city": "city", "kind": "claude", "unit": "HERDR", "repoPath": "/secret/city",
        })
        response = bridge._handle_command(cmd)
        assert response["status"] == "waiting_approval"
        assert not enqueue.called and add_approval.called
        assert "/secret" not in json.dumps(created.call_args.args)
    finally:
        policies_yaml.reset_for_tests()

def test_launch_risk_floor_survives_auto_safe_overlay(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from server import policies_yaml
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path))
    policies = tmp_path / "policies.d"
    policies.mkdir()
    (policies / "herdr.yaml").write_text("""policies:
  - name: allow_herdr
    applies_to: {command_types: [herdr_launch]}
    effect: {decision: auto-safe}
""")
    policies_yaml.reset_for_tests()
    try:
        cmd = Command(type="herdr_launch", target="city", risk="high")
        assert policy.decide(cmd)[0] == "approve"
    finally:
        policies_yaml.reset_for_tests()

@pytest.mark.parametrize(("state", "instance"), [
    ("ready", "123:456"), ("ready", None), ("blocked", "123:456"),
    ("unknown", "123:456"), ("failed", "123:456"),
])
def test_executor_sends_mission_once_only_when_ready_and_exposes_no_paths(
    monkeypatch: pytest.MonkeyPatch, state: str, instance: str | None,
) -> None:
    from server import command_executors
    from server.routes.core import get_herdr_launch

    sent: list[tuple[str, str, str | None, str | None]] = []
    events: list[dict] = []
    completed = Mock()
    failed = Mock()

    def launch(_kind: str, *, on_pane: Any, **_kwargs: Any) -> Any:
        on_pane("w1:p1", "term1")
        return herdr_runtime.LaunchResult(state, "agent_not_ready" if state == "blocked" else None,
                                          "term1", "w1:p1", "w1", "claude-city-1234", instance)

    async def submit(pane: str, text: str, *, expect_agent: str | None = None, instance: str | None = None) -> Any:
        sent.append((pane, text, expect_agent, instance))
        return herdr_runtime.SubmitResult("confirmed")

    monkeypatch.setattr(herdr_runtime, "launch", launch)
    monkeypatch.setattr(herdr_runtime, "submit", submit)
    cmd = Command(id=f"cmd-{state}", type="herdr_launch", target="city", payload={
        "city": "city", "kind": "claude", "mission": "hello", "repoPath": "/secret/city", "unit": "HERDR",
    })
    kwargs = {name: Mock() for name in (
        "run_agent", "append_pending_task", "save_mission", "infer_adapter_for_command", "sessions_patch",
        "sessions_append_message", "run_state_save", "event_record_output_chunk", "record_outcome",
        "register_issue_run_fn", "task_run", "subagent_approve_spawn", "subagent_request_dispatch",
    )}
    command_executors.dispatch_command(cmd, send_to_repociv=events.append, event_record_completed=completed,
                                       event_record_failed=failed, **kwargs)
    ready = state == "ready" and instance is not None
    final_state = "failed" if state == "ready" and not instance else state
    assert sent == ([("w1:p1", "hello", "claude", instance)] if ready else [])
    code, entry = get_herdr_launch({"command_id": cmd.id})
    assert code == 200 and entry["state"] == final_state
    assert entry["missionDelivery"] == (
        {"state": "confirmed", "reason": None} if ready
        else {"state": "refused", "reason": "agent_not_ready"}
    )
    assert "/secret" not in json.dumps([entry, events])
    assert any(event["state"] == "starting" and event["paneId"] == "w1:p1" for event in events)
    assert failed.called == (final_state == "failed")
    assert completed.called == (final_state != "failed")
    assert get_herdr_launch({"command_id": "absent"})[0] == 404
