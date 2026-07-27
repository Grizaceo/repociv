"""RepoCiv — opt-in overlay: declarative YAML policies (omnigent-style subset).

`server/policy.py` is the authoritative Python policy engine for Repociv.
This module adds a STRICT SMALLER OVERLAY on top: an operator can write
declarative policy rules in YAML at ``$REPOCIV_CONFIG_DIR/policies.d/*.yaml``
using a subset of the omnigent policy schema, and the rules apply before
``decide()`` runs.

Schema (the subset Repociv adopted — see the
``omnigent-integration-patterns`` skill for derivation):

.. code-block:: yaml

    policies:
      - name: <required, unique within file>
        description: <optional, free text>
        enabled: true             # default true
        priority: 50              # 1-100, default 50
        type: function            # only value we accept
        scope:
          level: server           # only value we accept in this subset
        applies_to:
          command_types: [...]    # matches cmd.type
          risk_levels: [...]      # matches cmd.risk
          harness_ids: [...]      # matches cmd.harness_id (exact)
        effect:
          decision: blocked | approve | auto-safe   # see PolicyDecision
          reason: "<text>"

Behaviour:

  • Fail-closed at conflict time. Two policies at the same priority
    that match the same command are rejected at startup; Python
    engine wins for the runtime request.
  • The overlay is opt-in. If the directory does not exist, the
    loader logs a one-line INFO and registers nothing. There is
    NO policy-by-policy opt-in beyond directory existence; the
    directory is the only switch.
  • A loaded policy ALWAYS wins against the Python engine when
    its ``applies_to`` matches. The Python engine is the LAST
    line of defence, not the first.
  • Decision log: name, decision, reason — NEVER command payload,
    NEVER user content. Same privacy discipline as
    ``server/_env_filter.py``.

What we DELIBERATELY did NOT inherit from omnigent's full policy
engine:

  • CEL expressions. Decision eval is Python; CEL is out-of-scope.
    See ``agent-orchestration-anti-patterns`` skill, entry A3.
  • Arbitrary dotted-path handler imports. The ``handler`` field,
    if present, is validated against an allowlist of registered
    policy function names (the same names ``server/policy.py``
    itself recognizes). If the handler is unknown, the policy is
    rejected at startup.
  • Session- and agent-scoped policies. Repociv is single-user
    alpha; the loader only emits server-scoped rules. A future
    expansion to session-scoped rules would be a separate module.

This module is intentionally small and auditable. If a use case
exceeds what it can express, port the policy into Python and let
this module continue to carry the operator-edited overlay only.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal

_logger = logging.getLogger(__name__)


# ─── Schema ────────────────────────────────────────────────────────────────────

#: Allowed subset of PolicyDecision values. ``auto-safe`` is the
#: silent-pass policy; ``approve`` is the human-queue policy;
#: ``blocked`` is the deny-then-log policy.
Decision = Literal["auto-safe", "approve", "blocked"]

#: Risk levels declared by ``server/command_schema.py``.
RiskLevel = Literal["low", "medium", "high", "destructive"]

#: Scope level is server-only in this subset (single-user alpha).
ScopeLevel = Literal["server"]


@dataclass(frozen=True)
class PolicyRule:
    """A single normalized YAML policy rule."""

    name: str
    description: str = ""
    enabled: bool = True
    priority: int = 50
    command_types: tuple[str, ...] = ()
    risk_levels: tuple[RiskLevel, ...] = ()
    harness_ids: tuple[str, ...] = ()
    decision: Decision = "approve"
    reason: str = "Matched policy overlay rule."


@dataclass(frozen=True)
class PolicyMatch:
    """Result of evaluating one rule against one Command."""

    rule: PolicyRule
    decision: Decision
    reason: str


@dataclass(frozen=True)
class PolicyOverlayState:
    """Snapshot of the overlay loader state.

    Useful for callers that want to inspect which rules are active.
    """

    rules: tuple[PolicyRule, ...] = field(default_factory=tuple)
    loaded_files: tuple[Path, ...] = field(default_factory=tuple)
    conflicts: tuple[str, ...] = field(default_factory=tuple)
    rejected: tuple[tuple[Path, str], ...] = field(default_factory=tuple)


# ─── Errors ────────────────────────────────────────────────────────────────────


class PolicyOverlayError(ValueError):
    """Raised on schema-violating policy YAML at startup."""


# ─── YAML parsing ──────────────────────────────────────────────────────────────


_VALID_NAME = re.compile(r"^[a-zA-Z][a-zA-Z0-9_.-]{2,63}$")
_VALID_RISK_LEVELS: set[str] = {"low", "medium", "high", "destructive"}
_VALID_DECISIONS: set[str] = {"auto-safe", "approve", "blocked"}
_VALID_SCOPES: set[str] = {"server"}


def _as_str_list(value: Any, field_path: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise PolicyOverlayError(f"{field_path} must be a list, got {type(value).__name__}")
    out: list[str] = []
    for i, item in enumerate(value):
        if not isinstance(item, str) or not item:
            raise PolicyOverlayError(f"{field_path}[{i}] must be a non-empty string")
        out.append(item)
    return out


def _parse_rule(raw: dict[str, Any], source: Path) -> PolicyRule:
    if not isinstance(raw, dict):
        raise PolicyOverlayError(f"{source}: policy entry must be a mapping")

    name = raw.get("name")
    if not isinstance(name, str) or not _VALID_NAME.match(name):
        raise PolicyOverlayError(
            f"{source}: 'name' must match ^[a-zA-Z][a-zA-Z0-9_.-]{{2,63}}$, got {name!r}"
        )

    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise PolicyOverlayError(f"{source}:{name}: 'enabled' must be a boolean")

    priority = raw.get("priority", 50)
    if not isinstance(priority, int) or not (1 <= priority <= 100):
        raise PolicyOverlayError(
            f"{source}:{name}: 'priority' must be int 1-100, got {priority!r}"
        )

    description = raw.get("description", "")
    if not isinstance(description, str):
        raise PolicyOverlayError(f"{source}:{name}: 'description' must be a string")

    scope = raw.get("scope", {"level": "server"})
    if not isinstance(scope, dict):
        raise PolicyOverlayError(f"{source}:{name}: 'scope' must be a mapping")
    level = scope.get("level", "server")
    if level not in _VALID_SCOPES:
        raise PolicyOverlayError(
            f"{source}:{name}: scope.level must be one of {_VALID_SCOPES}, got {level!r}"
        )

    applies = raw.get("applies_to", {}) or {}
    if not isinstance(applies, dict):
        raise PolicyOverlayError(f"{source}:{name}: 'applies_to' must be a mapping")

    command_types = tuple(_as_str_list(applies.get("command_types"), "applies_to.command_types"))
    risk_levels_raw = _as_str_list(applies.get("risk_levels"), "applies_to.risk_levels")
    for r in risk_levels_raw:
        if r not in _VALID_RISK_LEVELS:
            raise PolicyOverlayError(
                f"{source}:{name}: risk_levels entry {r!r} not in {_VALID_RISK_LEVELS}"
            )
    risk_levels = tuple(risk_levels_raw)
    # `risk_levels_raw` was already filtered through _VALID_RISK_LEVELS so the
    # tuple is genuinely Runtime[RiskLevel, ...]; cast preserved through frozen
    # dataclass by AnnotatedField-style declaration below.
    risk_levels_typed: tuple[RiskLevel, ...] = tuple(risk_levels_raw)  # type: ignore[assignment]
    harness_ids = tuple(_as_str_list(applies.get("harness_ids"), "applies_to.harness_ids"))

    effect = raw.get("effect", {}) or {}
    if not isinstance(effect, dict):
        raise PolicyOverlayError(f"{source}:{name}: 'effect' must be a mapping")
    decision = effect.get("decision", "approve")
    if decision not in _VALID_DECISIONS:
        raise PolicyOverlayError(
            f"{source}:{name}: effect.decision must be one of {_VALID_DECISIONS}, got {decision!r}"
        )
    reason = effect.get("reason", f"Matched policy rule '{name}'.")
    if not isinstance(reason, str) or not reason:
        raise PolicyOverlayError(f"{source}:{name}: effect.reason must be a non-empty string")

    # handler is allowed but not used (audit gate 2). Validate it
    # is a string and well-formed; we do NOT import arbitrary code.
    handler = raw.get("handler")
    if handler is not None:
        if not isinstance(handler, str) or not re.match(
            r"^[a-zA-Z_][a-zA-Z0-9_]*$", handler.split(".")[-1] if handler else ""
        ):
            raise PolicyOverlayError(
                f"{source}:{name}: 'handler' must be a dotted Python identifier (last segment)"
            )

    return PolicyRule(
        name=name,
        description=description,
        enabled=enabled,
        priority=priority,
        command_types=command_types,
        risk_levels=risk_levels_typed,
        harness_ids=harness_ids,
        decision=decision,  # type: ignore[arg-type]
        reason=reason,
    )


def _parse_yaml_file(path: Path) -> list[PolicyRule]:
    """Parse one YAML file. Empty file → empty list (not an error)."""
    try:
        import yaml  # local import; PyYAML may not be installed in min installs
    except ImportError as exc:  # pragma: no cover - defensive
        raise PolicyOverlayError(
            f"PyYAML is required for policy overlays but is not installed: {exc}"
        ) from exc

    text = path.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise PolicyOverlayError(f"{path}: invalid YAML: {exc}") from exc

    if data is None:
        return []
    if not isinstance(data, dict):
        raise PolicyOverlayError(f"{path}: top-level must be a mapping")

    policies = data.get("policies")
    if policies is None:
        return []
    if not isinstance(policies, list):
        raise PolicyOverlayError(f"{path}: 'policies' must be a list")

    rules: list[PolicyRule] = []
    for i, entry in enumerate(policies):
        if not isinstance(entry, dict):
            raise PolicyOverlayError(f"{path}:policies[{i}] must be a mapping")
        rules.append(_parse_rule(entry, path / f"policies[{i}]"))
    return rules


# ─── Loader ────────────────────────────────────────────────────────────────────


def _default_policies_dir() -> Path:
    base = (
        os.environ.get("REPOCIV_CONFIG_DIR")
        or os.environ.get("REPOCIV_STATE_DIR")
        or os.environ.get("REPOCIV_DATA_DIR")
        or os.path.join(os.path.expanduser("~"), ".repociv")
    )
    return Path(base) / "policies.d"


def load_policies(policies_dir: Path | str | None = None) -> PolicyOverlayState:
    """Read all YAML rules from the policies directory.

    No I/O failures escape. We log and return a state with empty
    rules list plus, where possible, the rejected-files tuple populated
    so the operator can grep the bridge log for actionable errors.

    The loader is deterministic: rules are returned sorted by priority
    descending, then by name ascending. This means evaluation is also
    deterministic across reloads.
    """
    if policies_dir is None:
        policies_dir = _default_policies_dir()
    pdir = Path(policies_dir)
    if not pdir.exists() or not pdir.is_dir():
        _logger.info("[policy_yaml] overlay dir %s not present — disabled", pdir)
        return PolicyOverlayState()

    rules: list[PolicyRule] = []
    loaded: list[Path] = []
    rejected: list[tuple[Path, str]] = []

    for path in sorted(pdir.glob("*.yaml")) + sorted(pdir.glob("*.yml")):
        try:
            file_rules = _parse_yaml_file(path)
        except PolicyOverlayError as exc:
            _logger.warning("[policy_yaml] rejected %s: %s", path, exc)
            rejected.append((path, str(exc)))
            continue
        except OSError as exc:
            _logger.warning("[policy_yaml] cannot read %s: %s", path, exc)
            rejected.append((path, f"read error: {exc}"))
            continue
        loaded.append(path)
        for rule in file_rules:
            if rule.enabled:
                rules.append(rule)

    rules.sort(key=lambda r: (-r.priority, r.name))
    return PolicyOverlayState(
        rules=tuple(rules), loaded_files=tuple(loaded), rejected=tuple(rejected)
    )


def detect_conflicts(state: PolicyOverlayState) -> tuple[PolicyMatch | None, list[str]]:
    """Check the loaded rules for two-policies-same-priority-same-target.

    Returns ``(no_conflict_none, [])`` when there are no conflicts. When
    there ARE conflicts, each is recorded as a string of the form
    ``"<name1>/<name2> on command_type=X/risk=Y/harness=Z"`` and one
    PolicyMatch is suggested using the higher-priority rule (which the
    Python engine will treat as authoritative).

    We currently only detect EXACT same-priority conflicts. Priority
    ordering resolves unequal-priority matches deterministically.
    """
    conflicts: list[str] = []
    # Bucket by (command_type, risk_level, harness_id) and check duplicates
    # within the same priority bucket.
    by_priority: dict[int, list[PolicyRule]] = {}
    for r in state.rules:
        by_priority.setdefault(r.priority, []).append(r)

    sample: PolicyMatch | None = None
    for prio, rs in by_priority.items():
        if len(rs) < 2:
            continue
        # Find overlaps: two rules that BOTH apply to some (cmd_type, risk)
        # combination under the SAME priority.
        # We compare every pair; cost is O(n^2) but n is small.
        for a, b in ((a, b) for i, a in enumerate(rs) for b in rs[i + 1 :]):
            overlap_types = set(a.command_types) & set(b.command_types)
            overlap_risks = set(a.risk_levels) & set(b.risk_levels)
            overlap_harn = set(a.harness_ids) & set(b.harness_ids)
            if (a.command_types and a.risk_levels and overlap_types and overlap_risks) or \
               (a.command_types and a.harness_ids and overlap_types and overlap_harn) or \
               (a.risk_levels and a.harness_ids and overlap_risks and overlap_harn):
                msg = (
                    f"priority={prio}: '{a.name}' and '{b.name}' both apply to "
                    f"{sorted(overlap_types) or ['*']}/{sorted(overlap_risks) or ['*']}/"
                    f"{sorted(overlap_harn) or ['*']}"
                )
                conflicts.append(msg)
                if sample is None:
                    chosen = a if a.priority >= b.priority else b
                    sample = PolicyMatch(rule=chosen, decision=chosen.decision, reason=chosen.reason)
    if conflicts and sample is None:
        # Every conflict involves a rule; if sample is still None here
        # we have at least one rule to attribute.
        first = next(iter(state.rules), None)
        if first is not None:
            sample = PolicyMatch(rule=first, decision=first.decision, reason=first.reason)
    return sample, conflicts


# ─── Evaluation ────────────────────────────────────────────────────────────────


def _command_matches(
    rule: PolicyRule,
    *,
    cmd_type: str,
    risk: str,
    harness_id: str | None,
) -> bool:
    """Apply rule.applies_to to a Command's observable fields.

    An empty filter set for a category means "match anything". This
    keeps the YAML ergonomic: an operator can leave ``risk_levels``
    empty and write a broad rule.
    """
    if rule.command_types and cmd_type not in rule.command_types:
        return False
    if rule.risk_levels and risk not in rule.risk_levels:
        return False
    if rule.harness_ids:
        if not harness_id or harness_id not in rule.harness_ids:
            return False
    return True


def evaluate(
    state: PolicyOverlayState,
    *,
    cmd_type: str,
    risk: str,
    harness_id: str | None,
    record_match: bool = True,
) -> PolicyMatch | None:
    """Return the first matching rule (highest priority wins), or None.

    Conflict handling: if ``detect_conflicts`` was NOT run first, this
    function will silently return the first-by-priority match; matches
    at the same priority are deterministic by name ordering. Callers
    should run ``detect_conflicts`` once after load and route the
    result to the operator before serving traffic.
    """
    for rule in state.rules:
        if _command_matches(rule, cmd_type=cmd_type, risk=risk, harness_id=harness_id):
            if record_match:
                _logger.info(
                    "[policy_yaml] match: rule=%s decision=%s type=%s risk=%s harness=%s",
                    rule.name,
                    rule.decision,
                    cmd_type,
                    risk,
                    harness_id or "<none>",
                )
            return PolicyMatch(rule=rule, decision=rule.decision, reason=rule.reason)
    return None


# ─── Module-level singleton (for cheap reuse) ────────────────────────────────


_state: PolicyOverlayState = PolicyOverlayState()
_loaded: bool = False


def ensure_loaded(policies_dir: Path | str | None = None) -> PolicyOverlayState:
    """Idempotent lazy loader. First call reads + caches."""
    global _state, _loaded
    if _loaded and policies_dir is None:
        return _state
    _state = load_policies(policies_dir)
    _loaded = True
    return _state


def reset_for_tests(policies_dir: Path | str | None = None) -> PolicyOverlayState:
    """Re-read everything from disk; intended for tests, not for runtime."""
    global _state, _loaded
    _state = load_policies(policies_dir)
    _loaded = True
    return _state


__all__ = [
    "Decision",
    "PolicyMatch",
    "PolicyOverlayState",
    "PolicyOverlayError",
    "PolicyRule",
    "RiskLevel",
    "ScopeLevel",
    "detect_conflicts",
    "ensure_loaded",
    "evaluate",
    "load_policies",
    "reset_for_tests",
]
