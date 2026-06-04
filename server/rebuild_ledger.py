"""Rebuild DuckDB ledger from canonical events.jsonl."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from server import event_store as _es
from server import research_ledger as _rl


def rebuild(state_dir: Path | None = None) -> int:
    """Replay JSONL events into DuckDB. Returns count of ingested terminal events."""
    if state_dir:
        _es.init(state_dir)
    ledger = _rl.get_ledger()
    if not ledger.available:
        print("DuckDB unavailable — install duckdb", file=sys.stderr)
        return 0

    store = _es._store_path
    if store is None or not store.exists():
        print("No events.jsonl found", file=sys.stderr)
        return 0

    count = 0
    for line in store.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        etype = evt.get("type", "")
        if etype in ("CommandCompleted", "CommandFailed", "CommandRejected", "SubagentCompleted"):
            ledger.ingest_event(evt)
            count += 1
        elif etype == "SubagentSpawned":
            data = evt.get("data") or {}
            ledger.record_subagent_run(data)
            count += 1
    print(f"Rebuilt ledger from {store} — processed {count} events")
    return count


if __name__ == "__main__":
    import os
    state = Path(os.environ.get("REPOCIV_STATE_DIR", str(Path.home() / ".repociv")))
    _es.init(state)
    rebuild(state)
