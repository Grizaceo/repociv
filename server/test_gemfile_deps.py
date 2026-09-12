"""Regression: Gemfile dependency extraction was broken.

The `_MANIFEST_PARSERS["Gemfile"]` entry was a 4-tuple — an errant `re.MULTILINE`
element — while both consumers unpack `pattern, _, _ = parser_info` (3 values), so
any repo containing a Gemfile raised `ValueError: too many values to unpack`
*before* the Gemfile branch ran. The flag also belonged inside `re.compile` so the
`^` anchor matches every `gem` line, not just a file that starts with one.

Surfaced by the mypy dict-item errors on the heterogeneous tuple shapes.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

GEMFILE = """source 'https://rubygems.org'
gem 'rails'
gem "puma", "~> 5.0"
gem 'nokogiri'
"""


@pytest.mark.parametrize("mod_name", ["server.graph_signals", "server.graph_index"])
def test_gemfile_deps_extracted_not_crash(mod_name: str, tmp_path: Path) -> None:
    mod = importlib.import_module(mod_name)
    gemfile = tmp_path / "Gemfile"
    gemfile.write_text(GEMFILE, encoding="utf-8")

    deps = mod._extract_package_deps(gemfile)  # must not raise ValueError

    assert set(deps) == {"rails", "puma", "nokogiri"}


@pytest.mark.parametrize(
    "mod_name", ["server.graph_signals", "server.graph_relations_base"]
)
def test_manifest_parsers_are_all_three_tuples(mod_name: str) -> None:
    """Every _MANIFEST_PARSERS value must be a (pattern, group, kind) 3-tuple —
    the shape the consumers unpack."""
    mod = importlib.import_module(mod_name)
    for name, entry in mod._MANIFEST_PARSERS.items():
        assert len(entry) == 3, f"{name} parser tuple has {len(entry)} elements, expected 3"
