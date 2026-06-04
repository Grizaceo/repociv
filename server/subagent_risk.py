"""Classify subagent Task delegations by risk level."""

from __future__ import annotations

import re
from typing import Literal

Risk = Literal["low", "medium", "high", "destructive"]

_DESTRUCTIVE = re.compile(
    r"\b(rm\s+-rf|delete\s+all|drop\s+table|force\s+push|destroy|wipe|purge)\b",
    re.I,
)
_HIGH = re.compile(
    r"\b(git\s+commit|push\s+--force|chmod\s+777|sudo|kill\s+-9|truncate)\b",
    re.I,
)
_MEDIUM = re.compile(
    r"\b(edit|write|modify|patch|delete|remove|overwrite|refactor)\b",
    re.I,
)


def classify_subagent(kind: str, label: str) -> Risk:
    """Infer risk from subagent kind and Task description."""
    text = f"{kind} {label}".lower()
    if kind == "shell" and _DESTRUCTIVE.search(text):
        return "destructive"
    if _DESTRUCTIVE.search(text):
        return "destructive"
    if kind == "shell" or _HIGH.search(text):
        return "high"
    if kind in ("explore", "ci-investigator", "cursor-guide"):
        return "low"
    if _MEDIUM.search(text):
        return "medium"
    return "low"


def requires_approval(risk: Risk) -> bool:
    return risk in ("high", "destructive")
