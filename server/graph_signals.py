

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from collections import Counter, defaultdict
from functools import lru_cache
from math import log
from pathlib import Path
from typing import Any


# ─── Constants ─────────────────────────────────────────────────────────────────

_INDEX_DIR = Path.home() / ".repociv" / "graph_index"
_REPO_SIGNALS_DIR = _INDEX_DIR / "repo_signals"
_RELATION_CACHE_DIR = _INDEX_DIR / "relation_cache"
_META_FILE = _INDEX_DIR / "index_meta.json"
_FLAGS_FILE = _INDEX_DIR / "flags.json"

_MAX_EVENTS = 200  # max recent events to include per build
_MAX_RANDOM_WALK_STEPS = 100
_DEFAULT_FLAGS = {
    "graphSuggestions": False,
    "aiRelationDiscovery": False,
}
_RUNTIME_FLAGS = dict(_DEFAULT_FLAGS)

_SUGGESTED_ACTIONS = ["linkear", "ignorar", "abrir ambos", "crear nota"]

_RELATION_TYPES = [
    "shared_dependency",
    "shared_entity",
    "temporal_coactivity",
    "conceptual_overlap",
    "imports_or_links",
    "same_lab_family",
    "security_relevance",
    "unknown_but_interesting",
]

# File patterns for import extraction
_IMPORT_PATTERNS: dict[str, re.Pattern] = {
    ".py": re.compile(
        r'(?:^|\n)\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+(?:\s*,\s*[.\w]+)*))',
        re.MULTILINE,
    ),
    ".ts": re.compile(r'(?:^|\n)\s*(?:import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+[\'"]([^\'"]+)[\'"]|import\s+[\'"]([^\'"]+)[\'"])', re.MULTILINE),  # noqa: E501
    ".tsx": re.compile(r'(?:^|\n)\s*(?:import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+[\'"]([^\'"]+)[\'"]|import\s+[\'"]([^\'"]+)[\'"])', re.MULTILINE),  # noqa: E501
    ".js": re.compile(r'(?:^|\n)\s*(?:import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+[\'"]([^\'"]+)[\'"]|require\s*\(\s*[\'"]([^\'"]+)[\'"]\s*\))', re.MULTILINE),  # noqa: E501
    ".jsx": re.compile(r'(?:^|\n)\s*(?:import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+[\'"]([^\'"]+)[\'"]|require\s*\(\s*[\'"]([^\'"]+)[\'"]\s*\))', re.MULTILINE),  # noqa: E501
    ".rs": re.compile(r'(?:^|\n)\s*(?:use\s+([\w:]+)(?:\s*::\s*\{[^}]*\})?|extern\s+crate\s+(\w+))', re.MULTILINE),
    ".go": re.compile(r'(?:^|\n)\s*import\s+(?:\{|"([^"]+)")\s*([^"]*(?:"[^"]*"[^"]*)*\})?', re.MULTILINE),
}

_MARKDOWN_LINK_RE = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')
_MARKDOWN_HEADING_RE = re.compile(r'^#{1,6}\s+(.+)$', re.MULTILINE)

# Tech/keyword patterns for entity extraction
_ENTITY_PATTERNS = re.compile(
    r'(?i)\b('
    r'python|typescript|javascript|rust|go|golang|java|ruby|php|cpp|c\+\+|swift|kotlin|'
    r'react|vue|svelte|angular|next\.?js|nuxt|node|deno|bun|'
    r'tensorflow|pytorch|flask|fastapi|django|express|spring|rails|'
    r'docker|kubernetes|k8s|terraform|ansible|pulumi|'
    r'postgres|postgresql|mysql|sqlite|redis|mongodb|'
    r'aws|gcp|azure|cloudflare|vercel|netlify|'
    r'llm|ai|machine.?learning|deep.?learning|neural|transformer|'
    r'graphql|grpc|rest|api|websocket|'
    r'agente|agent|bot|automation|workflow|pipeline|'
    r'security|vulnerability|cve|exploit|malware|yara|pentest|'
    r'linux|windows|macos|cross.?platform|'
    r'dashboard|visualization|canvas|game|simulation|'
    r'hermes|repociv|bibliotheca'
    r')\b'
)

# Package manifest file names and their dependency extractors
_MANIFEST_PARSERS: dict[str, tuple[re.Pattern, ...]] = {  # type: ignore[assignment]
    "package.json": (re.compile(r'"(?:dependencies|devDependencies|peerDependencies)"\s*:\s*\{([^}]+)\}'), 0, "npm"),
    "Cargo.toml": (re.compile(r'^\[dependencies\]\s*$(.+?)(?:^\[|\Z)', re.MULTILINE | re.DOTALL), 0, "cargo"),
    "requirements.txt": (re.compile(r'^([a-zA-Z_][\w.-]*)', re.MULTILINE), 0, "pip"),
    "pyproject.toml": (re.compile(r'(?:dependencies|optional-dependencies)\s*=\s*\[\s*([^\]]+)\]'), 0, "pdm"),
    "go.mod": (re.compile(r'^\s+([a-zA-Z_][\w./-]+)\s+v?\d+\.', re.MULTILINE), 0, "go_mod"),
    "Gemfile": (re.compile(r"^\s*gem\s+['\"]([\w-]+)['\"]"), re.MULTILINE, 0, "gem"),
}

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


def _load_flags() -> dict[str, bool]:
    """Load feature flags from runtime state, falling back to env vars."""
    flags: dict[str, bool] = dict(_RUNTIME_FLAGS)
    # Env overrides take precedence
    env_graph = os.environ.get("REPOCIV_GRAPH_SUGGESTIONS")
    if env_graph is not None:
        flags["graphSuggestions"] = env_graph.lower() in ("1", "true", "yes")
    env_ai = os.environ.get("REPOCIV_AI_RELATION_DISCOVERY")
    if env_ai is not None:
        flags["aiRelationDiscovery"] = env_ai.lower() in ("1", "true", "yes")
    return flags


def _save_flags(flags: dict[str, bool]) -> None:
    """Persist feature flags for the current runtime and for debugging on disk."""
    global _RUNTIME_FLAGS
    _RUNTIME_FLAGS = {
        "graphSuggestions": bool(flags.get("graphSuggestions", False)),
        "aiRelationDiscovery": bool(flags.get("aiRelationDiscovery", False)),
    }
    _INDEX_DIR.mkdir(parents=True, exist_ok=True)
    _FLAGS_FILE.write_text(json.dumps(_RUNTIME_FLAGS, indent=2, ensure_ascii=False), encoding="utf-8")


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



