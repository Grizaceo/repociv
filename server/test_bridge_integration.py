import json
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from server import bridge


def test_init_bridge_state_rebinds_persistent_paths(tmp_path):
    original_config_dir = bridge.CONFIG_DIR
    try:
        selected = bridge.init_bridge_state(tmp_path)

        assert selected == tmp_path
        assert bridge.CONFIG_DIR == tmp_path
        assert bridge.MISSIONS_FILE == tmp_path / "missions.json"
        bridge._ds.record_gesture("cmd-1", "drag", "MAIN", "unit_command", "repo")
        assert (tmp_path / "directive_records.jsonl").exists()
    finally:
        bridge.init_bridge_state(original_config_dir)


def _start_test_server():
    server = ThreadingHTTPServer(("localhost", 0), bridge.BridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}"


def _auth_headers(extra=None):
    """Mirror a real client: send the token header when the bridge has one.

    bridge.py loads .env on import, so REPOCIV_TOKEN may be set even in local
    dev. Tests that hit auth-gated routes must send the header like the UI does.

    Auth-gated routes (require this helper): /events, /agents, /pending,
    /approvals, /missions, /metrics, /commands (POST), /approve (POST).
    Auth-exempt routes (no header needed): /health, /ready.
    """
    headers = dict(extra or {})
    if bridge.REPOCIV_TOKEN:
        headers["X-RepoCiv-Token"] = bridge.REPOCIV_TOKEN
    return headers


def test_health_endpoint_returns_liveness_shape():
    server, base = _start_test_server()
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=2) as resp:
            data = json.loads(resp.read().decode())
        assert data["ok"] is True
        assert "openclaw" in data
        assert data.get("defaultTransport") == "hermes"
        # Extended health payload (2026-05-13)
        assert "version" in data
        assert "timestamp" in data
        assert "agents" in data
        assert isinstance(data["agents"].get("active"), int)
        assert isinstance(data["agents"].get("total"), int)
        assert isinstance(data["agents"].get("queueDepth"), int)
        assert "gpu" in data
        assert "eventStore" in data
    finally:
        server.shutdown()
        server.server_close()


def test_events_endpoint_serves_history_as_json():
    server, base = _start_test_server()
    try:
        req = urllib.request.Request(f"{base}/events", headers=_auth_headers())
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode())
        assert isinstance(data, list)
    finally:
        server.shutdown()
        server.server_close()


def test_events_endpoint_accepts_token_via_query_param(monkeypatch):
    """EventSource cannot send headers — /events must accept ?token=<token>."""
    monkeypatch.setattr(bridge, "REPOCIV_TOKEN", "sse-test-token")
    server, base = _start_test_server()
    try:
        # Valid token via query param → 200
        with urllib.request.urlopen(f"{base}/events?token=sse-test-token", timeout=2) as resp:
            data = json.loads(resp.read().decode())
        assert isinstance(data, list)
        # Wrong token via query param → 401
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(f"{base}/events?token=wrong", timeout=2)
        assert exc_info.value.code == 401
        # Query token is only honored for /events, not other routes
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(f"{base}/missions?token=sse-test-token", timeout=2)
        assert exc_info.value.code == 401
    finally:
        server.shutdown()
        server.server_close()


def test_metrics_include_endpoint_usage():
    server, base = _start_test_server()
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=2):
            pass
        req = urllib.request.Request(f"{base}/metrics", headers=_auth_headers())
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode())
        assert any(
            row["method"] == "GET" and row["path"] == "/health" and row["count"] >= 1
            for row in data["endpointUsage"]
        )
    finally:
        server.shutdown()
        server.server_close()


