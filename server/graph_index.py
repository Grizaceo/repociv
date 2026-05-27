
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

# ─── Lock ──────────────────────────────────────────────────────────────────────

_lock = threading.Lock()


# ─── Helpers ───────────────────────────────────────────────────────────────────



try:
    from server.graph_relations_base import *  # noqa: F401,F403
    from server.graph_relations_base import (  # noqa: F401
        _INDEX_DIR,
    _REPO_SIGNALS_DIR,
    _RELATION_CACHE_DIR,
    _META_FILE,
    _FLAGS_FILE,
    _MAX_EVENTS,
    _MAX_RANDOM_WALK_STEPS,
    _DEFAULT_FLAGS,
    _RUNTIME_FLAGS,
    _SUGGESTED_ACTIONS,
    _RELATION_TYPES,
    _IMPORT_PATTERNS,
    _MARKDOWN_LINK_RE,
    _MARKDOWN_HEADING_RE,
    _ENTITY_PATTERNS,
    _MANIFEST_PARSERS,
    _lock,
    )
except ImportError:
    from graph_relations_base import *  # noqa: F401,F403
    from graph_relations_base import (  # noqa: F401
        _INDEX_DIR,
    _REPO_SIGNALS_DIR,
    _RELATION_CACHE_DIR,
    _META_FILE,
    _FLAGS_FILE,
    _MAX_EVENTS,
    _MAX_RANDOM_WALK_STEPS,
    _DEFAULT_FLAGS,
    _RUNTIME_FLAGS,
    _SUGGESTED_ACTIONS,
    _RELATION_TYPES,
    _IMPORT_PATTERNS,
    _MARKDOWN_LINK_RE,
    _MARKDOWN_HEADING_RE,
    _ENTITY_PATTERNS,
    _MANIFEST_PARSERS,
    _lock,
    )

def _tokenize(text: str) -> set[str]:
    """Simple lowercase tokenizer — splits on non-alphanumeric."""
    return set(re.findall(r"[a-záéíóúñü]+", text.lower()))


def _slugify(path_str: str) -> str:
    """Create a safe filename slug from a repo path."""
    safe = path_str.strip().replace("/", "_").replace("\\", "_").replace(" ", "_")
    safe = re.sub(r"[^a-zA-Z0-9_\-]", "", safe)
    return safe


def _repo_id_from_path(repo_path: str) -> str:
    """Derive a stable repo ID from its path."""
    p = Path(repo_path).expanduser().resolve()
    return f"{p.parent.name}__{p.name}"


def _read_file_safe(path: Path, max_bytes: int = 65536) -> str:
    """Read a file up to max_bytes, return empty string on any error."""
    try:
        if not path.is_file():
            return ""
        data = path.read_bytes()[:max_bytes]
        return data.decode("utf-8", errors="replace")
    except (OSError, PermissionError):
        return ""


def _jaccard(a: set[str], b: set[str]) -> float:
    """Jaccard similarity between two sets."""
    if not a or not b:
        return 0.0
    union = a | b
    if not union:
        return 0.0
    return len(a & b) / len(union)


# ─── Index meta (mtime tracking) ──────────────────────────────────────────────


