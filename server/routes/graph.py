"""RepoCiv HTTP route handlers split by domain (Phase 4)."""
from __future__ import annotations

import os
from typing import Any

from server.routes.core import _error

RouteContext = dict[str, Any]

# ─── CDaily Integration routes ────────────────────────────────────────────────
import sqlite3  # noqa: E402
from contextlib import closing  # noqa: E402
from pathlib import Path  # noqa: E402

_CDAILY_DB_DEFAULT = Path.home() / ".blogwatcher-cli" / "blogwatcher-cli.db"

# Inline fallback mapping: blog_name keyword → (category, emoji)
_CATEGORY_FALLBACK: dict[str, tuple[str, str]] = {
    "seguridad": ("Seguridad", "🔐"),
    "security": ("Seguridad", "🔐"),
    "code": ("Código", "💻"),
    "claude": ("Claude", "🎯"),
    "noattack": ("Vulnerabilidades", "🚨"),
    "bleeping": ("Vulnerabilidades", "🚨"),
    "the hackernews": ("Vulnerabilidades", "🚨"),
    "hacker news": ("Vulnerabilidades", "🚨"),
    "tech": ("Tecnología", "⚙️"),
    "ai": ("IA", "🧠"),
    "machine learning": ("IA", "🧠"),
    "openai": ("IA", "🧠"),
    "google": ("Big Tech", "🌐"),
    "microsoft": ("Big Tech", "🌐"),
}

from server import wonder_registry as _wr  # noqa: E402

def _resolve_cdaily_db() -> Path:
    """Resuelve la ruta del SQLite de CDaily desde env o valor por defecto."""
    env_val = os.environ.get("CDAILY_DB_PATH", "")
    return Path(os.path.expanduser(env_val)) if env_val else _CDAILY_DB_DEFAULT

def _infer_category(blog_name: str) -> tuple[str, str]:
    bn = blog_name.lower()
    for kw, (cat, emoji) in _CATEGORY_FALLBACK.items():
        if kw in bn:
            return cat, emoji
    return "General", "📰"

def get_latest_news(ctx: dict[str, Any]) -> tuple[int, Any]:
    db_path = _resolve_cdaily_db()
    if not db_path.exists():
        return 200, []

    try:
        with closing(sqlite3.connect(str(db_path))) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            # Try with categories column first; fallback gracefully for older DB schemas
            rows = None
            for query in [
                """SELECT a.id, a.title, a.url, a.published_date, b.name AS blog_name,
                          COALESCE(a.categories, '') AS categories
                   FROM articles a
                   LEFT JOIN blogs b ON a.blog_id = b.id
                   WHERE a.is_read = 0
                   ORDER BY a.published_date DESC LIMIT 15""",
                """SELECT a.id, a.title, a.url, a.published_date, b.name AS blog_name,
                          '' AS categories
                   FROM articles a
                   LEFT JOIN blogs b ON a.blog_id = b.id
                   WHERE a.is_read = 0
                   ORDER BY a.published_date DESC LIMIT 15""",
            ]:
                try:
                    cur.execute(query)
                    rows = cur.fetchall()
                    break
                except sqlite3.OperationalError:
                    continue
            if rows is None:
                return 500, {"error": "No se pudo leer la tabla de artículos"}
        articles = []
        for r in rows:
            cat, emoji = _infer_category(r["blog_name"] or "")
            # use persisted categories if available
            if r["categories"]:
                cat = r["categories"].split(",")[0].strip() or cat
            articles.append({
                "id": r["id"],
                "title": r["title"] or r["url"],
                "url": r["url"],
                "publishedDate": r["published_date"],
                "blogName": r["blog_name"] or "Blog Desconocido",
                "category": cat,
                "emoji": emoji,
            })
        return 200, articles
    except Exception as e:
        return 500, {"error": f"Error al leer la base de datos de CDaily: {e}"}

def post_news_read(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, Any]:
    article_id = body.get("id")
    if not article_id:
        return 400, {"error": "Se requiere el ID del artículo"}

    db_path = _resolve_cdaily_db()
    if not db_path.exists():
        return 404, {"error": "Base de datos de CDaily no encontrada"}

    try:
        with closing(sqlite3.connect(str(db_path))) as conn:
            with conn:
                conn.execute("UPDATE articles SET is_read = 1 WHERE id = ?", (article_id,))
        return 200, {"success": True, "marked_id": article_id}
    except Exception as e:
        return 500, {"error": f"Error al actualizar la base de datos: {e}"}

def post_news_scan(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, Any]:
    """Escanear blogs ahora mismo via blogwatcher-cli."""
    try:
        import subprocess
        result = subprocess.run(
            ["blogwatcher-cli", "scan"],
            capture_output=True, text=True, timeout=120,
        )
        return 200, {
            "ok": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }
    except FileNotFoundError:
        return 500, {"ok": False, "error": "blogwatcher-cli no encontrado"}
    except subprocess.TimeoutExpired:
        return 500, {"ok": False, "error": "Timeout al escanear blogs (120s)"}
    except Exception as e:
        return 500, {"ok": False, "error": str(e)}

def get_wonders(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /wonders — list all registered Wonder manifests."""
    return 200, _wr.list_wonders()

def get_wonder_by_id(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /wonders/{id} — single Wonder manifest."""
    wonder_id = ctx.get("wonder_id", "")
    manifest = _wr.get_wonder(wonder_id)
    if not manifest:
        return _error(404, f"wonder '{wonder_id}' not found",
                      f"No wonder registered with id '{wonder_id}'",
                      "Check available wonders: GET /api/wonders")
    return 200, manifest

def get_wonder_health(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /wonders/{id}/health — health check for a specific Wonder."""
    wonder_id = ctx.get("wonder_id", "")
    return 200, _wr.check_wonder_health(wonder_id)
