"""Path resolution and spatial context for the runner; no execution or session state.

Runner-specific state lookups are injected to retain its late-bound patch seams.
"""

from __future__ import annotations


import os
from pathlib import Path
from typing import Callable


def repos_root(active_root: Callable[[], str | None]) -> str:
    state_root = active_root()
    if state_root:
        return state_root
    root = (
        os.environ.get("REPOCIV_MAP_ROOT")
        or os.environ.get("REPOCIV_REPOS_ROOT")
        or os.environ.get("WORKSPACE_ROOT")
        or str(Path.home() / ".hermes" / "workspace" / "repos")
    )
    return os.path.expanduser(root)


def path_is_within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def resolve_agent_working_dir(
    city_id: str,
    repo_path: str = "",
    *,
    runner_file: str,
    resolve_selected_repo: Callable[[str, str], str | None],
) -> str | None:
    if not repo_path and city_id.lower() == "main":
        return None
    if not repo_path and city_id.lower() == "capital":
        return os.path.dirname(os.path.dirname(os.path.abspath(runner_file)))
    return resolve_selected_repo(city_id, repo_path)


def resolve_absolute_file_path(
    repo_path: str, file_path: str, *, path_is_within: Callable[[str, str], bool]
) -> str:
    if not file_path:
        return ""
    repo_real = os.path.realpath(repo_path)
    candidate = file_path if os.path.isabs(file_path) else os.path.join(repo_real, file_path)
    candidate_real = os.path.realpath(candidate)
    if not path_is_within(candidate_real, repo_real):
        raise ValueError("file path is outside selected repo")
    return candidate_real


def spatial_context_block(
    city_id: str, working_dir: str | None, *, repos_root: Callable[[], str]
) -> str:
    """Facts about which repo/city this mission targets — models must not invent a fixed home repo."""
    root = repos_root()
    expected = working_dir or os.path.join(root, city_id)
    if working_dir:
        path_line = f"- **Ruta de trabajo (cwd del adaptador):** `{working_dir}`"
    else:
        path_line = (
            f"- **Ruta de trabajo:** NO resuelta: no existe `{expected}`. "
            "Alinea el nombre de la carpeta con `city_id` o crea el clone ahi."
        )
    return (
        "\n\n## Contexto espacial RepoCiv (fuente de verdad)\n"
        f"- **Ciudad / target (`city_id`):** `{city_id}`\n"
        f"{path_line}\n"
        f"- **Raiz de repos (`REPOCIV_MAP_ROOT` / `REPOCIV_REPOS_ROOT` / `WORKSPACE_ROOT`):** `{root}`\n"
        f"- **Ruta esperada para este target:** `{expected}`\n"
        "- **Alcance:** responde solo sobre esta ciudad/repo y su cwd. "
        "No uses historial, archivos ni estado de otras ciudades.\n"
    )
