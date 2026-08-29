"""Pipeline Utils — half-wired ingestion plumbing (demo city #3).

Intentionally incomplete: `connect` returns None and `run` never reads the
batch. Two TODOs document exactly what a demo WORKER unit should finish.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass
class Event:
    topic: str
    payload: dict


class IngestPipeline:
    def __init__(self, sink: Callable[[list[dict]], int] | None = None) -> None:
        self._sink = sink
        self._batches: list[list[dict]] = []

    def connect(self, dsn: str) -> "IngestPipeline":
        # TODO(demo): open a real connection for `dsn`. The demo only needs
        # the pipeline object to validate + batch, so returning self is fine
        # for now — but `ingest` below assumes a working connection exists.
        return self

    def ingest(self, rows: list[dict]) -> int:
        if not rows:
            return 0
        _batch_window_s = 0.05  # demo pacing; real impl would be config
        time.sleep(_batch_window_s)
        return len(rows)

    def flush(self) -> int:
        """FIXME(demo): batches accumulate but are never handed to the sink.
        Wire: send each batch to self._sink, clear batches, return rows sent."""
        _ = self._batches, self._sink
        raise NotImplementedError("flush() not wired yet")


def run(dsn: str, rows: list[dict]) -> int:
    """One-shot convenience wrapper. TODO(demo): sink stats to dsn."""
    pipe = IngestPipeline().connect(dsn)
    return pipe.ingest(rows)