def _load_meta() -> dict[str, dict[str, float]]:
    """Load the index meta: {repo_id: {filepath: mtime, ...}}."""
    if not _META_FILE.exists():
        return {}
    try:
        return json.loads(_META_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_meta(meta: dict[str, dict[str, float]]) -> None:
    """Persist index meta."""
    _INDEX_DIR.mkdir(parents=True, exist_ok=True)
    _META_FILE.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")


# ─── Signal Extraction ─────────────────────────────────────────────────────────


def _extract_imports(file_path: Path) -> list[str]:
    """Extract import statements from a source file based on extension."""
    ext = file_path.suffix.lower()
    pattern = _IMPORT_PATTERNS.get(ext)
    if not pattern:
        return []
    content = _read_file_safe(file_path, max_bytes=32768)
    if not content:
        return []
    imports: list[str] = []
    for match in pattern.finditer(content):
        # Extract all named groups
        for g in match.groups():
            if g:
                # Split multi-imports
                for imp in re.split(r"[,;]\s*", g.strip()):
                    imp = imp.strip().strip("'\"")
                    if imp and len(imp) > 1:
                        imports.append(imp)
    return list(set(imports))


def _extract_markdown_links(file_path: Path) -> list[dict[str, str]]:
    """Extract markdown links: [text](url)."""
    content = _read_file_safe(file_path, max_bytes=32768)
    if not content:
        return []
    links: list[dict[str, str]] = []
    for text, url in _MARKDOWN_LINK_RE.findall(content):
        links.append({"text": text.strip(), "url": url.strip()})
    return links


def _extract_markdown_headings(file_path: Path) -> list[str]:
    """Extract markdown headings."""
    content = _read_file_safe(file_path, max_bytes=32768)
    if not content:
        return []
    return [h.strip() for h in _MARKDOWN_HEADING_RE.findall(content)]


def _extract_package_deps(file_path: Path) -> list[str]:
    """Extract dependency names from package manifest files."""
    fname = file_path.name
    parser_info = _MANIFEST_PARSERS.get(fname)
    if not parser_info:
        return []
    pattern, _, _ = parser_info
    content = _read_file_safe(file_path, max_bytes=32768)
    if not content:
        return []
    deps: list[str] = []
    for match in pattern.finditer(content):
        if fname == "Cargo.toml":
            block = match.group(1)
            for line in block.splitlines():
                m = re.match(r'^\s*(\w[\w-]*)\s*=', line)
                if m:
                    deps.append(m.group(1))
        elif fname == "requirements.txt":
            deps.append(match.group(1))
        elif fname == "go.mod":
            deps.append(match.group(1).split("/")[-1])
        elif fname in ("pyproject.toml",):
            block = match.group(1)
            for entry in re.findall(r'["\']([\w._-]+?)["\']', block):
                if ">" not in entry and "=" not in entry:
                    deps.append(entry.split("[")[0].strip())
        elif fname == "package.json":
            block = match.group(1)
            for m in re.finditer(r'"([\w@][\w./_-]*)"\s*:\s*"([^"]+)"', block):
                deps.append(m.group(1))
        elif fname == "Gemfile":
            deps.append(match.group(1))
    return list(set(deps))


def _extract_entities(text: str) -> list[str]:
    """Extract tech/keyword entities from text."""
    return list(set(m.group(0).lower() for m in _ENTITY_PATTERNS.finditer(text)))


def _extract_tags_from_agent_files(repo_path: Path) -> list[str]:
    """Extract tags/skills from AGENTS.md, SKILL.md, CLAUDE.md, .cursorrules."""
    tags: list[str] = []
    for fname in ("AGENTS.md", "SKILL.md", "CLAUDE.md", ".cursorrules"):
        fp = repo_path / fname
        content = _read_file_safe(fp, max_bytes=8192)
        if not content:
            continue
        # Tags on lines like: tags: [tag1, tag2] or tags: tag1, tag2 or ### Tags section
        for m in re.finditer(r'(?:tags|skills|categories):\s*\[?([^\]]+?)\]?\s*$', content, re.MULTILINE | re.IGNORECASE):
            raw = m.group(1)
            for t in re.split(r'[,\s]+', raw.strip()):
                t = t.strip().strip("'\"").lower()
                if t and len(t) > 1:
                    tags.append(t)
        # Also look for skill references
        for m in re.finditer(r'(?:skill|agent|role):\s*["\']?([\w\s_-]+)["\']?', content, re.IGNORECASE):
            tags.append(m.group(1).strip().lower())
    return list(set(tags))


def _get_file_mtimes(repo_path: Path) -> dict[str, float]:
    """Get mtime for all relevant files in a repo, recursively."""
    mtimes: dict[str, float] = {}
    repo_str = str(repo_path)
    # Walk up to ~200 files for speed
    count = 0
    for root_str, dirs, files in os.walk(repo_str):
        if count > 10_000:
            break
        # Skip hidden dirs and node_modules, venv, .git, __pycache__
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in (
            "node_modules", "venv", ".venv", ".git", "__pycache__",
            "target", "build", "dist", ".next", ".turbo",
        )]
        root = Path(root_str)
        for fname in files:
            # Only index relevant files
            ext = Path(fname).suffix.lower()
            if ext not in _IMPORT_PATTERNS and fname not in _MANIFEST_PARSERS and fname not in (
                "README.md", "Readme.md", "AGENTS.md", "SKILL.md", "CLAUDE.md", ".cursorrules",
            ):
                continue
            fp = root / fname
            try:
                mtimes[str(fp.relative_to(repo_path))] = fp.stat().st_mtime
            except (OSError, ValueError):
                continue
            count += 1
    return mtimes


