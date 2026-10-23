"""Pure output parsing for CLI harnesses, independent of agent execution.

Keep protocol interpretation separate from subprocesses, sessions and event
recording. Legacy fallbacks are preserved; parsing does not repair payloads.
"""
from __future__ import annotations

import json
import re


def parse_cursor_ndjson_chunk(line: str) -> str:
    """Extract human-readable text from a cursor-agent NDJSON output line.

    cursor-agent --output-format stream-json emits newline-delimited JSON.
    Known shapes (verified against cursor-agent --print --output-format stream-json):
      {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
      {"type": "text", "text": "..."}
      {"type": "tool_use", ...}  — skip, not human-readable output
    Falls back to the raw line if it is not valid JSON or has no text content.
    """
    line = line.strip()
    if not line:
        return ""
    try:
        data = json.loads(line)
        event_type = data.get("type", "")
        # Tool-use events are noise — don't surface them as chat text
        if event_type in ("tool_use", "tool_result", "ping", "heartbeat"):
            return ""
        # text shorthand
        if event_type == "text":
            return data.get("text", "")
        # assistant message with content array
        if event_type == "assistant":
            content = data.get("message", {}).get("content", "")
            if isinstance(content, list):
                return "".join(
                    c.get("text", "") for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                )
            return str(content) if content else ""
        # result / final output
        if event_type in ("result", "final_output"):
            return data.get("output", data.get("text", ""))
        return ""
    except (json.JSONDecodeError, AttributeError, TypeError):
        return line


def extract_hermes_session_id(output: str) -> str:
    """hermes chat -Q prints `session_id: <id>` at the end of a run."""
    m = re.search(r"session_id:\s*([A-Za-z0-9_]+)", output)
    return m.group(1) if m else ""
