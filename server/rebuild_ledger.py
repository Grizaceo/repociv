"""RepoCiv \u2014 Rebuild the DuckDB Ledger from the JSONL Event Store.

The Ledger is a *materialised view* of ``events.jsonl`` (see
``docs/DATA_SOURCES.md``). The Event Store is the canonical audit trail; the
Ledger is just a fast SQL surface over it. If DuckDB is corrupted, deleted,
or diverges, this script reconstructs it from scratch, idempotently.

Usage::

    # Default paths (~/.repociv/events.jsonl \u2192 ~/.repociv/ledger.duckdb)
    python -m server.rebuild_ledger

    # Custom paths (useful for tests, CI, or restoring a backup)
    python -m server.rebuild_ledger \\
        --events-path /tmp/events.jsonl \\
        --state-dir   /tmp/repociv-state

    # Dry-run: count terminal events without writing
    python -m server.rebuild_ledger --dry-run

The script is **idempotent**: ``research_ledger.record_cycle`` uses
``INSERT OR REPLACE``. Re-running on the same JSONL produces the same Ledger.

Exit codes:
  0 \u2014 rebuild completed (or dry-run finished)
  1 \u2014 events file missing
  2 \u2014 DuckDB unavailable (install ``duckdb``)
  3 \u2014 unexpected error
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Iterator


logger = logging.getLogger("rebuild_ledger")


_TERMINAL_EVENT_TYPES = frozenset({
    "CommandCompleted",
    "CommandFailed",
    "CommandRejected",
})


def _iter_events(events_path: Path) -> Iterator[dict]:
    """Yield each JSON event from the JSONL file, skipping malformed lines."""
    with events_path.open("r", encoding="utf-8") as f:
        for lineno, raw in enumerate(f, start=1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                yield json.loads(raw)
            except json.JSONDecodeError as exc:
                logger.warning(
                    "rebuild_ledger: skipping malformed line %d: %s", lineno, exc
                )


def rebuild(
    events_path: Path,
    state_dir: Path,
    *,
    dry_run: bool = False,
) -> dict:
    """Replay terminal events into the Ledger. Returns a summary dict."""
    if not events_path.exists():
        raise FileNotFoundError(f"events file not found: {events_path}")

    summary: dict = {
        "events_total": 0,
        "events_terminal": 0,
        "events_ingested": 0,
        "events_skipped": 0,
        "by_type": {"CommandCompleted": 0, "CommandFailed": 0, "CommandRejected": 0},
    }

    if dry_run:
        for event in _iter_events(events_path):
            summary["events_total"] += 1
            etype = event.get("type", "")
            if etype in _TERMINAL_EVENT_TYPES:
                summary["events_terminal"] += 1
                summary["by_type"][etype] += 1
        return summary

    # Lazy import so --dry-run works even if duckdb is missing.
    try:
        from server.research_ledger import ResearchLedger
    except ImportError as exc:  # pragma: no cover \u2014 surfaced via exit code
        raise RuntimeError(
            "duckdb not installed; cannot rebuild ledger. "
            "Install with `pip install duckdb` and retry."
        ) from exc

    ledger = ResearchLedger(state_dir=state_dir)
    if not ledger.available:
        raise RuntimeError(
            f"ResearchLedger could not open {state_dir}/ledger.duckdb. "
            "Check permissions or whether another process holds the lock."
        )

    for event in _iter_events(events_path):
        summary["events_total"] += 1
        etype = event.get("type", "")
        if etype not in _TERMINAL_EVENT_TYPES:
            continue
        summary["events_terminal"] += 1
        summary["by_type"][etype] += 1
        try:
            ledger.ingest_event(event)
            summary["events_ingested"] += 1
        except Exception as exc:  # pragma: no cover \u2014 best-effort
            summary["events_skipped"] += 1
            logger.warning("rebuild_ledger: ingest failed (%s): %s", etype, exc)

    ledger.close()
    return summary


def _default_state_dir() -> Path:
    cfg = os.environ.get("REPOCIV_CONFIG_DIR") or "~/.repociv"
    return Path(os.path.expanduser(cfg))


def _default_events_path() -> Path:
    return _default_state_dir() / "events.jsonl"


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m server.rebuild_ledger",
        description=(
            "Reconstruct the DuckDB Ledger from the JSONL Event Store. "
            "Idempotent. Safe to run repeatedly."
        ),
    )
    p.add_argument(
        "--events-path",
        type=Path,
        default=None,
        help="Path to events.jsonl (default: $REPOCIV_CONFIG_DIR/events.jsonl)",
    )
    p.add_argument(
        "--state-dir",
        type=Path,
        default=None,
        help="State directory containing ledger.duckdb (default: $REPOCIV_CONFIG_DIR)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Count terminal events without writing to DuckDB.",
    )
    p.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Log every ingested event.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    events_path = args.events_path or _default_events_path()
    state_dir = args.state_dir or _default_state_dir()

    try:
        summary = rebuild(events_path, state_dir, dry_run=args.dry_run)
    except FileNotFoundError as exc:
        logger.error("%s", exc)
        return 1
    except RuntimeError as exc:
        logger.error("%s", exc)
        return 2
    except Exception as exc:  # pragma: no cover \u2014 unexpected
        logger.exception("rebuild_ledger crashed: %s", exc)
        return 3

    mode = "dry-run" if args.dry_run else "rebuild"
    logger.info(
        "%s done: total=%d terminal=%d ingested=%d skipped=%d  "
        "(completed=%d failed=%d rejected=%d)",
        mode,
        summary["events_total"],
        summary["events_terminal"],
        summary["events_ingested"],
        summary["events_skipped"],
        summary["by_type"]["CommandCompleted"],
        summary["by_type"]["CommandFailed"],
        summary["by_type"]["CommandRejected"],
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
