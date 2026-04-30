"""RepoCiv — Directive Record Store (Fase 9).

Append-only JSONL store. Two record types:
  gesture  — emitted when a spatial gesture fires a command
  outcome  — emitted when the command completes or fails

The learner correlates them by command_id to compute patterns.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

_lock = threading.Lock()
_records_path: Path | None = None


def init(config_dir: Path) -> None:
    global _records_path
    _records_path = config_dir / "directive_records.jsonl"
    _records_path.touch(exist_ok=True)


def _append(record: dict[str, Any]) -> None:
    if _records_path is None:
        return
    with _lock:
        with _records_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


def record_gesture(
    command_id: str,
    gesture: str,
    agent_id: str,
    cmd_type: str,
    target: str,
    context: dict[str, Any] | None = None,
) -> None:
    record: dict[str, Any] = {
        "type":       "gesture",
        "command_id": command_id,
        "gesture":    gesture,
        "agent_id":   agent_id,
        "cmd_type":   cmd_type,
        "target":     target,
        "ts":         time.time(),
    }
    if context:
        record["context"] = context
    _append(record)


def record_outcome(
    command_id: str,
    outcome: str,       # 'success' | 'failure' | 'cancelled'
    duration_s: float = 0.0,
) -> None:
    _append({
        "type":       "outcome",
        "command_id": command_id,
        "outcome":    outcome,
        "duration_s": round(duration_s, 2),
        "ts":         time.time(),
    })


def read_records(limit: int = 2000) -> list[dict[str, Any]]:
    if _records_path is None or not _records_path.exists():
        return []
    with _lock:
        lines = _records_path.read_text(encoding="utf-8").splitlines()
    records: list[dict[str, Any]] = []
    for line in lines[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records