# ─── Repo Signal Extraction ────────────────────────────────────────────────────


def _extract_repo_signals(repo_path: Path) -> dict[str, Any]:
    """Extract all signals from a repo: imports, deps, entities, tags, links, etc."""
    if not repo_path.is_dir():
        return {}
    repo_str = str(repo_path)
    signals: dict[str, Any] = {
        "repoId": _repo_id_from_path(repo_str),
        "repoName": repo_path.name,
        "repoPath": repo_str,
        "imports": [],
        "dependencies": [],
        "entities": [],
        "markdownLinks": [],
        "markdownHeadings": [],
        "tags": [],
        "topDirs": [],
        "lastIndexed": time.time(),
    }

    # Top-level dirs
    try:
        signals["topDirs"] = sorted(
            p.name for p in repo_path.iterdir()
            if p.is_dir() and not p.name.startswith(".") and not p.name.startswith("__")
        )[:30]
    except (PermissionError, OSError):
        pass

    # Walk files
    imports_all: list[str] = []
    deps_all: list[str] = []
    entities_all: list[str] = []
    links_all: list[dict[str, str]] = []
    headings_all: list[str] = []

    for root_str, dirs, files in os.walk(repo_str):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in (
            "node_modules", "venv", ".venv", ".git", "__pycache__",
            "target", "build", "dist", ".next", ".turbo",
        )]
        root = Path(root_str)
        for fname in files:
            fp = root / fname
            ext = fname.lower().rsplit(".", 1)[-1] if "." in fname else ""
            ext = f".{ext}"

            if ext in _IMPORT_PATTERNS:
                imports_all.extend(_extract_imports(fp))

            if fname in _MANIFEST_PARSERS:
                deps_all.extend(_extract_package_deps(fp))

            if fname.lower() == "readme.md":
                links_all.extend(_extract_markdown_links(fp))
                headings_all.extend(_extract_markdown_headings(fp))
                content = _read_file_safe(fp, max_bytes=16384)
                entities_all.extend(_extract_entities(content))

    # Agent tag files
    tag_files = ["AGENTS.md", "SKILL.md", "CLAUDE.md", ".cursorrules"]
    for tf in tag_files:
        links_all.extend(_extract_markdown_links(repo_path / tf))

    signals["tags"] = _extract_tags_from_agent_files(repo_path)

    # Add repo name and top dirs to entities
    entities_all.append(repo_path.name.lower())
    for d in signals["topDirs"]:
        entities_all.append(d.lower())

    # Tag words as entities
    for t in signals["tags"]:
        for word in t.replace("-", " ").split():
            if len(word) > 2:
                entities_all.append(word)

    signals["imports"] = list(set(imports_all))[:200]
    signals["dependencies"] = list(set(deps_all))[:100]
    signals["entities"] = list(set(entities_all))[:100]
    signals["markdownLinks"] = links_all[:100]
    signals["markdownHeadings"] = headings_all[:50]

    return signals


def _has_repo_changed(repo_path: Path, meta: dict[str, dict[str, float]]) -> bool:
    """Check if any relevant file in the repo has changed since last index."""
    repo_id = _repo_id_from_path(str(repo_path))
    prev_mtimes = meta.get(repo_id, {})
    current_mtimes = _get_file_mtimes(repo_path)
    if not current_mtimes:
        return False  # No indexable files
    if not prev_mtimes:
        return True  # Never indexed
    # Compare mtimes
    for rel_path, mtime in current_mtimes.items():
        prev = prev_mtimes.get(rel_path, 0)
        if mtime > prev + 0.01:  # 10ms tolerance for filesystem precision
            return True
    # Check for removed files
    if set(prev_mtimes.keys()) - set(current_mtimes.keys()):
        return True
    return False


