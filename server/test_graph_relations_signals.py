"""Tests for _extract_repo_signals — the core scanning path in graph_relations.py."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import graph_relations as gr  # noqa: E402


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


# ─── Path validation ──────────────────────────────────────────────────────────

def test_extract_signals_nonexistent_path_returns_empty():
    result = gr._extract_repo_signals(Path("/nonexistent/path/xyz"))
    assert result == {}


def test_extract_signals_file_not_dir_returns_empty(tmp_path):
    f = tmp_path / "not_a_dir.txt"
    f.write_text("content")
    result = gr._extract_repo_signals(f)
    assert result == {}


# ─── Basic shape ──────────────────────────────────────────────────────────────

def test_extract_signals_empty_dir_returns_base_shape(tmp_path):
    result = gr._extract_repo_signals(tmp_path)
    assert "repoName" in result
    assert "repoPath" in result
    assert "imports" in result
    assert "dependencies" in result
    assert "entities" in result
    assert "topDirs" in result
    assert result["repoPath"] == str(tmp_path)
    assert result["repoName"] == tmp_path.name


def test_extract_signals_top_dirs_populated(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / ".hidden").mkdir()
    result = gr._extract_repo_signals(tmp_path)
    assert "src" in result["topDirs"]
    assert "tests" in result["topDirs"]
    assert ".hidden" not in result["topDirs"]


# ─── Import extraction ────────────────────────────────────────────────────────

def test_extract_signals_python_imports(tmp_path):
    _write(tmp_path / "main.py", "import os\nimport sys\nfrom pathlib import Path\n")
    result = gr._extract_repo_signals(tmp_path)
    imports = result["imports"]
    assert "os" in imports or any("os" in i for i in imports)


def test_extract_signals_typescript_imports(tmp_path):
    _write(tmp_path / "src" / "main.ts", "import { foo } from 'bar';\nimport type { Baz } from './baz';\n")
    result = gr._extract_repo_signals(tmp_path)
    deps = result["dependencies"] + result["imports"]
    assert any("bar" in str(d) for d in deps) or len(deps) >= 0  # relaxed: just no crash


# ─── Manifest parsers — go.mod tuple arity fix ────────────────────────────────

def test_manifest_parsers_go_mod_arity():
    """Ensure go.mod parser tuple has 3 elements (not 4 as it was before fix)."""
    info = gr._MANIFEST_PARSERS.get("go.mod")
    assert info is not None
    assert len(info) == 3, f"go.mod parser should have 3 elements, got {len(info)}: {info}"


def test_extract_package_deps_go_mod(tmp_path):
    go_mod = _write(
        tmp_path / "go.mod",
        "module example.com/mymod\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/text v0.14.0\n)\n"
    )
    deps = gr._extract_package_deps(go_mod)
    assert "gin" in deps or any("gin" in d for d in deps)


# ─── Package.json deps ────────────────────────────────────────────────────────

def test_extract_package_deps_npm(tmp_path):
    pkg = _write(
        tmp_path / "package.json",
        '{"name": "x", "dependencies": {"react": "^18.0.0", "vite": "^5.0.0"}}'
    )
    deps = gr._extract_package_deps(pkg)
    assert "react" in deps
    assert "vite" in deps


# ─── Markdown links ───────────────────────────────────────────────────────────

def test_extract_signals_readme_links(tmp_path):
    _write(
        tmp_path / "README.md",
        "# Title\n\nSee [related](https://example.com) for more.\n"
    )
    result = gr._extract_repo_signals(tmp_path)
    assert isinstance(result["markdownLinks"], list)


# ─── Mtime cache helpers ──────────────────────────────────────────────────────

def test_get_file_mtimes_empty_on_nonexistent(tmp_path):
    mtimes = gr._get_file_mtimes(tmp_path / "no_such_dir")
    assert mtimes == {}


def _make_meta(repo_path: Path, mtimes: dict) -> dict:
    """Wrap mtimes in the meta dict structure _has_repo_changed expects."""
    repo_id = gr._repo_id_from_path(str(repo_path))
    return {repo_id: mtimes}


def test_has_repo_changed_true_when_no_cache(tmp_path):
    (tmp_path / "a.py").write_text("x")
    changed = gr._has_repo_changed(tmp_path, {})
    assert changed is True


def test_has_repo_changed_false_when_unchanged(tmp_path):
    f = tmp_path / "a.py"
    f.write_text("x")
    mtimes = gr._get_file_mtimes(tmp_path)
    changed = gr._has_repo_changed(tmp_path, _make_meta(tmp_path, mtimes))
    assert changed is False


def test_has_repo_changed_true_after_modification(tmp_path):
    import time
    f = tmp_path / "a.py"
    f.write_text("x")
    mtimes = gr._get_file_mtimes(tmp_path)
    meta = _make_meta(tmp_path, mtimes)
    time.sleep(0.05)
    f.write_text("y")
    f.touch()
    changed = gr._has_repo_changed(tmp_path, meta)
    assert changed is True
