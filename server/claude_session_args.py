"""Coordinate Claude thread resumption independently of storage and execution."""

from __future__ import annotations

from typing import Callable


def session_args(
    unit_id: str,
    city: str,
    *,
    stateful: bool,
    session_for: Callable[..., tuple[str, bool]],
    forget_thread: Callable[[str, str], None],
    transcript_path: Callable[[str, str], str | None],
) -> list[str]:
    session_id, resume = session_for(unit_id, city, stateful=stateful)
    if resume and transcript_path("claude-code", session_id) is None:
        # The stored thread's transcript is gone (never written, or deleted).
        forget_thread(unit_id, city)
        session_id, resume = session_for(unit_id, city, stateful=stateful)
    return ["--resume", session_id] if resume else ["--session-id", session_id]
