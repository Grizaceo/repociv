"""Consume OpenCode NDJSON independently of process lifecycle and final status."""

from collections.abc import Callable, Iterable
from typing import Any


def consume_lines(
    lines: Iterable[str], unit_id: str, mission_id: str, *,
    loads: Callable[[str], Any],
    send_to_repociv: Callable[[dict[str, Any]], Any],
    record_output_chunk: Callable[[str, str, str], Any],
) -> tuple[list[str], list[str], list[str], int]:
    text_parts: list[str] = []
    errors: list[str] = []
    stray: list[str] = []
    tools_used = 0
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            event = loads(stripped)
        except ValueError:
            if len(stray) < 20:
                stray.append(stripped)
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        part = event.get("part")
        if kind == "text" and isinstance(part, dict):
            chunk = part.get("text")
            if isinstance(chunk, str) and chunk:
                text_parts.append(chunk)
                text = chunk if chunk.endswith("\n") else f"{chunk}\n"
                send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
                record_output_chunk(mission_id, unit_id, text)
        elif kind == "tool_use" and isinstance(part, dict):
            tools_used += 1
            tool = part.get("tool")
            if isinstance(tool, str) and tool:
                text = f"🔧 {tool}\n"
                send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
                record_output_chunk(mission_id, unit_id, text)
        elif kind == "error":
            err = event.get("error")
            message = err.get("message") if isinstance(err, dict) else None
            errors.append(str(message or "unknown"))
    return text_parts, errors, stray, tools_used
