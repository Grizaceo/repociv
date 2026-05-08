"""Tests for the PENDING_TRACKER parser and pending endpoints (Fase F)."""
from __future__ import annotations

import json
import tempfile
import os
from pathlib import Path
from unittest.mock import patch

import pytest


# ─── Fixtures ─────────────────────────────────────────────────────────────────

SAMPLE_TRACKER = """\
# PENDING TRACKER — DAVI + Cristóbal

Última revisión: 2026-05-06

---

## [ALTA] Pendientes activos

### [022] AGENTIC_RIEMANN_TROPICAL — Híbrido NIM + OpenRouter
**Estado:** 🔵 registrada (plan definido, ejecución pendiente)
**Detalle:**
- Migración Ollama→NIM completada.
- Problema: rate limit agresivo.
- Plan: migrar falsifier a OpenRouter.
**Siguiente paso:** Verificar OPENROUTER_API_KEY.

---

## [MEDIA] Pendientes activos

### [010] DREAM CYCLE — Motor de higiene y consolidación de memoria
**Estado:** 🟡 en progreso (mantenimiento 2026-05-07)
**Detalle:**
- Scripts: dream_compress.py, dream_hygiene.py.
- Lock protocol funcional.
- Hindsight bug RESUELTO.
  - Thresholds ajustados.
**Ubicación:** ~/.hermes/scripts/

### [012] PROTEIN LAB — Estado actual del LAB
**Estado:** operativo (parcialmente en cloud)
**Detalle:**
- Directorio operativo: ~/.hermes/workspace/protein-lab/
- Pipeline cloud: RFdiffusion → ProteinMPNN → AF2.
- Sin repo git (NO_GIT).

---

## [BAJA] Pendientes activos

*(vacío — ninguno)*

---

## [STALE] Items en observación

### [007] Dependencia rota: shared/lib/logger.py
**Estado:** 🟡 en progreso (observación)
**Detalle:**
- Subagente researcher falla importando logger.py.

---

## HECHO (eliminados de lista activa)

| ID | Título | Fecha cierre | Notas |
|----|--------|-------------|-------|
| [001] | Telegram Hermes | 2026-04-28 | Token en config.yaml. |
"""


@pytest.fixture
def tmp_tracker(tmp_path):
    """Create a temporary PENDING_TRACKER.md with sample content."""
    tracker = tmp_path / "PENDING_TRACKER.md"
    tracker.write_text(SAMPLE_TRACKER, encoding="utf-8")
    return tracker


@pytest.fixture
def empty_tracker(tmp_path):
    """Create an empty PENDING_TRACKER.md."""
    tracker = tmp_path / "PENDING_TRACKER.md"
    tracker.write_text("", encoding="utf-8")
    return tracker


# Import the functions under test
# Need to adjust path to find server.bridge
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))


# ─── Parser tests ─────────────────────────────────────────────────────────────

