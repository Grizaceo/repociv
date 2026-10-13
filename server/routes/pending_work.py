"""HTTP surface for the pending Git work inventory.

``GET /api/pending-work`` is a read-only local Git inventory: it takes no path
from the request, never mutates the user's repositories, and reports failures as
``unavailable`` instead of pretending a worktree is clean. The heavy lifting
lives in ``server.pending_work``; this module only adapts it to the bridge's
handler contract.
"""
from __future__ import annotations

import logging
from typing import Any

_log = logging.getLogger(__name__)


def get_pending_work(ctx: Any = None) -> tuple[int, dict[str, Any]]:
    """GET /api/pending-work — uncommitted work across selected repos/worktrees."""
    from server import pending_work  # noqa: PLC0415

    try:
        return 200, pending_work.collect()
    except Exception as exc:  # noqa: BLE001 - the panel must still get a shape
        _log.exception("pending-work inventory failed")
        return 200, {
            "available": False,
            "sampledAtMs": 0,
            "entries": [],
            "errors": [f"pending-work inventory failed: {exc}"],
        }
