import json
import time
from pathlib import Path
from typing import Any

_REPOCIV_ROOT = Path(__file__).parent.parent
_DATA_DIR = _REPOCIV_ROOT / "data"
_LOCAL_PENDING = _DATA_DIR / "pending_local.json"

_VALID_STATES = {"🔵", "🟡", "🟢", "🔴"}
_VALID_PRIORITIES = {"ALTA", "MEDIA", "BAJA"}

# IDs are prefixed "L" to distinguish from Hermes items (numeric strings).
_ID_PREFIX = "L"


def _load() -> list[dict[str, Any]]:
    try:
        if _LOCAL_PENDING.exists():
            return json.loads(_LOCAL_PENDING.read_text(encoding="utf-8"))
    except Exception:
        pass
    return []


def _save(items: list[dict[str, Any]]) -> None:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    _LOCAL_PENDING.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def _next_id(items: list[dict[str, Any]]) -> str:
    max_n = 0
    for it in items:
        raw = it.get("id", "")
        if isinstance(raw, str) and raw.startswith(_ID_PREFIX):
            try:
                n = int(raw[len(_ID_PREFIX):])
                if n > max_n:
                    max_n = n
            except ValueError:
                pass
    return f"{_ID_PREFIX}{max_n + 1:03d}"


def load_local_tasks() -> list[dict[str, Any]]:
    items = _load()
    active = [it for it in items if it.get("priority", "MEDIA") in _VALID_PRIORITIES
              and it.get("stateText") not in ("hecho", "descartada")]
    for it in active:
        it["source"] = "local"
    return active


def add_local_task(title: str, priority: str = "MEDIA", detail: str = "") -> str | None:
    title = title.strip()
    if not title:
        return None
    priority = priority.upper()
    if priority not in _VALID_PRIORITIES:
        priority = "MEDIA"
    items = _load()
    new_id = _next_id(items)
    items.append({
        "id": new_id,
        "title": title,
        "priority": priority,
        "state": "🔵",
        "stateText": "registrada",
        "detail": detail.strip(),
        "source": "local",
        "created_at": int(time.time()),
    })
    _save(items)
    return new_id


def resolve_local_task(item_id: str) -> bool:
    items = _load()
    for it in items:
        if it.get("id") == item_id:
            it["state"] = "🟢"
            it["stateText"] = "hecho"
            it["resolved_at"] = int(time.time())
            _save(items)
            return True
    return False


def edit_local_task(item_id: str, title: str | None = None,
                    priority: str | None = None, detail: str | None = None) -> bool:
    items = _load()
    for it in items:
        if it.get("id") == item_id:
            if title is not None and title.strip():
                it["title"] = title.strip()
            if priority is not None:
                p = priority.upper()
                if p in _VALID_PRIORITIES:
                    it["priority"] = p
            if detail is not None:
                it["detail"] = detail
            _save(items)
            return True
    return False


def delete_local_task(item_id: str) -> bool:
    items = _load()
    new_items = [it for it in items if it.get("id") != item_id]
    if len(new_items) == len(items):
        return False
    _save(new_items)
    return True


def change_local_state(item_id: str, new_state: str) -> bool:
    if new_state not in _VALID_STATES:
        return False
    state_labels = {"🔵": "registrada", "🟡": "en progreso", "🟢": "operativo", "🔴": "descartada"}
    items = _load()
    for it in items:
        if it.get("id") == item_id:
            it["state"] = new_state
            it["stateText"] = state_labels.get(new_state, new_state)
            _save(items)
            return True
    return False


def is_local_id(item_id: str) -> bool:
    return isinstance(item_id, str) and item_id.startswith(_ID_PREFIX)
