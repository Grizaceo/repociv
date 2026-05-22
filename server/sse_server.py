import os
import json
from pathlib import Path
from typing import Any
import logging
import urllib.request

from server import sessions as _sessions

REPOCIV_PORT = int(os.environ.get("REPOCIV_PORT", "5273"))

import queue
import threading

# ─── Event sender → RepoCiv frontend ─────────────────────────────────────────
_sse_lock = threading.Lock()
_sse_clients: list[queue.Queue[dict[str, Any] | None]] = []

# Optional WebSocket broadcast hook (set by websocket_handler.py via bridge.py)
_ws_broadcast_hook = None


def _fanout_sse(event: dict[str, Any]) -> None:
    with _sse_lock:
        clients = list(_sse_clients)
    for client in clients:
        try:
            client.put_nowait(event)
        except Exception:
            pass
    # Also broadcast via WebSocket if the hook is set
    hook = _ws_broadcast_hook
    if hook is not None:
        try:
            hook(event)
        except Exception:
            pass


def set_ws_broadcast_hook(hook=None) -> None:
    """Set or clear the WebSocket broadcast hook.

    Called from bridge.py at startup to wire WS events into the SSE fan-out.
    Pass None to clear (teardown).
    """
    global _ws_broadcast_hook
    _ws_broadcast_hook = hook


def _register_sse_client(client: queue.Queue[dict[str, Any] | None]) -> None:
    with _sse_lock:
        _sse_clients.append(client)


def _unregister_sse_client(client: queue.Queue[dict[str, Any] | None]) -> None:
    with _sse_lock:
        try:
            _sse_clients.remove(client)
        except ValueError:
            pass


def send_to_repociv(event: dict[str, Any]) -> None:
    event_type = str(event.get("type", ""))
    unit = str(event.get("unit", ""))
    mission_id = str(event.get("missionId", ""))
    if event_type == "chat_chunk" and unit and mission_id:
        try:
            _sessions.append_message(unit, "assistant", str(event.get("text", "")), {"missionId": mission_id})
        except Exception:
            pass
    _fanout_sse(event)


