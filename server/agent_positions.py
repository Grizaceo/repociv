"""Native CLI position hints, merged into the existing external-session tracker.

Only selected repo references enter the store; raw cwd, tool arguments and caller
supplied city/unit IDs are never retained. Hooks cannot create an executable
transport or grant permission to send messages. An unavailable hook leaves the
existing read-only sources and their placement heuristic untouched.
"""
from __future__ import annotations

import os
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from server.suvadu_tracker import Observation

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_EVENTS = frozenset({"session_start", "turn_start", "tool_use", "turn_end", "session_end", "position"})
_ALIASES = {"claude": "claude", "claude-code": "claude", "codex": "codex",
            "openai-codex": "codex", "hermes": "hermes",
            "devin": "devin", "mcode": "mcode", "minimax": "mcode",
            "opencode": "opencode"}


class InvalidPosition(ValueError):
    """Caller metadata is malformed, distinct from registry/service errors."""


@dataclass(frozen=True)
class _Position:
    cli: str
    native: str
    profile: str
    city: str
    repo: str
    received_ms: int
    first_ms: int
    event: str
    authority: str


class PositionStore:
    """Bounded in-memory hints. After a restart the next hook refreshes them."""

    def __init__(self, *, ttl_ms: int = 600_000, capacity: int = 1024) -> None:
        self.ttl_ms = ttl_ms
        self.capacity = capacity
        self._lock = threading.Lock()
        self._positions: OrderedDict[tuple[str, str, str], _Position] = OrderedDict()

    def ingest(self, body: Any, repo_paths: list[str], now_ms: int) -> dict[str, Any]:
        from server import suvadu_tracker as st

        if not isinstance(body, dict):
            raise InvalidPosition("invalid_position")
        cli = _ALIASES.get(body.get("cli")) if isinstance(body.get("cli"), str) else None
        native, event, cwd = body.get("session_id"), body.get("event"), body.get("cwd")
        profile = body.get("profile", "default") if cli == "hermes" else ""
        if cli == "hermes" and profile == "":
            profile = "default"
        if (not cli or not isinstance(native, str) or not _ID.fullmatch(native)
                or not isinstance(event, str) or event not in _EVENTS
                or not isinstance(profile, str) or not _ID.fullmatch(profile or "default")
                or not isinstance(cwd, str) or len(cwd) > 4096 or "\x00" in cwd
                or not os.path.isabs(cwd)):
            raise InvalidPosition("invalid_position")
        candidates = st.city_candidates(repo_paths)
        canonical = st._canonical(cwd)
        if not os.path.isdir(canonical):
            canonical = os.path.dirname(canonical)
        location = st._selected_city(canonical, candidates)
        authority = "tool" if body.get("authority") == "tool" else "cwd"
        key = cli, profile, native
        with self._lock:
            prev = self._positions.get(key)
            if prev and not 0 <= now_ms - prev.received_ms <= self.ttl_ms:
                prev = None
            if location is None:
                if (prev and now_ms - prev.received_ms <= self.ttl_ms
                        and event in {"turn_start", "turn_end", "session_end"}):
                    location = prev.city, prev.repo
                else:
                    return {"accepted": False, "reason": "unmapped"}
            # CLI launch cwd on Stop/UserPromptSubmit is NOT a new work location.
            # A concrete tool path must survive those lifecycle heartbeats.
            if (prev and now_ms - prev.received_ms <= self.ttl_ms and prev.authority == "tool"
                    and authority != "tool" and event != "session_start"):
                location = prev.city, prev.repo
                authority = prev.authority
            changed = prev is None or (prev.city, prev.event == "session_end") != (
                location[0], event == "session_end")
            position = _Position(cli, native, profile, *location, now_ms,
                                 prev.first_ms if prev else now_ms, event, authority)
            self._positions[key] = position
            self._positions.move_to_end(key)
            while len(self._positions) > self.capacity:
                self._positions.popitem(last=False)
        return {"accepted": True, "changed": changed, "cli": cli, "session_id": native,
                "profile": profile, "event": event, "cityId": position.city, "repo": position.repo}

    def overlay(self, observations: list[Observation], now_ms: int,
                *, owned_ids: set[str] | frozenset[str] = frozenset()) -> list[Observation]:
        with self._lock:
            positions = {k: p for k, p in self._positions.items()
                         if 0 <= now_ms - p.received_ms <= self.ttl_ms}
        rows: list[Observation] = []
        for obs in observations:
            cli = _ALIASES.get(obs.agent)
            key = (cli or "", obs.profile or "default" if cli == "hermes" else "", obs.native_id)
            keys = [key]
            # Suvadu may report its prefixed source ID as native_id. Derive an
            # additional matching key from the documented source namespace,
            # without rewriting any session/native/unit identifier.
            prefix = f"{cli}-"
            if obs.source == "suvadu" and obs.native_id == obs.session_id and obs.session_id.startswith(prefix):
                keys.append((cli, key[1], obs.session_id[len(prefix):]))
            current_natives = {k[2] for k in keys}
            if cli == "hermes":
                keys.extend((cli, key[1], native) for native in obs.related_native_ids)
            hints = [positions[k] for k in keys if k in positions]
            # Launch cwd on a compression child cannot erase its ancestor's
            # concrete workdir. A new explicit tool path supersedes it.
            pos = max(hints, key=lambda p: (p.authority == "tool" if cli == "hermes" else False,
                                            p.received_ms)) if hints else None
            if pos and not any(k[2] in owned_ids for k in keys):
                obs = replace(obs, last_activity_ms=max(obs.last_activity_ms, pos.received_ms),
                              ended=(pos.event == "session_end" if pos.native in current_natives and pos.received_ms >= obs.last_activity_ms else obs.ended),
                              position_city_id=pos.city, position_repo=pos.repo,
                              position_at_ms=pos.received_ms)
            rows.append(obs)
        # A hook supplies location, never identity or proof of a live process.
        # Cache early hints until an existing source verifies the session. This
        # avoids synthetic spawn/despawn transitions and fabricated counters.
        return rows

    def location(self, obs: Observation, repo_paths: list[str], now_ms: int) -> tuple[str, str] | None:
        from server import suvadu_tracker as st

        if not obs.position_city_id or not 0 <= now_ms - obs.position_at_ms <= self.ttl_ms:
            return None
        valid_ids = {st.CAPITAL_ID if is_home else st.encode_repo_id(path)
                     for _, path, is_home in st.city_candidates(repo_paths)}
        return (obs.position_city_id, obs.position_repo) if obs.position_city_id in valid_ids else None


def _record_change(result: dict[str, Any]) -> None:
    """Durable trail of city changes only: never the cwd or tool arguments.

    commandId stays empty. A native session ID is not a RepoCiv command, and the
    activity panel groups rows into runs by commandId.
    """
    if not (result.get("accepted") and result.get("changed")):
        return
    try:
        from server import event_store

        event_store.record_event(f"AgentPosition:{result['event']}", {
            "cli": result["cli"], "profile": result["profile"],
            "sessionId": result["session_id"], "cityId": result["cityId"]})
    except Exception:
        pass  # A failed append must not turn an accepted hint into a failed hook.


def post_agent_events(body: Any, _ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Auth/body/rate-limit guards are the existing BridgeHandler's responsibility."""
    from server import suvadu_tracker as st

    if st._tracker is None:
        return 503, {"error": "tracker_not_running"}
    try:
        result = st._tracker.ingest_position(body)
    except InvalidPosition:
        return 400, {"error": "invalid_position"}
    except Exception:
        return 503, {"error": "position_unavailable"}
    _record_change(result)
    return 200, result
