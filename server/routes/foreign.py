"""RepoCiv HTTP route handlers split by domain (Phase 4)."""
from __future__ import annotations

import json as _json_lib
import os
from pathlib import Path
from typing import Any

from server.routes.core import _error

RouteContext = dict[str, Any]

from server import labhub_adapter as _labhub  # noqa: E402

from server import repo_profile as _rp  # noqa: E402
from server import foreign_relations as _fr  # noqa: E402
from server import report_store as _rs  # noqa: E402

def get_labhub_status(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/labhub/status — overall Institutum reachability."""
    return 200, _labhub.get_labhub_overall_status()

def get_city_lab_status(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/labhub/status/{city_id} — lab status for a specific city.

    Query params:
        repoPath (str, optional): repo path for log link derivation.
    """
    city_id = ctx.get("city_id", "")
    if not city_id:
        return 400, {"error": "city_id is required"}
    params = ctx.get("params", {})
    repo_path = params.get("repoPath", "")
    return 200, _labhub.get_city_lab_status(city_id, repo_path=str(repo_path) if repo_path else None)

def get_all_cities_lab_status(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/labhub/status — batch lab status for all cities.

    Query params:
        cities (str, required): JSON-serialized list of city dicts with id, repoPath.
    """
    params = ctx.get("params", {})
    cities_raw = params.get("cities", "")
    if not cities_raw:
        return 400, {"error": "cities query param required (JSON array)"}
    try:
        cities = _json_lib.loads(str(cities_raw))
    except (_json_lib.JSONDecodeError, TypeError, ValueError):
        return 400, {"error": "cities must be valid JSON array"}
    if not isinstance(cities, list):
        return 400, {"error": "cities must be a JSON array"}
    return 200, _labhub.get_all_cities_lab_status(cities)

def get_repo_profile(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/foreign/repo-profile — build profile for a repo path.

    Query params:
        repoPath (required): absolute path to the repo.
    """
    params = ctx.get("params", {})
    repo_path = params.get("repoPath", "")
    if not repo_path:
        return _error(400, "repoPath is required",
                      "Query parameter 'repoPath' is missing",
                      "Use /api/foreign/repo-profile?repoPath=/absolute/path/to/repo")
    profile = _rp.build_profile(repo_path)
    if profile is None:
        return _error(404, f"Repo path not found or not a directory: {repo_path}",
                      f"Path does not exist or is not a directory: {repo_path}",
                      "Verify the repo path exists and is a directory")
    return 200, profile

def get_repo_profile_cache(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/foreign/repo-profile/cache — list cached profiles."""
    cache = _rp.get_cached_profiles()
    return 200, {
        "count": len(cache),
        "profiles": {k: {"repoName": v.get("repoName", "") if v else None,
                         "recentFilesCount": v.get("recentFilesCount", 0) if v else 0}
                      for k, v in cache.items()},
    }

def post_foreign_score(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/foreign/score — score an article against a repo profile.

    Body:
        article (dict): article with title, blogName, category, url
        repoPath (str): path to the repo
        events (list, optional): recent events
    """
    article = body.get("article", {})
    repo_path = body.get("repoPath", "")
    events = body.get("events", [])

    if not article or not repo_path:
        return _error(400, "article and repoPath are required",
                      "Request body missing required fields",
                      "Send { article: {...}, repoPath: '/path/to/repo' }")

    profile = _rp.build_profile(repo_path)
    if profile is None:
        return _error(404, f"Repo path not found: {repo_path}",
                      f"Cannot build profile for '{repo_path}' — path does not exist or is not a directory",
                      "Send a valid repo path that exists on the filesystem")

    scoring = _fr.score_article_repo(article, profile, events=events if events else None)
    return 200, {
        "scoring": scoring,
        "profile": {
            "repoName": profile["repoName"],
            "repoPath": profile["repoPath"],
            "topLevelDirs": profile["topLevelDirs"][:10],
            "recentFilesCount": profile["recentFilesCount"],
            "skillTags": profile["skillTags"],
        },
    }

def post_foreign_report(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/foreign/report — generate and save a ForeignRelationsReport.

    Body:
        article (dict): article with title, blogName, category, url, id
        articles (list, optional): one or more related articles for grouped analysis
        repoPath (str): path to the target repo
        targetCityId (str): city ID for the target (optional, auto-detected if omitted)
        events (list, optional): recent events for context
        graphRelations (list, optional): bibliotheca graph relations
        agentId (str, optional): agent identifier (default 'diplomat')
    """
    article = body.get("article", {})
    articles = [a for a in body.get("articles", []) if isinstance(a, dict)]
    if not articles and article:
        articles = [article]
    repo_path = body.get("repoPath", "")
    target_city_id = body.get("targetCityId", "")
    events = body.get("events", [])
    graph_relations = body.get("graphRelations", [])
    agent_id = body.get("agentId", "diplomat")

    if not articles or not repo_path:
        return _error(400, "article/articles and repoPath are required",
                      "Request body missing required fields",
                      "Send { article: {...}|articles: [...], repoPath: '/path/to/repo' }")

    profile = _rp.build_profile(repo_path)
    if profile is None:
        return _error(404, f"Repo path not found: {repo_path}",
                      f"Cannot build profile for '{repo_path}' — path does not exist or is not a directory",
                      "Send a valid repo path that exists on the filesystem")

    primary_article = dict(articles[0])
    if len(articles) > 1:
        primary_article["title"] = f"{primary_article.get('title', '')} + {len(articles) - 1} noticia(s)"
        categories = sorted({str(a.get('category', '')).strip() for a in articles if a.get('category')})
        if categories:
            primary_article["category"] = ", ".join(categories[:3])

    scoring = _fr.score_article_repo(primary_article, profile, events=events if events else None)
    report = _fr.generate_report(
        article=primary_article,
        profile=profile,
        scoring=scoring,
        events=events if events else None,
        graph_relations=graph_relations if graph_relations else None,
        agent_id=agent_id,
    )

    if report is None:
        return 500, {"error": "Report generation failed"}

    # Enrich with article/repo links
    article_ids = [str(a.get("id", "")) for a in articles if a.get("id") is not None]
    report["articleIds"] = article_ids
    report["targetCityId"] = target_city_id or profile["repoName"]
    report["targetRepoPath"] = repo_path

    # Persist
    saved = _rs.save_report(report)
    return 200, saved

def get_reports(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/foreign/reports — list reports.

    Query params:
        cityId (str, optional): filter by target city
        articleId (str, optional): filter by article ID
    """
    params = ctx.get("params", {})
    city_id = params.get("cityId")
    article_id = params.get("articleId")
    reports = _rs.list_reports(city_id=city_id, article_id=article_id)
    return 200, reports

def get_report_by_id(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/foreign/reports/{id} — single report."""
    report_id = ctx.get("report_id", "")
    if not report_id:
        return _error(400, "report_id is required",
                      "Path parameter 'report_id' is missing",
                      "Use /api/foreign/reports/{report_id} with a valid report ID")
    report = _rs.get_report(report_id)
    if not report:
        return _error(404, f"Report not found: {report_id}",
                      f"No report exists with id '{report_id}'",
                      "Check existing reports: GET /api/foreign/reports")
    return 200, report

def delete_report_by_id(ctx: dict[str, Any], _body: dict[str, Any]) -> tuple[int, Any]:
    """DELETE /api/foreign/reports/{id} — delete a report."""
    report_id = ctx.get("report_id", "")
    if not report_id:
        return _error(400, "report_id is required",
                      "Path parameter 'report_id' is missing",
                      "Use /api/foreign/reports/{report_id} with a valid report ID")
    ok = _rs.delete_report(report_id)
    if not ok:
        return _error(404, f"Report not found: {report_id}",
                      f"No report exists with id '{report_id}'",
                      "Check existing reports: GET /api/foreign/reports")
    return 200, {"ok": True, "deleted": report_id}

_FILE_TREE_MAX_DEPTH = 32
_FILE_TREE_MAX_FILES = 10_000
_FILE_TREE_SKIP_NAMES = frozenset({"__pycache__", "node_modules", "dist", "build", ".git"})


class _FileTreeLimitExceeded(Exception):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


def _configured_repos_root() -> Path:
    from server import repo_roots_state as _rrs

    state_root = _rrs.active_root()
    if state_root:
        return Path(os.path.expanduser(state_root)).resolve()
    map_root = (
        os.environ.get("REPOCIV_MAP_ROOT")
        or os.environ.get("REPOCIV_REPOS_ROOT")
        or os.environ.get("WORKSPACE_ROOT")
        or str(Path.home() / ".hermes" / "workspace" / "repos")
    )
    return Path(os.path.expanduser(map_root)).resolve()


def _path_under_root(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _symlink_stays_under_root(entry: Path, repos_root: Path) -> bool:
    if not entry.is_symlink():
        return True
    return _path_under_root(entry, repos_root)


def get_repo_file_tree(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/files/{repoId} — return file tree for local view generation."""
    from server import repo_roots_state as _rrs

    def _extract_repo_id(raw_path: str) -> str:
        repo_path = raw_path.split("?", 1)[0]
        return repo_path[len("/api/files/") :] if repo_path.startswith("/api/files/") else ""

    def _resolve_repo_path(repo_id: str, explicit_path: str) -> str:
        if explicit_path:
            return explicit_path
        decoded = _rrs.decode_repo_id(repo_id)
        if decoded:
            return decoded
        # Plain ids are single folder names under the active root — reject traversal
        if "/" in repo_id or "\\" in repo_id or ".." in repo_id:
            return ""
        active_root = _rrs.active_root()
        if active_root:
            return os.path.join(active_root, repo_id)
        map_root = (
            os.environ.get("REPOCIV_MAP_ROOT")
            or os.environ.get("REPOCIV_REPOS_ROOT")
            or os.environ.get("WORKSPACE_ROOT")
            or str(Path.home() / ".hermes" / "workspace" / "repos")
        )
        return os.path.join(os.path.expanduser(map_root), repo_id)

    path = str(ctx.get("repo_path", "") or "")
    full_path = str(ctx.get("path", "") or "")
    repo_id = _extract_repo_id(full_path)
    path = _resolve_repo_path(repo_id, path)

    if not path:
        return 400, {"error": "Missing repo path"}

    try:
        repos_root = _configured_repos_root()
        repo_path = Path(path).expanduser().resolve()
        if not _path_under_root(repo_path, repos_root):
            return _error(
                403,
                "Repository path outside allowed root",
                f"Resolved path {repo_path} is not under {repos_root}",
                "Use a repository under the configured workspace root",
            )
        if not repo_path.is_dir():
            return 404, {"error": f"Repository not found: {path}"}

        files: list[str] = []

        def build_tree(dir_path: Path, rel_path: str = "", depth: int = 0) -> dict:
            if depth > _FILE_TREE_MAX_DEPTH:
                raise _FileTreeLimitExceeded(
                    f"Directory tree exceeds max depth ({_FILE_TREE_MAX_DEPTH})"
                )
            node = {"name": dir_path.name or dir_path.name, "path": rel_path, "type": "dir", "children": []}
            try:
                for item in sorted(dir_path.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
                    if item.name.startswith(".") or item.name in _FILE_TREE_SKIP_NAMES:
                        continue
                    if not _symlink_stays_under_root(item, repos_root):
                        continue
                    item_rel = os.path.join(rel_path, item.name)
                    if item.is_dir():
                        node["children"].append(build_tree(item, item_rel, depth + 1))
                    else:
                        if len(files) >= _FILE_TREE_MAX_FILES:
                            raise _FileTreeLimitExceeded(
                                f"Directory tree exceeds max file count ({_FILE_TREE_MAX_FILES})"
                            )
                        files.append(item_rel)
                        node["children"].append({
                            "name": item.name,
                            "path": item_rel,
                            "type": "file"
                        })
            except PermissionError:
                pass
            return node

        tree = build_tree(repo_path, repo_path.name)
        return 200, {"tree": tree, "files": files, "repoId": repo_id or repo_path.name}

    except _FileTreeLimitExceeded as exc:
        return 400, {"error": exc.message}
    except Exception as e:
        return 500, {"error": str(e)}
