"""RepoCiv — shared .env loader.

Lives in its own module so callers (server.bridge, server.mcp_server)
can import it without pulling in the bridge HTTP server or the MCP
stdio transport as a side effect. Both modules load:

  1. The repo's own .env  (repociv/.env)
  2. ~/.hermes/.env        (Hermes-wide provider keys, etc.)

Existing keys in os.environ are never overwritten — local shell wins.
Lines that are blank, comment-only, or lack '=' are ignored. Values
may be wrapped in single or double quotes; both are stripped.
Errors reading a file are swallowed (best-effort loader).
"""
from __future__ import annotations

import os
from pathlib import Path


_PATHS = (
    Path(__file__).parent.parent / ".env",
    Path.home() / ".hermes" / ".env",
)


def load_dotenv() -> None:
    """Load RepoCiv + Hermes .env into os.environ, best-effort."""
    for path in _PATHS:
        try:
            for raw in path.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
        except (FileNotFoundError, OSError):
            continue