class TestLoadPendingTasks:
    def _import(self, tracker_path):
        from server.bridge import load_pending_tasks, PENDING_TRACKER
        with patch("server.bridge.PENDING_TRACKER", tracker_path):
            return load_pending_tasks()

    def test_returns_items_from_active_sections(self, tmp_tracker):
        tasks = self._import(tmp_tracker)
        # Should return items from ALTA, MEDIA but NOT STALE or HECHO
        ids = [t["id"] for t in tasks]
        assert "022" in ids  # ALTA
        assert "010" in ids  # MEDIA
        assert "012" in ids  # MEDIA
        assert "007" not in ids  # STALE excluded

    def test_item_has_required_fields(self, tmp_tracker):
        tasks = self._import(tmp_tracker)
        for t in tasks:
            assert "id" in t
            assert "title" in t
            assert "priority" in t
            assert "state" in t
            assert "detail" in t

    def test_alta_item(self, tmp_tracker):
        tasks = self._import(tmp_tracker)
        alta = [t for t in tasks if t["id"] == "022"][0]
        assert alta["priority"] == "ALTA"
        assert "AGENTIC_RIEMANN_TROPICAL" in alta["title"]
        assert "🔵" in alta["state"]
        assert "rate limit" in alta["detail"].lower() or "rate limit" in alta["detail"]

    def test_media_items(self, tmp_tracker):
        tasks = self._import(tmp_tracker)
        media = [t for t in tasks if t["priority"] == "MEDIA"]
        assert len(media) == 2

    def test_empty_tracker(self, empty_tracker):
        tasks = self._import(empty_tracker)
        assert tasks == []

    def test_nonexistent_tracker(self, tmp_path):
        tasks = self._import(tmp_path / "nonexistent.md")
        assert tasks == []

    def test_state_emoji_extracted(self, tmp_tracker):
        tasks = self._import(tmp_tracker)
        dream = [t for t in tasks if t["id"] == "010"][0]
        assert "🟡" in dream["state"]

    def test_detail_multiline(self, tmp_tracker):
        tasks = self._import(tmp_tracker)
        dream = [t for t in tasks if t["id"] == "010"][0]
        # Detail should contain multiple lines
        assert "\n" in dream["detail"]
        assert "dream_compress" in dream["detail"] or "Scripts" in dream["detail"]


# ─── Append tests ─────────────────────────────────────────────────────────────

class TestAppendPendingTask:
    def _import(self):
        from server.bridge import append_pending_task, PENDING_TRACKER
        return append_pending_task, PENDING_TRACKER

    def test_add_item_creates_valid_entry(self, tmp_tracker):
        append_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            new_id = append_fn("Nuevo pendiente de prueba", "ALTA")
        assert new_id is not None
        content = tmp_tracker.read_text(encoding="utf-8")
        assert "Nuevo pendiente de prueba" in content
        assert "🔵 registrada" in content

    def test_add_item_increments_id(self, tmp_tracker):
        append_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            new_id = append_fn("Otro item", "MEDIA")
        # Max existing ID is 022, so next should be 023
        assert new_id == "023"

    def test_duplicate_title_rejected(self, tmp_tracker):
        append_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            result = append_fn("DREAM CYCLE", "MEDIA")
        assert result is None

    def test_empty_title_rejected(self, tmp_tracker):
        append_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            result = append_fn("", "MEDIA")
        assert result is None

    def test_default_priority_is_media(self, tmp_tracker):
        append_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            new_id = append_fn("Test default priority")
        assert new_id is not None
        content = tmp_tracker.read_text(encoding="utf-8")
        # Should appear in the file
        assert "Test default priority" in content
        # Should have the MEDIA section header before it
        media_pos = content.index("## [MEDIA]")
        test_pos = content.index("Test default priority")
        assert media_pos < test_pos
        # Should NOT appear in HECHO section
        if "## HECHO" in content:
            hecho_pos = content.index("## HECHO")
            assert test_pos < hecho_pos


# ─── Resolve tests ────────────────────────────────────────────────────────────

class TestResolvePendingTask:
    def _import(self):
        from server.bridge import resolve_pending_task, PENDING_TRACKER
        return resolve_pending_task, PENDING_TRACKER

    def test_resolve_moves_to_hecho(self, tmp_tracker):
        resolve_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = resolve_fn("010")
        assert ok is True
        content = tmp_tracker.read_text(encoding="utf-8")
        # Should be in HECHO table
        assert "DREAM CYCLE" in content.split("## HECHO")[1]
        # Should not be in MEDIA section
        media_section = content.split("## [MEDIA]")[1].split("## [BAJA]")[0]
        assert "010" not in media_section

    def test_resolve_nonexistent_returns_false(self, tmp_tracker):
        resolve_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = resolve_fn("999")
        assert ok is False

    def test_resolve_preserves_other_items(self, tmp_tracker):
        resolve_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            resolve_fn("010")
        content = tmp_tracker.read_text(encoding="utf-8")
        # 012 should still be in MEDIA
        assert "012" in content
        assert "PROTEIN LAB" in content

    def test_resolve_to_empty_tracker(self, empty_tracker):
        resolve_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", empty_tracker):
            ok = resolve_fn("001")
        assert ok is False