def test_events_endpoint_streams_sse_fanout():
    server, base = _start_test_server()
    try:
        req = urllib.request.Request(
            f"{base}/events", headers=_auth_headers({"Accept": "text/event-stream"})
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            first = resp.readline().decode().strip()
            assert first == 'data: {"type":"ping"}'
            # consume blank line after first SSE frame
            resp.readline()

            bridge.send_to_repociv({"type": "log", "msg": "sse-ok"})
            deadline = time.time() + 2
            seen = ""
            while time.time() < deadline:
                line = resp.readline().decode().strip()
                if line:
                    seen = line
                    break
            assert seen.startswith("data: ")
            payload = json.loads(seen.removeprefix("data: "))
            assert payload == {"type": "log", "msg": "sse-ok"}
    finally:
        server.shutdown()
        server.server_close()


# ─── Remote mode tests ────────────────────────────────────────────────────────

def test_remote_mode_defaults_to_localhost():
    """Without REPOCIV_REMOTE, bridge uses 127.0.0.1 as default host."""
    # The bridge module was loaded without REPOCIV_REMOTE in the test session
    assert bridge.BRIDGE_HOST == "127.0.0.1", f"Expected 127.0.0.1, got {bridge.BRIDGE_HOST}"
    assert bridge.REPOCIV_REMOTE is False


def test_remote_mode_with_token_host_is_0_0_0_0(monkeypatch):
    """With REPOCIV_REMOTE=true + REPOCIV_TOKEN, BRIDGE_HOST is 0.0.0.0."""
    monkeypatch.setenv("REPOCIV_REMOTE", "true")
    monkeypatch.setenv("REPOCIV_TOKEN", "test-token-for-remote-32-chars-min!!")
    import importlib
    importlib.reload(bridge)
    assert bridge.BRIDGE_HOST == "0.0.0.0"
    assert bridge.REPOCIV_REMOTE is True


def test_remote_mode_without_token_raises(monkeypatch):
    """With REPOCIV_REMOTE=true but no REPOCIV_TOKEN, bridge raises SystemExit."""
    monkeypatch.setenv("REPOCIV_REMOTE", "true")
    monkeypatch.setenv("REPOCIV_TOKEN", "")  # Override .env: empty = no token
    import importlib
    with pytest.raises(SystemExit):
        importlib.reload(bridge)


def test_dev_mode_works_without_token(monkeypatch):
    """Without REPOCIV_REMOTE, no token is required (dev mode)."""
    monkeypatch.delenv("REPOCIV_REMOTE", raising=False)
    monkeypatch.setenv("REPOCIV_TOKEN", "")  # Override .env: empty = dev mode
    import importlib
    importlib.reload(bridge)
    assert bridge.REPOCIV_REMOTE is False
    assert bridge.REPOCIV_TOKEN == ""  # Empty = dev mode
    assert bridge.BRIDGE_HOST == "127.0.0.1"


# ─── Approval idempotency ─────────────────────────────────────────────────────

def test_approval_concurrent_requests_only_one_succeeds():
    """Three simultaneous /approvals/<id>/approve requests — exactly one succeeds."""
    CMD_ID = "test-approval-idempotency-001"
    bridge._add_approval({
        "id": CMD_ID, "type": "unit_command", "target": "test-repo",
        "payload": {"unit": "MAIN", "mission": "smoke test"},
        "created_by": "user", "risk": "low",
    })

    server, base = _start_test_server()
    results: list[dict] = []
    lock = threading.Lock()

    def do_approve():
        try:
            req = urllib.request.Request(
                f"{base}/approvals/{CMD_ID}/approve",
                data=b"{}",
                headers=_auth_headers({"Content-Type": "application/json"}),
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode())
                with lock:
                    results.append(data)
        except urllib.error.HTTPError as e:
            data = json.loads(e.read().decode())
            with lock:
                results.append(data)
        except Exception as exc:
            with lock:
                results.append({"error": str(exc)})

    try:
        threads = [threading.Thread(target=do_approve) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        ok_count = sum(1 for r in results if r.get("ok") is True)
        not_found_count = sum(1 for r in results if r.get("error") == "approval not found")

        assert ok_count == 1, f"Expected exactly 1 success, got {ok_count}: {results}"
        assert not_found_count == 2, f"Expected 2 'not found', got {not_found_count}: {results}"
    finally:
        server.shutdown()
        server.server_close()
