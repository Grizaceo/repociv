"""Route handler modules split from server.http_routes (Phase 4)."""
from typing import Any


def _error(status: int, error: str, cause: str = "", hint: str = "") -> tuple[int, dict[str, Any]]:
    """Return a structured error envelope: {error, cause, hint}."""
    return status, {"error": error, "cause": cause, "hint": hint}
