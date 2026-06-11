from __future__ import annotations

import threading
from typing import Any

DEFAULT_FATIGUE = {
    'fatigue': 100,
    'effectiveSpeed': 1.0,
    'isResting': False,
    'restAreaId': None,
}

_fatigue_state: dict[str, dict[str, Any]] = {}
_rest_areas: dict[str, dict[str, Any]] = {}
_fatigue_lock = threading.Lock()


def get_unit_fatigue(unit_id: str) -> dict[str, Any]:
    with _fatigue_lock:
        return _fatigue_state.get(unit_id, dict(DEFAULT_FATIGUE))


def update_unit_fatigue(
    unit_id: str,
    *,
    fatigue: int | None = None,
    effective_speed: float | None = None,
    is_resting: bool | None = None,
    rest_area_id: str | None = None,
    delta: int = 0,
) -> dict[str, Any]:
    with _fatigue_lock:
        entry = _fatigue_state.setdefault(unit_id, dict(DEFAULT_FATIGUE))
        if fatigue is not None:
            entry['fatigue'] = max(0, min(100, fatigue))
        elif delta:
            entry['fatigue'] = max(0, min(100, entry['fatigue'] + delta))
        if effective_speed is not None:
            entry['effectiveSpeed'] = effective_speed
        if is_resting is not None:
            entry['isResting'] = is_resting
        if rest_area_id is not None:
            entry['restAreaId'] = rest_area_id
        entry['effectiveSpeed'] = round(entry['fatigue'] / 100.0, 3)
        return dict(entry)


def discover_rest_area(
    rest_area_id: str,
    room_id: str,
    coord: tuple,
    recovery_rate: float = 8.0,
    capacity: int = 4,
) -> dict[str, Any]:
    with _fatigue_lock:
        if room_id == 'kiosk' or room_id.startswith('kiosk') or rest_area_id.startswith('kiosk'):
            recovery_rate = recovery_rate * 1.25

        area = {
            'id': rest_area_id,
            'roomId': room_id,
            'coord': list(coord),
            'recoveryRate': recovery_rate,
            'capacity': capacity,
            'unitsInside': [],
        }
        _rest_areas[rest_area_id] = area
        return dict(area)


def enter_rest_area(unit_id: str, rest_area_id: str) -> bool:
    with _fatigue_lock:
        area = _rest_areas.get(rest_area_id)
        if not area or len(area['unitsInside']) >= area['capacity']:
            return False
        if unit_id not in area['unitsInside']:
            area['unitsInside'].append(unit_id)
        entry = _fatigue_state.setdefault(unit_id, dict(DEFAULT_FATIGUE))
        entry['isResting'] = True
        entry['restAreaId'] = rest_area_id
        return True


def exit_rest_area(unit_id: str) -> None:
    with _fatigue_lock:
        entry = _fatigue_state.get(unit_id, {})
        ra_id = entry.get('restAreaId')
        if ra_id and ra_id in _rest_areas:
            try:
                _rest_areas[ra_id]['unitsInside'].remove(unit_id)
            except ValueError:
                pass
        entry['isResting'] = False
        entry['restAreaId'] = None
        _fatigue_state[unit_id] = entry
