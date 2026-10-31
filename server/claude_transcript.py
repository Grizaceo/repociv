"""Read prompt and response text from a Claude Code transcript."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

_TAIL_BYTES = 4 * 1024 * 1024
_MAX_TEXT_CHARS = 100_000


def _timestamp(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return int(stamp.timestamp() * 1000)
    except (ValueError, OverflowError, OSError):
        return None


def _message(entry: Any) -> dict[str, Any] | None:
    if not isinstance(entry, dict) or entry.get("isSidechain"):
        return None
    role = entry.get("type")
    if role not in ("user", "assistant") or (role == "user" and entry.get("isMeta")):
        return None
    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if role == "user" and isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "\n".join(
            block["text"] for block in content
            if isinstance(block, dict)
            and block.get("type") == "text"
            and isinstance(block.get("text"), str)
        )
    else:
        return None
    if not text.strip():
        return None
    return {
        "role": role,
        "text": text[:_MAX_TEXT_CHARS],
        "at": _timestamp(entry.get("timestamp")),
        "truncated": len(text) > _MAX_TEXT_CHARS,
        "turn": None,
    }


def read_chat(path: str, *, limit: int) -> dict[str, Any]:
    with open(path, "rb") as stream:
        stream.seek(0, os.SEEK_END)
        offset = max(0, stream.tell() - _TAIL_BYTES)
        stream.seek(offset)
        lines = stream.read(_TAIL_BYTES).decode("utf-8", errors="replace").splitlines()
    if offset:
        lines = lines[1:]
    messages = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = _message(entry)
        if message is not None:
            messages.append(message)
    count = max(0, limit)
    return {
        "messages": messages[-count:] if count else [],
        "hasMore": bool(offset) or len(messages) > count,
        "available": True,
    }
