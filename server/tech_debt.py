"""Tech-debt scanner used by the RepoCiv bridge observability endpoint."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

_TD_PATTERNS = re.compile(
    r'(TODO\s*[:\-]?\s*tech\s*debt|FIXME\s*[:\-]?\s*hack|HACK|BUG\s*[:\-]?\s*|'
    r'REFACTOR|TECH\s*DEBT|DEBT\s*[:\-]?\s*|LEGACY|STALE)',
    re.IGNORECASE,
)
_TD_EXTENSIONS = {'.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.cpp', '.c', '.h'}
_TD_CACHE: dict[str, Any] = {}
_TD_CACHE_TTL = 300  # 5 minutos


def scan_tech_debt(root_path: str = os.path.expanduser("~/.hermes/workspace/repos")) -> list[dict[str, Any]]:
    now = time.monotonic()
    if _TD_CACHE.get('ts', 0) + _TD_CACHE_TTL > now and _TD_CACHE.get('root') == root_path:
        return _TD_CACHE.get('results', [])

    results: list[dict[str, Any]] = []
    try:
        skip_file = Path(__file__).parent.parent / "shared" / "skip-dirs.json"
        skip: set[str] = set(json.loads(skip_file.read_text())) if skip_file.exists() else set()
        for repo in os.listdir(root_path):
            repo_path = os.path.join(root_path, repo)
            if not os.path.isdir(repo_path):
                continue
            for dirpath, _dirs, filenames in os.walk(repo_path):
                if any(s in dirpath for s in skip):
                    continue
                for fname in filenames:
                    ext = os.path.splitext(fname)[1].lower()
                    if ext not in _TD_EXTENSIONS:
                        continue
                    fpath = os.path.join(dirpath, fname)
                    try:
                        rel = os.path.relpath(fpath, root_path)
                        with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                            content = f.read()
                        matches: list[dict[str, str]] = []
                        for i, line in enumerate(content.splitlines(), 1):
                            if _TD_PATTERNS.search(line):
                                matches.append({'line': i, 'text': line.strip()[:120]})
                        if matches:
                            results.append({'repo': repo, 'file': rel, 'path': fpath,
                                            'matches': matches, 'severity': _assess_debt_severity(matches)})
                    except Exception:
                        pass
    except Exception:
        pass
    _TD_CACHE['results'] = results
    _TD_CACHE['ts'] = now
    _TD_CACHE['root'] = root_path
    return results


def _assess_debt_severity(matches: list[dict[str, str]]) -> str:
    critical = {'BUG', 'HACK', 'FIXME'}
    high = {'TECH DEBT', 'REFACTOR', 'DEBT', 'LEGACY'}
    for m in matches:
        first_word = m['text'].split()[0].upper() if m['text'] else ''
        if first_word in critical:
            return 'critical'
        if any(w in m['text'].upper() for w in high):
            return 'high'
    return 'normal'
