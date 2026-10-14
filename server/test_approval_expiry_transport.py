"""Real HTTP/WS transport and JSONL audit expiry integration (isolated state)."""
import asyncio
import json
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import AsyncMock

import pytest

from server import approval_store as store
from server import bridge, event_store as es, scheduler, sse_server, websocket_handler as ws


@pytest.fixture
def transport_env(isolated_approval_store, monkeypatch):
    path = isolated_approval_store
    monkeypatch.setattr(es, "_store_path", path / "events.jsonl")
    monkeypatch.setattr(es, "_ledger_ingest", lambda event: None)
    queue, messages = [], []
    monkeypatch.setattr(scheduler, "enqueue", queue.append)
    monkeypatch.setattr(sse_server, "send_to_repociv", messages.append)
    monkeypatch.setattr(bridge, "REPOCIV_TOKEN", "")
    return path, queue, messages


def add_expired():
    cmd = {"id": "expired", "type": "read_file", "target": "repo", "expires_at": time.time() - 1}
    es.record_created(cmd["id"], "user", cmd)
    es.record_waiting_approval(cmd["id"])
    store.add_approval(cmd)


def assert_audited(path, queue):
    events = [json.loads(line) for line in (path / "events.jsonl").read_text().splitlines()]
    rejected = [ev for ev in events if ev["type"] == "CommandRejected"]
    assert len(rejected) == 1
    assert rejected[0]["commandId"] == "expired"
    assert rejected[0]["data"]["reason"] == "approval expired"
    assert not any(ev["type"] in ("CommandApproved", "CommandQueued", "CommandStarted") for ev in events)
    assert json.loads((path / "approvals.json").read_text()) == {}
    assert queue == []


@pytest.mark.parametrize("route", ["/approvals/expired/approve", "/approvals/expired/reject"])
def test_http_late_response_rejected_with_real_audit(transport_env, route):
    path, queue, _ = transport_env
    add_expired()
    server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.BridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        request = urllib.request.Request(
            f"http://127.0.0.1:{server.server_port}{route}",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as response_error:
            response = response_error
        with response:
            result = json.loads(response.read())
        assert result["ok"] is False
        assert result["status"] == "expired"
        assert_audited(path, queue)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def test_ws_late_response_rejected_with_real_audit(transport_env, monkeypatch):
    path, queue, _ = transport_env
    add_expired()
    connection = AsyncMock()

    async def allow(_):
        return True

    monkeypatch.setattr(ws, "_rate_check", allow)
    asyncio.run(ws._handle_incoming(connection, json.dumps({"type": "approval", "id": "expired", "approved": True})))
    response = json.loads(connection.send.call_args.args[0])
    assert response == {"type": "error", "msg": "approval expired"}
    assert_audited(path, queue)
