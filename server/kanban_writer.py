"""Create project boards through the supported Hermes CLI, never SQL writes."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any

from server import kanban_reader as kb

_CREATE_LOCK = threading.Lock()
_SLUG = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")


def post_kanban_board(body: Any, _ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Authenticated POST /api/kanban/boards; do not change Hermes' current board."""
    if not isinstance(body, dict):
        return 400, {"error": "Se requiere un objeto JSON."}
    slug, name, project = (body.get(k) for k in ("slug", "name", "project_path"))
    if not isinstance(slug, str) or not _SLUG.fullmatch(slug) or slug == "default":
        return 400, {"error": "ID inválido: 1–64 caracteres minúsculos, números, guiones o guion bajo; default está reservado."}
    if not isinstance(name, str) or not name.strip() or len(name) > 120 or any(ord(c) < 32 for c in name):
        return 400, {"error": "Nombre requerido, sin caracteres de control y de hasta 120 caracteres."}
    if not isinstance(project, str) or not project or len(project) > 4096 or any(ord(c) < 32 for c in project):
        return 400, {"error": "Se requiere la ruta del proyecto."}
    path = Path(project).expanduser()
    if not path.is_absolute() or not path.is_dir():
        return 400, {"error": "El proyecto debe ser un directorio local existente con ruta absoluta (o ~/)."}
    path = path.resolve()
    root = kb._kanban_dir().resolve()
    # Hermes CLI takes the shared home, and appends /kanban/boards itself.
    # Refuse incompatible reader overrides instead of writing a different store.
    if root.name != "kanban":
        return 503, {"error": "El directorio Kanban debe terminar en /kanban para usar la CLI nativa."}
    cli = shutil.which("hermes")
    if not cli:
        return 503, {"error": "La CLI de Hermes no está disponible en el servidor."}
    with _CREATE_LOCK:
        if (root / "boards" / slug).exists():
            return 409, {"error": "Ese ID ya existe. Elige otro; no se modificó el tablero existente."}
        env = dict(os.environ, HERMES_KANBAN_HOME=str(root.parent))
        try:
            result = subprocess.run(
                [cli, "kanban", "boards", "create", slug, "--name", name.strip(),
                 "--default-workdir", str(path)],
                env=env, capture_output=True, text=True, timeout=30, check=False,
            )
        except subprocess.TimeoutExpired:
            return 504, {"error": "Hermes agotó el tiempo. Actualiza los tableros antes de reintentar: pudo crearse."}
        except OSError:
            return 503, {"error": "No se pudo ejecutar la CLI de Hermes."}
        if result.returncode != 0:
            # CLI diagnostics may contain environment/provider details. Never relay them.
            return 502, {"error": "Hermes no pudo crear el tablero. Actualiza la lista antes de reintentar."}
        board = kb.get_board(slug)
        meta = kb._board_meta(slug)
        if not board["available"] or board["slug"] != slug or meta.get("default_workdir") != str(path):
            return 502, {"error": "No se pudo verificar el tablero creado. Actualiza la lista antes de reintentar."}
        return 201, {"board": board, "project_path": str(path)}