# ─── Endpoint tests ───────────────────────────────────────────────────────────

class TestPendingEndpoints:
    """Test the HTTP handler for /pending endpoints."""

    def _make_handler(self, tracker_path):
        """Create a BridgeHandler with mocked tracker path."""
        with patch("server.bridge.PENDING_TRACKER", tracker_path):
            from server.bridge import BridgeHandler
            return BridgeHandler

    def _do_get(self, path):
        """Simulate a GET request and return (status, json_body)."""
        from server.bridge import ThreadingHTTPServer, BridgeHandler
        import threading
        import urllib.request

        server = ThreadingHTTPServer(("localhost", 0), BridgeHandler)
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        try:
            req = urllib.request.Request(
                f"http://localhost:{port}{path}",
                headers={"X-RepoCiv-Token": "CPLZlthUBzy1T7TBKYWqGvYDNMbWcP4x0N0rkb9XPbc"},
            )
            try:
                resp = urllib.request.urlopen(req, timeout=3)
                return resp.status, json.loads(resp.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())
        finally:
            server.shutdown()

    def _do_post(self, path, body):
        """Simulate a POST request and return (status, json_body)."""
        from server.bridge import ThreadingHTTPServer, BridgeHandler
        import threading
        import urllib.request

        server = ThreadingHTTPServer(("localhost", 0), BridgeHandler)
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        try:
            data = json.dumps(body).encode()
            req = urllib.request.Request(
                f"http://localhost:{port}{path}",
                data=data,
                headers={
                    "Content-Type": "application/json",
                    "X-RepoCiv-Token": "CPLZlthUBzy1T7TBKYWqGvYDNMbWcP4x0N0rkb9XPbc",
                },
                method="POST",
            )
            try:
                resp = urllib.request.urlopen(req, timeout=3)
                return resp.status, json.loads(resp.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())
        finally:
            server.shutdown()

    def test_get_pending_returns_list(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_get("/pending")
        assert status == 200
        assert isinstance(body, list)
        assert len(body) >= 3

    def test_post_add_returns_id(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/add", {
                "title": "Test endpoint add",
                "priority": "BAJA",
            })
        assert status == 200
        assert "id" in body
        assert body["title"] == "Test endpoint add"

    def test_post_add_requires_title(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/add", {"priority": "ALTA"})
        assert status == 400

    def test_post_resolve_returns_ok(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/resolve", {"id": "022"})
        assert status == 200
        assert body["ok"] is True

    def test_post_resolve_requires_id(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/resolve", {})
        assert status == 400

    def test_post_resolve_nonexistent_returns_404(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/resolve", {"id": "999"})
        assert status == 404


# ─── Edit tests ─────────────────────────────────────────────────────────────

class TestEditPendingTask:
    def _import(self):
        from server.bridge import edit_pending_task, PENDING_TRACKER
        return edit_pending_task, PENDING_TRACKER

    def test_edit_title(self, tmp_tracker):
        edit_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = edit_fn("010", title="DREAM CYCLE v2")
        assert ok is True
        content = tmp_tracker.read_text(encoding="utf-8")
        assert "DREAM CYCLE v2" in content
        assert "DREAM CYCLE — Motor" not in content

    def test_edit_priority_moves_section(self, tmp_tracker):
        edit_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = edit_fn("010", priority="ALTA")
        assert ok is True
        content = tmp_tracker.read_text(encoding="utf-8")
        # Should now be in ALTA section
        alta_section = content.split("## [ALTA]")[1].split("## [MEDIA]")[0]
        assert "010" in alta_section

    def test_edit_detail(self, tmp_tracker):
        edit_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = edit_fn("010", detail="Nuevo detalle\nlínea 2")
        assert ok is True
        content = tmp_tracker.read_text(encoding="utf-8")
        assert "Nuevo detalle" in content
        assert "línea 2" in content

    def test_edit_nonexistent_returns_false(self, tmp_tracker):
        edit_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = edit_fn("999", title="No existe")
        assert ok is False

    def test_edit_preserves_other_items(self, tmp_tracker):
        edit_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            edit_fn("010", title="Editado")
        content = tmp_tracker.read_text(encoding="utf-8")
        assert "012" in content
        assert "PROTEIN LAB" in content


# ─── Delete tests ────────────────────────────────────────────────────────────

class TestDeletePendingTask:
    def _import(self):
        from server.bridge import delete_pending_task, PENDING_TRACKER
        return delete_pending_task, PENDING_TRACKER

    def test_delete_item(self, tmp_tracker):
        del_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = del_fn("010")
        assert ok is True
        content = tmp_tracker.read_text(encoding="utf-8")
        assert "010" not in content
        assert "DREAM CYCLE" not in content

    def test_delete_preserves_other_items(self, tmp_tracker):
        del_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            del_fn("010")
        content = tmp_tracker.read_text(encoding="utf-8")
        assert "012" in content
        assert "022" in content

    def test_delete_nonexistent_returns_false(self, tmp_tracker):
        del_fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = del_fn("999")
        assert ok is False


# ─── Change state tests ─────────────────────────────────────────────────────

class TestChangePendingState:
    def _import(self):
        from server.bridge import change_pending_state, PENDING_TRACKER
        return change_pending_state, PENDING_TRACKER

    def test_change_state(self, tmp_tracker):
        fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = fn("010", "🟢")
        assert ok is True
        content = tmp_tracker.read_text(encoding="utf-8")
        assert "🟢" in content

    def test_change_state_invalid(self, tmp_tracker):
        fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = fn("010", "INVALID")
        assert ok is False

    def test_change_state_nonexistent(self, tmp_tracker):
        fn, _ = self._import()
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            ok = fn("999", "🟢")
        assert ok is False


# ─── Endpoint tests for new operations ──────────────────────────────────────

class TestNewPendingEndpoints:
    def _do_post(self, path, body):
        from server.bridge import ThreadingHTTPServer, BridgeHandler
        import threading
        import urllib.request

        server = ThreadingHTTPServer(("localhost", 0), BridgeHandler)
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        try:
            data = json.dumps(body).encode()
            req = urllib.request.Request(
                f"http://localhost:{port}{path}",
                data=data,
                headers={
                    "Content-Type": "application/json",
                    "X-RepoCiv-Token": "CPLZlthUBzy1T7TBKYWqGvYDNMbWcP4x0N0rkb9XPbc",
                },
                method="POST",
            )
            try:
                resp = urllib.request.urlopen(req, timeout=3)
                return resp.status, json.loads(resp.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())
        finally:
            server.shutdown()

    def test_post_edit_returns_ok(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/edit", {
                "id": "010", "title": "Editado desde endpoint"
            })
        assert status == 200
        assert body["ok"] is True

    def test_post_edit_requires_id(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/edit", {"title": "Sin ID"})
        assert status == 400

    def test_post_delete_returns_ok(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/delete", {"id": "022"})
        assert status == 200
        assert body["ok"] is True

    def test_post_delete_requires_id(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/delete", {})
        assert status == 400

    def test_post_state_returns_ok(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/state", {
                "id": "010", "state": "🟢"
            })
        assert status == 200
        assert body["ok"] is True
        assert body["state"] == "🟢"

    def test_post_state_requires_both(self, tmp_tracker):
        with patch("server.bridge.PENDING_TRACKER", tmp_tracker):
            status, body = self._do_post("/pending/state", {"id": "010"})
        assert status == 400
