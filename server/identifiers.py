"""RepoCiv — R16: identifier confinement for local state stores.

Both ``checkpoint.py`` and ``workspace_issue.py`` derive filesystem paths
from operator-supplied ``repo`` / ``issue_id`` tokens. Raw joins or
separator-only sanitization cannot stop a literal parent-directory
component or an absolute path from resolving outside the store root.

Contract (R16):

* ``validate_identifier`` rejects, **without repair**, any token that is
  not a plain filesystem-safe component: empty, over-long, NUL-bearing,
  absolute, containing a path separator (``/`` or ``\\``), or equal to
  ``.`` / ``..``. Valid tokens are returned normalized (leading/trailing
  whitespace stripped); invalid tokens raise ``IdentifierError``.
* ``confine`` resolves a candidate path against a store root and rejects
  the operation *before any filesystem effect* when the resolved path
  escapes the resolved root. Resolution follows symlinks, so a symlink
  planted inside the store cannot point writes outside it.

Nothing here touches tokens, approvals, agents, or the live bridge.
"""
from __future__ import annotations

from pathlib import Path

# Literal identifier format: one filesystem component, no separators,
# no traversal. Dots are only allowed *inside* a token (``v1.2``),
# never as a standalone component or a leading dot.
_ALLOWED_EXTRA = {".", "-", "_"}
_MAX_ID_LEN = 128


class IdentifierError(ValueError):
    """A repo/issue identifier failed the R16 confinement contract."""


def validate_identifier(value: object, *, field: str = "identifier") -> str:
    """Return *value* as a safe single-component identifier or raise.

    Rejects without repair: no separator folding, no stripping of
    ``..`` components, no absolutization.
    """
    if not isinstance(value, str):
        raise IdentifierError(f"{field} must be a string, got {type(value).__name__}")
    token = value.strip()
    if not token:
        raise IdentifierError(f"{field} must not be empty")
    if len(token) > _MAX_ID_LEN:
        raise IdentifierError(f"{field} exceeds max length {_MAX_ID_LEN}")
    if "\x00" in token:
        raise IdentifierError(f"{field} must not contain NUL")
    if "/" in token or "\\" in token:
        raise IdentifierError(f"{field} must not contain path separators: {token!r}")
    if token in (".", ".."):
        raise IdentifierError(f"{field} must not be a traversal component: {token!r}")
    if Path(token).is_absolute() or (len(token) > 1 and token[1] == ":"):
        raise IdentifierError(f"{field} must not be absolute: {token!r}")
    if token.startswith("."):
        raise IdentifierError(f"{field} must not start with a dot: {token!r}")
    for ch in token:
        if ch.isalnum() or ch in _ALLOWED_EXTRA:
            continue
        raise IdentifierError(f"{field} contains disallowed character {ch!r}: {token!r}")
    return token


def confine(root: Path | str, candidate: Path | str, *, label: str = "path") -> Path:
    """Return *candidate* confined under *root*, or raise IdentifierError.

    The check resolves symlinks: if *candidate* (or any existing
    component of it) points outside *root*, the operation is rejected
    before any mkdir/read/write/delete happens.
    """
    root_path = Path(root)
    root_resolved = root_path.resolve()
    candidate_path = Path(candidate)
    if candidate_path.is_absolute():
        # Only accept an absolute candidate when it was constructed under root
        # (e.g. ``root / "link" / "file"``); arbitrary absolute paths such as
        # ``/etc/passwd`` are rejected immediately.
        try:
            candidate_path.relative_to(root_path)
        except ValueError:
            try:
                candidate_path.relative_to(root_resolved)
            except ValueError as exc:
                raise IdentifierError(
                    f"{label} must be relative to the store root: {candidate_path!r}"
                ) from exc
        joined = candidate_path
    else:
        joined = root_resolved / candidate_path
    resolved = joined.resolve()
    if resolved != root_resolved and root_resolved not in resolved.parents:
        raise IdentifierError(f"{label} escapes the store root: {candidate!r}")
    return resolved


def confined_child(root: Path | str, component: str, *, label: str = "path") -> Path:
    """Validate *component* and return the confined ``root/component`` path."""
    token = validate_identifier(component, field=label)
    return confine(root, Path(token), label=label)


def confined_path(root: Path | str, *components: str, label: str = "path") -> Path:
    """Validate every component and return the confined joined path.

    Raises ``IdentifierError`` before any filesystem effect when a
    component is malformed or the joined path would escape *root*.
    """
    if not components:
        raise IdentifierError(f"{label} requires at least one component")
    tokens = [
        validate_identifier(component, field=f"{label}[{i}]")
        for i, component in enumerate(components)
    ]
    return confine(root, Path(*tokens), label=label)
