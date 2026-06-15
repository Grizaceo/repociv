"""Tests para server/mcp_server.py — bridge mockeado con unittest.mock.

Cubre:
  - _get / _post llaman a las URLs correctas
  - Mutating tools añaden X-RepoCiv-Token en header
  - Sin token configurado, mutating tools lanzan ValueError
  - Bridge caído → RuntimeError con mensaje útil
  - Respuestas de error HTTP se propagan
  - Representantes de cada dominio (agents, commands, approvals, pending,
    context, observability, improve, providers, tasks, directives, events, ws)
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

import httpx
import pytest

import server.mcp_server as _mcp


# ─── Helpers ──────────────────────────────────────────────────────────────────

class _FakeResponse:
    def __init__(self, data: Any, status_code: int = 200) -> None:
        self._data = data
        self.status_code = status_code
        self.text = json.dumps(data)

    def json(self) -> Any:
        return self._data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=MagicMock(),
                response=MagicMock(status_code=self.status_code, text=self.text),
            )


def _mock_get(data: Any, status: int = 200):
    return patch("httpx.get", return_value=_FakeResponse(data, status))


def _mock_post(data: Any, status: int = 200):
    return patch("httpx.post", return_value=_FakeResponse(data, status))


def _token_env(token: str = "test-token"):
    return patch.object(_mcp, "TOKEN", token)


def _no_token():
    return patch.object(_mcp, "TOKEN", "")


# ══════════════════════════════════════════════════════════════════════════════
# AGENTS (read-only)
# ══════════════════════════════════════════════════════════════════════════════

def test_agents_list_calls_correct_url():
    payload = {"agents": [{"id": "DAVI-1", "status": "idle"}]}
    with _mock_get(payload) as m:
        result = _mcp.agents_list()
    url = m.call_args[0][0]
    assert url.endswith("/agents")
    assert result == payload


def test_agents_capabilities():
    payload = {"capabilities": {"MAIN": ["commit", "execute"]}}
    with _mock_get(payload) as m:
        result = _mcp.agents_capabilities()
    assert "/agents/capabilities" in m.call_args[0][0]
    assert result == payload


def test_agents_health():
    with _mock_get({"ok": True}) as m:
        _mcp.agents_health()
    assert m.call_args[0][0].endswith("/health")


def test_agents_ready():
    with _mock_get({"ready": True}) as m:
        _mcp.agents_ready()
    assert m.call_args[0][0].endswith("/ready")


# ══════════════════════════════════════════════════════════════════════════════
# COMMANDS (mutating)
# ══════════════════════════════════════════════════════════════════════════════

def test_command_submit_sends_token():
    resp = {"ok": True, "commandId": "abc123", "status": "queued"}
    with _token_env(), _mock_post(resp) as m:
        result = _mcp.command_submit("run_tests", "my-repo")
    headers_sent = m.call_args[1]["headers"]
    assert "X-RepoCiv-Token" in headers_sent
    assert result["ok"] is True


def test_command_submit_includes_payload():
    resp = {"ok": True, "commandId": "x", "status": "queued"}
    with _token_env(), _mock_post(resp) as m:
        _mcp.command_submit("edit_file", "repo/file.py", payload={"line": 42}, risk="medium")
    body = json.loads(m.call_args[1]["content"])
    assert body["payload"] == {"line": 42}
    assert body["risk"] == "medium"


def test_command_submit_no_token_raises():
    with _no_token():
        with pytest.raises(ValueError, match="REPOCIV_TOKEN"):
            _mcp.command_submit("run_tests", "my-repo")


def test_command_cancel_sends_token():
    with _token_env(), _mock_post({"ok": True, "commandId": "cmd-1"}) as m:
        _mcp.command_cancel("cmd-1")
    assert "/commands/cmd-1/cancel" in m.call_args[0][0]


# ══════════════════════════════════════════════════════════════════════════════
# MISSIONS
# ══════════════════════════════════════════════════════════════════════════════

def test_missions_list():
    with _mock_get([{"id": "m1"}]) as m:
        result = _mcp.missions_list()
    assert m.call_args[0][0].endswith("/missions")
    assert result[0]["id"] == "m1"


def test_missions_log_passes_params():
    with _mock_get([]) as m:
        _mcp.missions_log(n=10, type="agent_started")
    params = m.call_args[1]["params"]
    assert params["n"] == 10
    assert params["type"] == "agent_started"


# ══════════════════════════════════════════════════════════════════════════════
# APPROVALS
# ══════════════════════════════════════════════════════════════════════════════

def test_approvals_list():
    with _mock_get([]) as m:
        _mcp.approvals_list()
    assert m.call_args[0][0].endswith("/approvals")


def test_approval_approve_url():
    with _token_env(), _mock_post({"ok": True}) as m:
        _mcp.approval_approve("app-99")
    assert "/approvals/app-99/approve" in m.call_args[0][0]


def test_approval_reject_url():
    with _token_env(), _mock_post({"ok": True}) as m:
        _mcp.approval_reject("app-99")
    assert "/approvals/app-99/reject" in m.call_args[0][0]


# ══════════════════════════════════════════════════════════════════════════════
# PENDING TASKS
# ══════════════════════════════════════════════════════════════════════════════

def test_pending_list():
    with _mock_get([{"id": "p1", "title": "Fix tests"}]) as m:
        result = _mcp.pending_list()
    assert m.call_args[0][0].endswith("/pending")
    assert result[0]["title"] == "Fix tests"


def test_pending_add_body():
    with _token_env(), _mock_post({"ok": True, "id": "p2"}) as m:
        _mcp.pending_add("Deploy staging", priority="high")
    body = json.loads(m.call_args[1]["content"])
    assert body == {"title": "Deploy staging", "priority": "high"}


def test_pending_resolve_body():
    with _token_env(), _mock_post({"ok": True}) as m:
        _mcp.pending_resolve("p1")
    body = json.loads(m.call_args[1]["content"])
    assert body["id"] == "p1"


def test_pending_edit_only_includes_provided_fields():
    with _token_env(), _mock_post({"ok": True}) as m:
        _mcp.pending_edit("p1", title="New title")
    body = json.loads(m.call_args[1]["content"])
    assert "priority" not in body
    assert body["title"] == "New title"


def test_pending_delete_body():
    with _token_env(), _mock_post({"ok": True}) as m:
        _mcp.pending_delete("p3")
    body = json.loads(m.call_args[1]["content"])
    assert body["id"] == "p3"


def test_pending_state_body():
    with _token_env(), _mock_post({"ok": True}) as m:
        _mcp.pending_state("p1", "blocked")
    body = json.loads(m.call_args[1]["content"])
    assert body == {"id": "p1", "state": "blocked"}


# ══════════════════════════════════════════════════════════════════════════════
# CONTEXT / FATIGUE
# ══════════════════════════════════════════════════════════════════════════════

def test_context_fatigue():
    payload = {"fatigue": {"DAVI-1": {"fatigue": 2}}, "restAreas": []}
    with _mock_get(payload) as m:
        result = _mcp.context_fatigue()
    assert m.call_args[0][0].endswith("/context")
    assert "fatigue" in result


# ══════════════════════════════════════════════════════════════════════════════
# OBSERVABILITY
# ══════════════════════════════════════════════════════════════════════════════

def test_gpu_status():
    with _mock_get({"vramUsed": 4, "vramTotal": 24, "temp": 65}) as m:
        result = _mcp.gpu_status()
    assert m.call_args[0][0].endswith("/gpu")
    assert result["vramTotal"] == 24


def test_metrics_snapshot():
    with _mock_get({"queueDepth": 0}) as m:
        _mcp.metrics_snapshot()
    assert m.call_args[0][0].endswith("/metrics")


# ══════════════════════════════════════════════════════════════════════════════
# IMPROVE / SICA
# ══════════════════════════════════════════════════════════════════════════════

def test_improve_reflect():
    with _mock_get({"patterns": []}) as m:
        _mcp.improve_reflect()
    assert "/improve/reflect" in m.call_args[0][0]


def test_improve_proposals():
    with _mock_get({"proposals": []}) as m:
        _mcp.improve_proposals()
    assert "/improve/proposals" in m.call_args[0][0]


# ══════════════════════════════════════════════════════════════════════════════
# PROVIDERS & HARNESSES
# ══════════════════════════════════════════════════════════════════════════════

def test_providers_list():
    with _mock_get({"providers": []}) as m:
        _mcp.providers_list()
    assert m.call_args[0][0].endswith("/providers")


def test_providers_live():
    with _mock_get({"providers": []}) as m:
        _mcp.providers_live()
    assert "/providers/live" in m.call_args[0][0]


def test_harnesses_list():
    with _mock_get({"harnesses": []}) as m:
        _mcp.harnesses_list()
    assert m.call_args[0][0].endswith("/harnesses")


def test_harness_recovery_url_and_body():
    with _token_env(), _mock_post({"mode": "copy_command"}) as m:
        _mcp.harness_recovery("hermes-local", "command_failed", "run_tests", "my-repo")
    assert "/harnesses/hermes-local/recovery-command" in m.call_args[0][0]
    body = json.loads(m.call_args[1]["content"])
    assert body["reason"] == "command_failed"


# ══════════════════════════════════════════════════════════════════════════════
# TASKS (P3)
# ══════════════════════════════════════════════════════════════════════════════

def test_tasks_list():
    with _mock_get([]) as m:
        _mcp.tasks_list()
    assert m.call_args[0][0].endswith("/tasks")


def test_task_get_url():
    with _mock_get({"status": "running"}) as m:
        _mcp.task_get("my-repo", "42")
    assert "/tasks/my-repo/42" in m.call_args[0][0]


def test_task_cancel_url():
    with _token_env(), _mock_post({"ok": True}) as m:
        _mcp.task_cancel("my-repo", "42")
    assert "/tasks/my-repo/42/cancel" in m.call_args[0][0]


# ══════════════════════════════════════════════════════════════════════════════
# DIRECTIVES
# ══════════════════════════════════════════════════════════════════════════════

def test_directives_stats():
    with _mock_get({"count": 5}) as m:
        _mcp.directives_stats()
    assert "/directives/stats" in m.call_args[0][0]


def test_directives_suggest_params():
    with _mock_get({"suggestions": []}) as m:
        _mcp.directives_suggest("spawn", "DAVI-1", repo_type="python")
    params = m.call_args[1]["params"]
    assert params["gesture"] == "spawn"
    assert params["repoType"] == "python"


def test_directive_record_body():
    with _token_env(), _mock_post({"ok": True}) as m:
        _mcp.directive_record("cmd-1", "spawn", "DAVI-1", "execute_agent", "repo/x")
    body = json.loads(m.call_args[1]["content"])
    assert body["commandId"] == "cmd-1"
    assert body["gesture"] == "spawn"


# ══════════════════════════════════════════════════════════════════════════════
# EVENTS & WS
# ══════════════════════════════════════════════════════════════════════════════

def test_events_since_passes_ts():
    with _mock_get([]) as m:
        _mcp.events_since(since_unix_ts=1700000000.0)
    params = m.call_args[1]["params"]
    assert params["since"] == 1700000000.0


def test_ws_info():
    with _mock_get({"wsUrl": "ws://localhost:5275"}) as m:
        result = _mcp.ws_info()
    assert m.call_args[0][0].endswith("/ws")
    assert "wsUrl" in result


# ══════════════════════════════════════════════════════════════════════════════
# ERROR HANDLING
# ══════════════════════════════════════════════════════════════════════════════

def test_bridge_down_raises_useful_error():
    with patch("httpx.get", side_effect=httpx.ConnectError("refused")):
        with pytest.raises(RuntimeError, match="bridge no responde"):
            _mcp.agents_list()


def test_http_error_propagated():
    with patch("httpx.get", return_value=_FakeResponse({"error": "not found"}, 404)):
        with pytest.raises(RuntimeError, match="Bridge error 404"):
            _mcp.agents_list()


def test_mutating_no_token_raises_before_http_call():
    with _no_token():
        with patch("httpx.post") as m:
            with pytest.raises(ValueError):
                _mcp.pending_add("task x")
        m.assert_not_called()
