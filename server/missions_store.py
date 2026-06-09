from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

_MISSIONS_FILE: Path | None = None
_missions_lock = threading.Lock()


def init(config_dir: Path) -> Path:
    global _MISSIONS_FILE
    _MISSIONS_FILE = Path(config_dir) / 'missions.json'
    return _MISSIONS_FILE


def get_missions_file() -> Path:
    if _MISSIONS_FILE is None:
        raise RuntimeError('missions_store not initialized')
    return _MISSIONS_FILE


def load_missions() -> list[dict[str, Any]]:
    missions_file = get_missions_file()
    if not missions_file.exists():
        return []
    try:
        return json.loads(missions_file.read_text())
    except Exception:
        return []


def save_mission(mission: dict[str, Any]) -> None:
    missions_file = get_missions_file()
    with _missions_lock:
        missions = load_missions()
        for i, existing in enumerate(missions):
            if existing.get('id') == mission.get('id'):
                missions[i] = mission
                break
        else:
            missions.append(mission)
        missions = missions[-200:]
        missions_file.write_text(json.dumps(missions, indent=2, ensure_ascii=False))
