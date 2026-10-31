"""RepoCiv — A2: pending_tracker must serialize read-modify-write.

The bridge runs on ThreadingHTTPServer: two requests can interleave
read→mutate→write and silently drop each other's item (or leave a
half-written file after a plain Path.write_text). Every mutator must hold a
single process-wide lock and persist through atomic_io.atomic_write_text.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import server.pending_tracker as pt


BASE = (
    "# PENDING TRACKER\n\n"
    "## [ALTA] Pendientes activos\n\n"
    "*(vacío — ninguno)*\n\n"
    "## [MEDIA] Pendientes activos\n\n"
    "*(vacío — ninguno)*\n"
)


def _slow_read_monkeypatch(monkeypatch, delay: float = 0.004) -> None:
    """Stretch the read→write race window.

    Without a lock each concurrent mutator snapshots the same base content,
    so most appends overwrite each other. With the lock the whole
    read-modify-write is serialized and the test passes.
    """
    original = Path.read_text

    def slow_read(self: Path, *args, **kwargs):
        text = original(self, *args, **kwargs)
        if self.name == "PENDING_TRACKER.md":
            time.sleep(delay)
        return text

    monkeypatch.setattr(Path, "read_text", slow_read)


def test_concurrent_appends_are_not_lost(tmp_path, monkeypatch):
    tracker = tmp_path / "PENDING_TRACKER.md"
    tracker.write_text(BASE, encoding="utf-8")
    monkeypatch.setattr(pt, "PENDING_TRACKER", tracker)
    _slow_read_monkeypatch(monkeypatch)

    results: list[str | None] = []

    def worker(i: int) -> None:
        results.append(pt.append_pending_task(f"Tarea concurrente {i}"))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    final = tracker.read_text(encoding="utf-8")
    for i in range(8):
        assert f"Tarea concurrente {i}" in final, f"append {i} lost to a race"
    ids = [r for r in results if r]
    assert len(set(ids)) == len(ids), "two appends claimed the same id"


def test_concurrent_mixed_mutations_leave_parseable_file(tmp_path, monkeypatch):
    tracker = tmp_path / "PENDING_TRACKER.md"
    tracker.write_text(BASE, encoding="utf-8")
    monkeypatch.setattr(pt, "PENDING_TRACKER", tracker)
    _slow_read_monkeypatch(monkeypatch, delay=0.002)

    first = pt.append_pending_task("Item base para resolver")
    assert first is not None

    def worker(i: int) -> None:
        if i % 3 == 0:
            pt.append_pending_task(f"Extra {i}")
        elif i % 3 == 1:
            pt.change_pending_state(first, "🟡")
        else:
            pt.edit_pending_task(first, detail=f"detalle {i}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(9)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # The file must never be truncated or interleaved mid-write: it always
    # parses and the base item is still findable.
    tasks = pt.load_pending_tasks()
    assert isinstance(tasks, list)
    content = tracker.read_text(encoding="utf-8")
    assert "### [" in content
    assert content.count("Item base para resolver") >= 1


def test_write_is_atomic_via_atomic_io():
    import inspect

    src = inspect.getsource(pt)
    assert "atomic_write_text" in src, "mutators must persist via atomic_io"
