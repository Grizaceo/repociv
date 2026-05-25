#!/usr/bin/env python3
"""RepoCiv — Foreign Relations Report Store.

Persists ForeignRelationsReport documents with links to:
  - article(s) that triggered them
  - target city (repo)
  - target repo path

Storage: JSON-per-file under ~/.repociv/reports/<report_id>.json
Kept simple — no SQLite needed at this scale.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_REPORTS_DIR = Path.home() / ".repociv" / "reports"


def _ensure_dir() -> Path:
    _REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    return _REPORTS_DIR


def save_report(report: dict[str, Any]) -> dict[str, Any]:
    """Save a ForeignRelationsReport to disk.

    Assigns an ID and createdAt if not present. Returns the report dict.
    """
    _ensure_dir()

    if "id" not in report or not report["id"]:
        report["id"] = str(uuid.uuid4())
    if "createdAt" not in report or not report["createdAt"]:
        report["createdAt"] = datetime.now(timezone.utc).isoformat()

    file_path = _REPORTS_DIR / f"{report['id']}.json"
    file_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return report


def get_report(report_id: str) -> dict[str, Any] | None:
    """Load a single report by ID."""
    file_path = _REPORTS_DIR / f"{report_id}.json"
    if not file_path.exists():
        return None
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def list_reports(city_id: str | None = None, article_id: str | None = None) -> list[dict[str, Any]]:
    """List all reports, optionally filtered by city or article.

    Returns reports sorted by createdAt descending (newest first).
    """
    _ensure_dir()
    reports: list[dict[str, Any]] = []
    for path in sorted(_REPORTS_DIR.glob("*.json"), reverse=True):
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        # Apply filters
        if city_id is not None:
            if report.get("targetCityId") != city_id:
                continue
        if article_id is not None:
            article_ids = report.get("articleIds", [])
            if article_id not in article_ids:
                continue

        reports.append(report)

    # Sort by createdAt descending
    reports.sort(key=lambda r: r.get("createdAt", ""), reverse=True)
    return reports


def delete_report(report_id: str) -> bool:
    """Delete a report by ID. Returns True if deleted."""
    file_path = _REPORTS_DIR / f"{report_id}.json"
    if not file_path.exists():
        return False
    file_path.unlink()
    return True


def get_reports_for_article(article_id: str | int) -> list[dict[str, Any]]:
    """Get all reports linked to a specific article ID."""
    article_id_str = str(article_id)
    return list_reports(article_id=article_id_str)


def get_reports_for_city(city_id: str) -> list[dict[str, Any]]:
    """Get all reports linked to a specific city/repo."""
    return list_reports(city_id=city_id)


def report_count() -> int:
    """Return total number of stored reports."""
    _ensure_dir()
    return len(list(_REPORTS_DIR.glob("*.json")))