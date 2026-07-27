"""RepoCiv — harness-card YAML export (omnigent-style subset).

External orchestrators in the omnigent family index sub-agents by
reading one YAML file per agent from a known directory. Repociv's
canonical metadata for harnesses lives as individual ``.json``
files under ``server/harness_cards/<id>.json``. This module exports
each JSON card as a YAML document conforming to the omnigent
sub-agent adapter schema subset documented in the
``omnigent-integration-patterns`` skill.

The export is **read-only**. Repociv itself does not parse these
YAML files at runtime; they exist for external consumers (meta-
harnesses, dashboards, doc-builders). This keeps Repociv coupled
to nothing while making itself legible to the omnigent ecosystem.

The export is on-demand. A cron, CI step, or operator action may
regenerate the YAML; Repociv does not maintain it implicitly.

Schema references:

  • omnigent-integration-patterns skill, C1 section
  • omnigent examples/polly/agents/<name>/config.yaml in the
    omnigent repository (Apache-2.0; schema convention only,
    no code is copied).

The YAML emitter uses only the Python stdlib + PyYAML (which
Repociv already depends on for ``repociv_hooks``).
"""
from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from pathlib import Path

from . import harness_registry as _hr

_logger = logging.getLogger(__name__)

_CARDS_DIR = Path(__file__).parent / "harness_cards"


def _load_card(card_path: Path) -> dict:
    return json.loads(card_path.read_text(encoding="utf-8"))


def _card_to_yaml(card: dict) -> dict:
    """Translate a JSON harness card to the omnigent adapter-YAML subset.

    Field mapping:

      id                                → name (and 'id' for downstream tooling)
      name                              → display_name
      description                       → description
      transport / discovery / auth / ... → executor.config (flattened)

    Fields we deliberately omit (per omnigent-shape decisions in the
    skill):

      • speedgrade metadata: omnigent does not store ux telemetry in the
        adapter YAML. We follow.
      • internal execution flags (e.g. ``bypass: true`` for claude):
        dropped — these are Repociv routing hacks not relevant to an
        external orchestrator.
    """
    return {
        "spec_version": 1,
        "name": card["id"],
        "display_name": card.get("name", card["id"]),
        "description": card.get("description", ""),
        "executor": {
            "type": "omnigent",
            "config": {
                # Repociv itself does not ship its own native harness;
                # the orchestrator should route through one of these.
                "harness": _infer_external_harness(card),
                "search_paths": (
                    card.get("discovery", {}).get("search_paths") or []
                ),
                "binary": card.get("discovery", {}).get("binary"),
                "env_base_url": card.get("discovery", {}).get("http", {}).get("env"),
                "auth_type": _first_auth_type(card.get("auth")),
            },
        },
        "model_selection": {
            "via": (
                "hermes_http_header" if card["id"] == "hermes"
                else "cli_flag"
            ),
            "env": card.get("model_selection"),
            "flag": card.get("execution_flags"),
        },
        "profile_binding": _adapt_profile_binding(card),
        "concurrency": card.get("concurrency"),
        "timeout_s": card.get("timeout_s"),
    }


def _infer_external_harness(card: dict) -> str:
    """Translate Repociv harness id to a name a meta-harness might know."""
    mapping = {
        "hermes": "hermes-native",
        "claude": "claude-code",
        "codex": "codex",
        "openclaw": "openclaw",
        "cursor": "cursor",
    }
    return mapping.get(card.get("id", ""), card.get("id", "unknown"))


def _first_auth_type(auth: dict | str | None) -> str | None:
    if not isinstance(auth, dict):
        return None
    if "type" in (auth.get("http") or {}):
        return auth["http"]["type"]
    return None


def _adapt_profile_binding(card: dict) -> dict | None:
    pb = card.get("profile_binding")
    if not isinstance(pb, dict):
        return None
    out: dict = {}
    if "harness_ref_semantics" in pb:
        out["harness_ref_semantics"] = pb["harness_ref_semantics"]
    if isinstance(pb.get("identity_mode"), dict):
        modes = pb["identity_mode"]
        if "native" in modes:
            out["identity_native"] = modes["native"]
        if "managed" in modes:
            out["identity_managed"] = modes["managed"]
    if "dispatch_env" in pb:
        out["dispatch_env"] = pb["dispatch_env"]
    return out or None


def _yaml_dump(payload: dict) -> str:
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - defensive
        raise RuntimeError(f"PyYAML is required for harness-cards-yaml-export: {exc}") from exc
    return yaml.safe_dump(payload, sort_keys=False, allow_unicode=True, default_flow_style=False)


def export_one(card_id: str, *, cards_dir: Path = _CARDS_DIR) -> str | None:
    """Return the YAML text for one harness card, or None if not found.

    Returns None only when the card file does not exist. An internal
    YAML emission failure would raise RuntimeError; we do not silently
    coerce to "". Downstream callers (CLIs, exports) that pass a
    non-existent id simply get None and the dict elides the entry.
    """
    path = cards_dir / f"{card_id}.json"
    if not path.exists():
        return None
    card = _load_card(path)
    return _yaml_dump(_card_to_yaml(card))


def export_all(card_ids: Iterable[str] | None = None, *, cards_dir: Path = _CARDS_DIR) -> dict[str, str]:
    """Return a dict {card_id: yaml_text} for each card id (defaults to registry-known)."""
    if card_ids is None:
        ids = [entry["id"] for entry in _hr.list_harnesses()]
        if not ids:
            # Fallback to filesystem enumeration if the registry is empty/cold.
            ids = sorted(p.stem for p in cards_dir.glob("*.json"))
    else:
        ids = list(card_ids)
    out: dict[str, str] = {}
    for cid in ids:
        text = export_one(cid, cards_dir=cards_dir)
        if text is not None:
            out[cid] = text
    return out


def write_all(
    out_dir: Path,
    *,
    card_ids: Iterable[str] | None = None,
    cards_dir: Path = _CARDS_DIR,
) -> list[Path]:
    """Render every card into ``out_dir`` and return the list of files written."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for cid, text in export_all(card_ids, cards_dir=cards_dir).items():
        target = out_dir / f"{cid}.yaml"
        target.write_text(text, encoding="utf-8")
        written.append(target)
    return written


__all__ = ["export_all", "export_one", "write_all"]
