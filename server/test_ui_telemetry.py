"""Tests for server/ui_telemetry.py and /api/telemetry/* endpoints."""
from __future__ import annotations

import json
import urllib.request
from pathlib import Path

from server import endpoint_usage as eu, event_store as es, ui_telemetry as ut
from server.test_bridge_integration import _auth_headers, _start_test_server


def test_ui_telemetry_records_counts_only_and_computes_summary(tmp_path: Path) -> None:
    eu.init(tmp_path)
    es.init(tmp_path)
    ut.init(tmp_path)

    assert ut.record_ui_event("panel", "approvals") is True
    assert ut.record_ui_event("panel", "approvals", 2) is True
    assert ut.record_ui_event("hotkey", "F8") is True
    assert ut.record_ui_event("invalid_kind", "x") is False
    assert ut.record_ui_event("panel", "../bad") is False

    eu.record("POST", "/commands", 200)
    eu.record("POST", "/api/external-agents/hermes-default-123/chat", 202)
    eu.record("POST", "/approvals/cmd-1/approve", 200)

    summary = ut.get_usage_summary()
    assert summary["daysWithUsage"] >= 1
    assert summary["commandsIssued"] >= 1
    assert summary["chatsSent"] >= 2
    assert summary["approvalsResolved"] == 1
    assert summary["panelsOpened"] == {"approvals": 3}
    assert summary["hotkeysUsed"] == {"F8": 1}

    persisted = json.loads((tmp_path / "ui_telemetry.json").read_text(encoding="utf-8"))
    assert set(persisted.keys()) == {"panelsOpened", "hotkeysUsed", "dailyActivityCounts"}

    pruning = ut.pruning_candidates_query()
    assert "approvals" not in pruning["unusedPanels"]
    assert "kanban" in pruning["unusedPanels"]
    assert isinstance(pruning["unusedEndpoints"], list)


def test_telemetry_http_routes_roundtrip(tmp_path: Path) -> None:
    ut.init(tmp_path)
    server, base = _start_test_server()
    try:
        req = urllib.request.Request(
            f"{base}/api/telemetry/ui",
            data=json.dumps({"kind": "panel", "name": "tasks", "count": 1}).encode("utf-8"),
            headers=_auth_headers({"Content-Type": "application/json"}),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            assert resp.status == 200
            body = json.loads(resp.read().decode("utf-8"))
            assert body["panelsOpened"]["tasks"] == 1

        req_get = urllib.request.Request(
            f"{base}/api/telemetry/usage",
            headers=_auth_headers(),
            method="GET",
        )
        with urllib.request.urlopen(req_get, timeout=2) as resp:
            assert resp.status == 200
            body2 = json.loads(resp.read().decode("utf-8"))
            assert body2["panelsOpened"]["tasks"] == 1
    finally:
        server.shutdown()
        server.server_close()
