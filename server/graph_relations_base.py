"""RepoCiv — Graph Relations: Shared Constants and Types.

Shared constants, type aliases, and configuration for the graph_relations
submodules (graph_signals, graph_index, graph_scoring).
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

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


_lock = threading.Lock()



# Lock (shared between index and scoring)
_lock = threading.Lock()

# ─── Flag management (shared mutable state) ─────────────────────────────────────

def _load_flags() -> dict[str, bool]:
    """Load feature flags from runtime state, falling back to env vars."""
    flags: dict[str, bool] = dict(_RUNTIME_FLAGS)
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