# ─── Event Integration ─────────────────────────────────────────────────────────


def _load_recent_events() -> list[dict[str, Any]]:
    """Load recent events from event_store.py, best-effort."""
    try:
        from server.event_store import read_events  # noqa: PLC0415
        return read_events(since=time.time() - 86400 * 7, limit=_MAX_EVENTS)  # last 7 days
    except Exception:
        return []


# ─── Index Persistence ─────────────────────────────────────────────────────────


def _save_repo_signals(repo_id: str, signals: dict[str, Any]) -> None:
    """Save repo signals to disk."""
    _REPO_SIGNALS_DIR.mkdir(parents=True, exist_ok=True)
    fp = _REPO_SIGNALS_DIR / f"{_slugify(repo_id)}.json"
    fp.write_text(json.dumps(signals, indent=2, ensure_ascii=False), encoding="utf-8")


def _load_repo_signals(repo_id: str) -> dict[str, Any] | None:
    """Load repo signals from disk."""
    fp = _REPO_SIGNALS_DIR / f"{_slugify(repo_id)}.json"
    if not fp.exists():
        return None
    try:
        return json.loads(fp.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _load_all_signals() -> dict[str, dict[str, Any]]:
    """Load all repo signals from disk."""
    _REPO_SIGNALS_DIR.mkdir(parents=True, exist_ok=True)
    signals: dict[str, dict[str, Any]] = {}
    for fp in _REPO_SIGNALS_DIR.glob("*.json"):
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
            rid = data.get("repoId", fp.stem)
            signals[rid] = data
        except (json.JSONDecodeError, OSError):
            continue
    return signals


def _save_relation_cache(key: str, data: dict[str, Any]) -> None:
    """Save relation pair cache to disk."""
    _RELATION_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fp = _RELATION_CACHE_DIR / f"{_slugify(key)}.json"
    fp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _load_relation_cache(key: str) -> dict[str, Any] | None:
    """Load relation pair cache from disk."""
    fp = _RELATION_CACHE_DIR / f"{_slugify(key)}.json"
    if not fp.exists():
        return None
    try:
        return json.loads(fp.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


# ─── Git Co-activity ───────────────────────────────────────────────────────────


def _get_git_committers(repo_path: str, days: int = 14) -> dict[str, list[float]]:
    """Return {committer_email: [timestamp, ...]} from recent git log."""
    try:
        result = subprocess.run(
            ["git", "log", f"--since={days}.days", "--format=%ae|%at"],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=repo_path,
        )
        committers: dict[str, list[float]] = defaultdict(list)
        for line in result.stdout.strip().splitlines():
            if "|" not in line:
                continue
            email, ts = line.split("|", 1)
            if email and ts:
                committers[email].append(float(ts))
        return dict(committers)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return {}


def _check_coactivity(
    path_a: str, path_b: str, days: int = 14
) -> tuple[float, list[str]]:
    """Check temporal co-activity: do both repos have commits by same people in same time window?"""
    comm_a = _get_git_committers(path_a, days)
    comm_b = _get_git_committers(path_b, days)
    if not comm_a or not comm_b:
        return 0.0, []
    shared_emails = set(comm_a.keys()) & set(comm_b.keys())
    if not shared_emails:
        return 0.0, []
    evidence: list[str] = []
    for email in list(shared_emails)[:5]:
        timestamps_a = comm_a[email]
        timestamps_b = comm_b[email]
        # Count commits in both repos that are within 1 hour of each other
        near_commits = 0
        for ta in timestamps_a:
            for tb in timestamps_b:
                if abs(ta - tb) < 3600:
                    near_commits += 1
        if near_commits > 0:
            evidence.append(f"Commiter {email} active in both repos within 1h window ({near_commits}x)")
    if not evidence:
        return 0.0, []
    score = min(len(evidence) / 5.0, 1.0)
    return score, evidence
