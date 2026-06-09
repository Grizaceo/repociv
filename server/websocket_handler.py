#!/usr/bin/env python3
"""RepoCiv — WebSocket bidirectional transport.

Architecture:
  Runs alongside ThreadingHTTPServer in a separate thread with its own
  asyncio event loop. WebSocket connections share the same event fan-out
  as SSE clients via the _ws_broadcast_hook pattern in sse_server.py.

  Incoming WS messages (commands, approvals) are forwarded to the same
  bridge.py HTTP handlers for uniform processing.

Port:
  BRIDGE_WS_PORT (default 5275), or uses websockets.sync.server for
  synchronous integration with the existing thread-per-request model.

Heartbeat:
  30s interval. Clients that miss 3 consecutive pings are disconnected.

Rate limit:
  60 messages per 60s per connection (in-memory sliding window).

Security:
  - Requires X-RepoCiv-Token on connect if REPOCIV_TOKEN is set.
  - Rate limited per connection.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import threading
import time
from typing import Any, Callable

import websockets
import websockets.asyncio.server

logger = logging.getLogger("repociv.ws")

# ─── Configuration ────────────────────────────────────────────────────────────
BRIDGE_WS_PORT = int(os.environ.get("BRIDGE_WS_PORT", "5275"))
REPOCIV_TOKEN = os.environ.get("REPOCIV_TOKEN", "")
REPOCIV_REMOTE = os.environ.get("REPOCIV_REMOTE", "").lower() in ("true", "1", "yes")
WS_HOST = "0.0.0.0" if REPOCIV_REMOTE else os.environ.get("BRIDGE_WS_HOST", "127.0.0.1")

# Rate limit: 60 messages / 60s window per connection
_RATE_LIMIT = 60
_RATE_WINDOW = 60.0

# Heartbeat
_HEARTBEAT_INTERVAL = 30
_HEARTBEAT_MISSED_LIMIT = 3

# ─── Command dispatch callback (set by bridge.py) ────────────────────────────
_command_callback: Callable[[dict[str, Any]], None] | None = None


def _token_matches(candidate: Any) -> bool:
    """Constant-time token comparison for WebSocket auth."""
    if not isinstance(candidate, str):
        return False
    return hmac.compare_digest(candidate.encode("utf-8"), REPOCIV_TOKEN.encode("utf-8"))


def set_command_callback(cb: Callable[[dict[str, Any]], None]) -> None:
    """Register the bridge command handler for incoming WS messages."""
    global _command_callback
    _command_callback = cb


# ─── WebSocket manager state ─────────────────────────────────────────────────
_connections: dict[websockets.asyncio.server.ServerConnection, dict[str, Any]] = {}
_connections_lock = asyncio.Lock()
_loop: asyncio.AbstractEventLoop | None = None


async def _register(ws: websockets.asyncio.server.ServerConnection) -> None:
    async with _connections_lock:
        _connections[ws] = {
            "connected_at": time.time(),
            "rate_ts": [],
            "missed_heartbeats": 0,
        }


async def _unregister(ws: websockets.asyncio.server.ServerConnection) -> None:
    async with _connections_lock:
        _connections.pop(ws, None)


async def _rate_check(ws: websockets.asyncio.server.ServerConnection) -> bool:
    """Return True if the message is allowed, False if rate-limited."""
    now = time.time()
    async with _connections_lock:
        entry = _connections.get(ws)
        if entry is None:
            return False
        bucket = entry["rate_ts"]
        bucket[:] = [t for t in bucket if now - t < _RATE_WINDOW]
        if len(bucket) >= _RATE_LIMIT:
            return False
        bucket.append(now)
        return True


# ─── WS event loop access (for sync → async broadcast) ────────────────────────
def get_event_loop() -> asyncio.AbstractEventLoop | None:
    return _loop


async def _do_broadcast(event: dict[str, Any]) -> None:
    """Async internal broadcast to all connected WS clients."""
    if not _connections:
        return
    payload = json.dumps(event)
    dead: list[websockets.asyncio.server.ServerConnection] = []
    async with _connections_lock:
        for ws in list(_connections.keys()):
            try:
                await ws.send(payload)
            except websockets.exceptions.WebSocketException:
                dead.append(ws)
    # Clean up dead connections outside the iteration
    if dead:
        async with _connections_lock:
            for ws in dead:
                _connections.pop(ws, None)


def broadcast(event: dict[str, Any]) -> None:
    """Thread-safe broadcast called from sync code (bridge.py / sse_server.py).

    Schedules the async send on the WS event loop.
    """
    loop = _loop
    if loop is None or not loop.is_running():
        return
    try:
        asyncio.run_coroutine_threadsafe(_do_broadcast(event), loop)
    except RuntimeError:
        pass  # Event loop is closed


# ─── Token auth on connect ────────────────────────────────────────────────────
async def _auth_ws(ws: websockets.asyncio.server.ServerConnection) -> bool:
    """Authenticate incoming WS connection.

    If REPOCIV_TOKEN is empty (dev mode), auto-authenticate and send auth_ok.
    Otherwise, the client must send an auth message within 5s:
      {"type": "auth", "token": "..."}
    """
    if not REPOCIV_TOKEN:
        await ws.send(json.dumps({"type": "auth_ok"}))
        return True  # Dev mode: auto-auth
    try:
        msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
        if isinstance(msg, bytes):
            msg = msg.decode()
        data = json.loads(msg)
        if data.get("type") == "auth" and _token_matches(data.get("token")):
            await ws.send(json.dumps({"type": "auth_ok"}))
            return True
        await ws.send(json.dumps({"type": "auth_error", "msg": "invalid token"}))
        return False
    except asyncio.TimeoutError:
        await ws.send(json.dumps({"type": "auth_error", "msg": "auth timeout"}))
        return False
    except Exception:
        return False


# ─── Heartbeat ────────────────────────────────────────────────────────────────
async def _heartbeat_loop(ws: websockets.asyncio.server.ServerConnection) -> None:
    """Send ping every 30s, disconnect after 3 missed pongs."""
    while True:
        await asyncio.sleep(_HEARTBEAT_INTERVAL)
        try:
            pong_waiter = await ws.ping()
            await asyncio.wait_for(pong_waiter, timeout=5.0)
            # Reset missed counter on successful pong
            async with _connections_lock:
                entry = _connections.get(ws)
                if entry:
                    entry["missed_heartbeats"] = 0
        except asyncio.TimeoutError:
            disconnect = False
            async with _connections_lock:
                entry = _connections.get(ws)
                if entry:
                    entry["missed_heartbeats"] += 1
                    disconnect = entry["missed_heartbeats"] >= _HEARTBEAT_MISSED_LIMIT
            if disconnect:
                logger.info("WS client disconnected (heartbeat timeout)")
                try:
                    await ws.close(4000, "heartbeat timeout")
                except websockets.exceptions.WebSocketException:
                    pass
                return
        except websockets.exceptions.WebSocketException:
            return


# ─── Message handler ──────────────────────────────────────────────────────────
async def _handle_incoming(ws: websockets.asyncio.server.ServerConnection, message: Any) -> None:
    """Process an incoming message from a WS client.

    Supports commands, approvals, and health pings.
    """
    if isinstance(message, bytes):
        message = message.decode()

    # Rate limit check
    allowed = await _rate_check(ws)
    if not allowed:
        await ws.send(json.dumps({"type": "error", "msg": "rate limited"}))
        return

    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        await ws.send(json.dumps({"type": "error", "msg": "invalid JSON"}))
        return

    msg_type = data.get("type", "")

    if msg_type == "ping":
        await ws.send(json.dumps({"type": "pong"}))
        return

    if msg_type == "auth":
        # Already handled in _auth_ws, but allow re-auth
        if not REPOCIV_TOKEN:
            await ws.send(json.dumps({"type": "auth_ok"}))
            return
        if _token_matches(data.get("token")):
            await ws.send(json.dumps({"type": "auth_ok"}))
        else:
            await ws.send(json.dumps({"type": "auth_error", "msg": "invalid token"}))
        return

    if msg_type in ("command", "approval", "unit_command"):
        # Forward to bridge command handler
        cb = _command_callback
        if cb:
            try:
                cb(data)
                await ws.send(json.dumps({"type": "ack", "id": data.get("id", "")}))
            except Exception as e:
                await ws.send(json.dumps({"type": "error", "msg": str(e)}))
        else:
            await ws.send(json.dumps({"type": "error", "msg": "command handler not available"}))
        return

    # Health check
    if msg_type == "health":
        await ws.send(json.dumps({
            "type": "health",
            "ok": True,
            "clients": len(_connections),
            "uptime": time.time() - _start_time if "_start_time" in globals() else 0,
        }))
        return

    await ws.send(json.dumps({"type": "error", "msg": f"unknown type: {msg_type}"}))


# ─── Connection handler ───────────────────────────────────────────────────────
_start_time: float = 0.0


async def _ws_handler(ws: websockets.asyncio.server.ServerConnection) -> None:
    """Handle a single WebSocket connection lifecycle."""
    # Auth
    if not await _auth_ws(ws):
        await ws.close(4001, "auth failed")
        return

    await _register(ws)

    # Start heartbeat in background
    heartbeat_task = asyncio.create_task(_heartbeat_loop(ws))

    try:
        async for message in ws:
            await _handle_incoming(ws, message)
    except websockets.exceptions.WebSocketException:
        pass
    finally:
        heartbeat_task.cancel()
        await _unregister(ws)


# ─── Server lifecycle ─────────────────────────────────────────────────────────
_ws_server: websockets.asyncio.server.Server | None = None


async def _run_server(host: str = WS_HOST, port: int = BRIDGE_WS_PORT) -> None:
    """Run the WS server forever."""
    global _loop, _start_time, _ws_server
    _loop = asyncio.get_running_loop()
    _start_time = time.time()

    _ws_server = await websockets.asyncio.server.serve(
        _ws_handler,
        host,
        port,
        ping_interval=None,  # We manage our own heartbeat
        ping_timeout=None,
        max_size=262144,  # 256 KB max message
    )

    print(f"├─ WebSocket:  ws://{host}:{port}                     │")
    logger.info(f"WebSocket server started on ws://{host}:{port}")

    try:
        await asyncio.Future()  # Run forever
    except asyncio.CancelledError:
        pass
    finally:
        _ws_server.close()
        await _ws_server.wait_closed()


def start_ws_server(host: str = WS_HOST, port: int = BRIDGE_WS_PORT) -> threading.Thread:
    """Start the WS server in a daemon thread.

    Called from bridge.py's main block.
    Returns the thread for lifecycle management.
    """
    def _run() -> None:
        try:
            asyncio.run(_run_server(host, port))
        except Exception as e:
            logger.error(f"WS server failed: {e}")

    t = threading.Thread(target=_run, daemon=True, name="ws-server")
    t.start()
    return t


def stop_ws_server() -> None:
    """Stop the running WS server (for test teardown)."""
    global _ws_server, _loop, _connections, _start_time
    # Wait for server to be ready (up to 3s) before trying to stop it
    deadline = time.time() + 3.0
    while _ws_server is None and time.time() < deadline:
        time.sleep(0.05)
    if _loop is not None and _ws_server is not None:
        server, loop = _ws_server, _loop
        try:
            # Server.close() is a plain method, not a coroutine
            loop.call_soon_threadsafe(server.close)
        except RuntimeError:
            pass  # Event loop is closed
        if loop.is_running():
            future = asyncio.run_coroutine_threadsafe(server.wait_closed(), loop)
            try:
                future.result(timeout=3)
            except Exception:
                pass
    _ws_server = None
    _loop = None
    _connections.clear()
    _start_time = 0.0


# ─── Direct sysnc-client support (for tests) ─────────────────────────────────
def create_sync_broadcast(host: str = WS_HOST, port: int = BRIDGE_WS_PORT) -> Callable[[dict[str, Any]], None]:
    """Create a sync broadcast function for testing.

    Returns a callable that takes an event dict and broadcasts it.
    This is a convenience wrapper for tests that don't have access to the
    async event loop.
    """
    # The real broadcast function already handles sync→async scheduling
    return broadcast
