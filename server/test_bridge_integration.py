import json
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer

from server import bridge


def _start_test_server():
    server = ThreadingHTTPServer(("localhost", 0), bridge.BridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}"


def test_health_endpoint_returns_liveness_shape():
    server, base = _start_test_server()
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=2) as resp:
            data = json.loads(resp.read().decode())
        assert data["ok"] is True
        assert "openclaw" in data
    finally:
        server.shutdown()
        server.server_close()


def test_events_endpoint_serves_history_as_json():
    server, base = _start_test_server()
    try:
        with urllib.request.urlopen(f"{base}/events", timeout=2) as resp:
            data = json.loads(resp.read().decode())
        assert isinstance(data, list)
    finally:
        server.shutdown()
        server.server_close()


def test_events_endpoint_streams_sse_fanout():
    server, base = _start_test_server()
    try:
        req = urllib.request.Request(f"{base}/events", headers={"Accept": "text/event-stream"})
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
