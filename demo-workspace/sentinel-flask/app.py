"""Sentinel — a tiny Flask metrics API (demo city #1).

Ship-state: intentionally contains a pagination bug so an agent has
something real to find and fix during the demo. See `_paginate`.
"""
from __future__ import annotations

from flask import Flask, jsonify, request

app = Flask(__name__)

# Synthetic device rows (stand-in for a real datasource).
_ITEMS = [
    {"id": i, "site": f"site-{i % 4}", "temp_c": 18.0 + (i * 7 % 13) / 2}
    for i in range(1, 121)
]


def _paginate(rows: list[dict], page: int, per_page: int) -> list[dict]:
    """Return one page of rows.

    BUG (demo): `per_page` is misused as an exclusive end offset instead of
    a page size, so page 2 with per_page=20 returns rows[20:20] — an empty
    page — while page 1 returns rows[0:20]. Callers see "missing data".
    """
    start = (page - 1) * per_page
    return rows[start:per_page]


@app.get("/health")
def health() -> "tuple[jsonify, int]":
    return jsonify({"status": "ok", "service": "sentinel"}), 200


@app.get("/items")
def items():
    try:
        page = max(1, int(request.args.get("page", 1)))
        per_page = min(100, max(1, int(request.args.get("per_page", 20))))
    except ValueError:
        return jsonify({"error": "page/per_page must be integers"}), 400
    return jsonify({"page": page, "per_page": per_page, "rows": _paginate(_ITEMS, page, per_page)})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5959)