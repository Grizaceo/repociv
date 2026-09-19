"""Tests for suvadu_tracker: parsing, cwd → city mapping, unit lifecycle, fail-open."""

from __future__ import annotations

import json
import os
from typing import Any

import pytest

from server import suvadu_tracker as st

NOW_MS = 1_789_800_000_000
MIN = 60_000


def _session(
    native: str,
    *,
    agent: str = "claude-code",
    cwd: str = "/w/repociv",
    last_ms: int = NOW_MS,
    model: str = "claude-opus-5",
) -> dict[str, Any]:
    """One row shaped like real `suv agent sessions` output (suvadu 0.4.1)."""
    prefix = "claude" if agent == "claude-code" else agent
    return {
        "agent": agent,
        "command_count": 30,
        "coverage": "partial",
        "coverage_note": "Captured native transcript events and locally recorded shell commands only.",
        "created_at": last_ms - 90 * MIN,
        "cwd": cwd,
        "event_count": 282,
        "first_activity_at": last_ms - 90 * MIN,
        "id": f"{prefix}-{native}",
        "last_activity_at": last_ms,
        "model": model,
        "models": [model],
        "native_id": native,
        "parent_id": None,
        "revision": "e28-c30-30",
        "updated_at": last_ms,
        "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        "usage_complete": True,
    }


def _sessions_json(*rows: dict[str, Any]) -> str:
    return json.dumps({"next_offset": None, "sessions": list(rows)})


def _history_line(session_id: str, started_ms: int, *, cwd: str = "/w/repociv",
                  executor_type: str = "agent", executor: str = "claude-code") -> str:
    return json.dumps({
        "id": "86",
        "session_id": session_id,
        "command": "cat ~/.ssh/id_ed25519  # must never leak",
        "cwd": cwd,
        "exit_code": 0,
        "started_at": started_ms,
        "ended_at": started_ms,
        "duration_ms": 0,
        "tag_name": None,
        "tag_id": None,
        "executor_type": executor_type,
        "executor": executor,
    })


class FakeSuv:
    """Stands in for the CLI: returns canned stdout per subcommand, or raises."""

    def __init__(self) -> None:
        self.sessions = _sessions_json()
        self.history = ""
        self.fail_sessions: Exception | None = None
        self.fail_history: Exception | None = None
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str]) -> str:
        self.calls.append(args)
        if args[:2] == ["agent", "sessions"]:
            if self.fail_sessions:
                raise self.fail_sessions
            return self.sessions
        if args[:1] == ["history"]:
            if self.fail_history:
                raise self.fail_history
            return self.history
        raise AssertionError(f"unexpected suv call {args}")


class Clock:
    def __init__(self, ms: int = NOW_MS) -> None:
        self.ms = ms

    def __call__(self) -> float:
        return self.ms / 1000


def _tracker(repo_paths: list[str], suv: FakeSuv, clock: Clock, sent: list[dict[str, Any]],
             **cfg: Any) -> st.ExternalAgentTracker:
    config = st.TrackerConfig(bin_path="suv", window_s=600, working_s=120, **cfg)
    return st.ExternalAgentTracker(
        config, send=sent.append, repo_paths=lambda: repo_paths, run=suv, clock=clock
    )


def _types(events: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in events]


@pytest.fixture()
def repos(tmp_path):
    """Real dirs so canonicalisation (realpath) runs for real."""
    w = tmp_path / "w"
    for rel in ("repociv/src", "repociv-old", "mono/pkg/inner", "mono/docs"):
        (w / rel).mkdir(parents=True)
    return w


# ─── Parsing ─────────────────────────────────────────────────────────────────
def test_parse_sessions_real_shape():
    obs = st.parse_sessions(_sessions_json(_session("fecf379b-7602-4f8b-b170-3e0a38cd156c")))
    assert len(obs) == 1
    o = obs[0]
    assert o.session_id == "claude-fecf379b-7602-4f8b-b170-3e0a38cd156c"
    assert o.agent == "claude-code"
    assert o.native_id == "fecf379b-7602-4f8b-b170-3e0a38cd156c"
    assert o.model == "claude-opus-5"
    assert o.last_activity_ms == NOW_MS
    assert (o.command_count, o.event_count, o.total_tokens) == (30, 282, 15)


def test_parse_sessions_skips_malformed_rows():
    rows = [_session("aaaaaaaa"), {"id": 3}, "junk", {"id": "x-1", "agent": "codex"}]
    assert [o.native_id for o in st.parse_sessions(json.dumps({"sessions": rows}))] == ["aaaaaaaa"]


@pytest.mark.parametrize("raw", ["not json", "[]", '{"sessions": 1}'])
def test_parse_sessions_bad_json(raw):
    with pytest.raises(st.SuvaduError, match="bad_json"):
        st.parse_sessions(raw)


def test_parse_history_groups_by_session_and_ignores_humans():
    raw = "\n".join([
        _history_line("claude-s1", NOW_MS - 5 * MIN, cwd="/w/a"),
        _history_line("claude-s1", NOW_MS - 1 * MIN, cwd="/w/b"),
        _history_line("human-1", NOW_MS, executor_type="human", executor="terminal"),
        "garbage",
        "",
    ])
    beats = st.parse_history(raw)
    assert list(beats) == ["claude-s1"]
    b = beats["claude-s1"]
    assert (b.count, b.first_ms, b.last_ms, b.cwd) == (2, NOW_MS - 5 * MIN, NOW_MS - MIN, "/w/b")


# ─── cwd → city ──────────────────────────────────────────────────────────────
def test_encode_repo_id_matches_node_base64url():
    # Values produced by vite-plugins/repoRootsState.ts encodeRepoId (Node base64url).
    assert st.encode_repo_id("/w/repociv") == "repo:L3cvcmVwb2Npdg"
    assert st.encode_repo_id("/home/x/ñandú-repo/a b") == "repo:L2hvbWUveC_DsWFuZMO6LXJlcG8vYSBi"


def test_city_for_cwd_longest_prefix_wins(repos):
    paths = [str(repos / "mono"), str(repos / "mono/pkg"), str(repos / "repociv")]
    city, name = st.city_for_cwd(str(repos / "mono/pkg/inner"), paths)
    assert (city, name) == (st.encode_repo_id(str(repos / "mono/pkg")), "pkg")
    city, name = st.city_for_cwd(str(repos / "mono/docs"), paths)
    assert name == "mono"
    city, name = st.city_for_cwd(str(repos / "repociv"), paths)
    assert name == "repociv"


def test_city_for_cwd_is_component_wise(repos):
    # /w/repociv must not claim /w/repociv-old just because the string is a prefix.
    city, name = st.city_for_cwd(str(repos / "repociv-old"), [str(repos / "repociv")])
    assert (city, name) == (st.CAPITAL_ID, "")


def test_city_for_cwd_falls_back_to_capital(repos):
    assert st.city_for_cwd("/somewhere/else", [str(repos / "repociv")]) == (st.CAPITAL_ID, "")
    assert st.city_for_cwd("", [str(repos / "repociv")]) == (st.CAPITAL_ID, "")
    assert st.city_for_cwd(str(repos / "repociv"), []) == (st.CAPITAL_ID, "")


def test_repociv_itself_is_the_capital(repos):
    home = str(repos / "repociv")
    # Not selected (the workspace scan never makes RepoCiv a city) → capital, named.
    assert st.city_for_cwd(home + "/src", [], home_repo=home) == (st.CAPITAL_ID, "repociv")
    # A selected repo nested deeper still wins by longest prefix.
    nested = str(repos / "repociv/src")
    city, name = st.city_for_cwd(nested, [nested], home_repo=home)
    assert (city, name) == (st.encode_repo_id(nested), "src")


def test_unselected_git_repo_is_sent_for_the_client_to_resolve(repos):
    (repos / "mono/.git").mkdir()
    city, name = st.city_for_cwd(str(repos / "mono/pkg/inner"), [str(repos / "repociv")])
    assert (city, name) == (st.encode_repo_id(str(repos / "mono")), "mono")
    (repos / "repociv-old/.git").write_text("gitdir: /elsewhere\n")  # worktree-style
    assert st.city_for_cwd(str(repos / "repociv-old"), [])[1] == "repociv-old"


def test_city_for_cwd_through_symlink(repos, tmp_path):
    link = tmp_path / "link"
    os.symlink(repos / "repociv", link)
    city, name = st.city_for_cwd(str(link / "src"), [str(repos / "repociv")])
    # The id is built from the selected path as given (what the frontend encodes).
    assert (city, name) == (st.encode_repo_id(str(repos / "repociv")), "repociv")


def test_selected_repo_paths_reads_all_roots(tmp_path, monkeypatch):
    state = tmp_path / "state.json"
    state.write_text(json.dumps({
        "version": 1,
        "activeRoot": "/w",
        "roots": {"/w": {"selectedRepoPaths": ["/w/a", 3]}, "/l": {"selectedRepoPaths": ["/l/b"]},
                  "/x": "junk"},
    }))
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state))
    assert st.selected_repo_paths() == ["/w/a", "/l/b"]


def test_unit_mapping():
    assert st.unit_id_for("claude-code", "5805ab57-15ab-48a6") == "ext-claude-code-5805ab57"
    assert st.unit_id_for("Open Code!", "abc") == "ext-open-code-abc"
    assert st.unit_type_for("claude-code") == "claude"
    assert st.unit_type_for("codex") == "codex"
    assert st.unit_type_for("cursor") == "scout"  # 'cursor' is not in the bridgeSchema picklist


# ─── Lifecycle ───────────────────────────────────────────────────────────────
def test_spawn_once_then_idle_then_despawn(repos):
    suv, clock, sent = FakeSuv(), Clock(), []
    repo = str(repos / "repociv")
    suv.sessions = _sessions_json(_session("5805ab57-aaaa", cwd=repo + "/src"))
    t = _tracker([repo], suv, clock, sent)

    t.poll_once()
    assert _types(sent) == ["unit_spawn", "unit_state"]
    spawn = sent[0]
    assert spawn == {
        "type": "unit_spawn",
        "unit": "ext-claude-code-5805ab57",
        "civ": "capital",
        "hex": [0, 0],
        "unitType": "claude",
        "mission": "claude-code · claude-opus-5",
        "cityId": st.encode_repo_id(repo),
        "ephemeral": True,
    }
    assert sent[1] == {"type": "unit_state", "unit": "ext-claude-code-5805ab57", "state": "working"}

    # Same data, next cycle: nothing new.
    sent.clear()
    clock.ms += 30_000
    t.poll_once()
    assert sent == []

    # Activity ages past the working threshold → idle, once.
    clock.ms = NOW_MS + 3 * MIN
    t.poll_once()
    t.poll_once()
    assert sent == [{"type": "unit_state", "unit": "ext-claude-code-5805ab57", "state": "idle"}]

    # Past the window → despawn, once.
    sent.clear()
    clock.ms = NOW_MS + 11 * MIN
    t.poll_once()
    t.poll_once()
    assert sent == [{"type": "unit_despawn", "unit": "ext-claude-code-5805ab57"}]
    assert t.agents() == []


def test_old_sessions_never_spawn(repos):
    suv, clock, sent = FakeSuv(), Clock(), []
    suv.sessions = _sessions_json(_session("old00000", last_ms=NOW_MS - 60 * MIN))
    _tracker([str(repos / "repociv")], suv, clock, sent).poll_once()
    assert sent == []


def test_live_heartbeat_keeps_long_turn_working(repos):
    """Suvadu freezes last_activity_at mid-turn; the history heartbeat refreshes it."""
    suv, clock, sent = FakeSuv(), Clock(), []
    repo = str(repos / "repociv")
    suv.sessions = _sessions_json(_session("longturn", cwd=repo, last_ms=NOW_MS - 30 * MIN))
    suv.history = _history_line("claude-longturn", NOW_MS - 20_000, cwd=repo)
    t = _tracker([repo], suv, clock, sent)
    t.poll_once()
    assert _types(sent) == ["unit_spawn", "unit_state"]
    assert sent[1]["state"] == "working"
    assert "--executor" in suv.calls[1] and "agent" in suv.calls[1]


def test_history_only_session_keeps_unit_when_imported(repos):
    """A session not imported yet spawns from its heartbeat; the import must not respawn it."""
    suv, clock, sent = FakeSuv(), Clock(), []
    repo = str(repos / "repociv")
    suv.history = _history_line("claude-5805ab57-15ab-48a6-b622-3e6ca0c69981", NOW_MS, cwd=repo)
    t = _tracker([repo], suv, clock, sent)
    t.poll_once()
    assert sent[0]["unit"] == "ext-claude-code-5805ab57"
    assert sent[0]["mission"] == "claude-code"  # model unknown until import

    sent.clear()
    suv.sessions = _sessions_json(_session("5805ab57-15ab-48a6-b622-3e6ca0c69981", cwd=repo))
    t.poll_once()
    assert sent == []
    assert t.agents()[0]["mission"] == "claude-code · claude-opus-5"


def test_city_change_respawns_in_new_city(repos):
    suv, clock, sent = FakeSuv(), Clock(), []
    a, b = str(repos / "repociv"), str(repos / "mono")
    suv.sessions = _sessions_json(_session("mover000", cwd=a))
    t = _tracker([a, b], suv, clock, sent)
    t.poll_once()
    sent.clear()
    suv.sessions = _sessions_json(_session("mover000", cwd=b + "/docs"))
    t.poll_once()
    assert _types(sent) == ["unit_despawn", "unit_spawn", "unit_state"]
    assert sent[1]["cityId"] == st.encode_repo_id(b)


def test_unmatched_cwd_goes_to_capital(repos):
    suv, clock, sent = FakeSuv(), Clock(), []
    suv.sessions = _sessions_json(_session("elsewhere", cwd="/tmp/scratch"), )
    _tracker([str(repos / "repociv")], suv, clock, sent).poll_once()
    assert sent[0]["cityId"] == "capital"


def test_several_agents_each_get_one_unit(repos):
    suv, clock, sent = FakeSuv(), Clock(), []
    repo = str(repos / "repociv")
    suv.sessions = _sessions_json(
        _session("aaaaaaaa", cwd=repo),
        _session("bbbbbbbb", agent="codex", cwd=repo, model="gpt-5-codex"),
        _session("cccccccc", agent="cursor", cwd=repo, model=""),
    )
    t = _tracker([repo], suv, clock, sent)
    t.poll_once()
    t.poll_once()
    spawns = [e for e in sent if e["type"] == "unit_spawn"]
    assert sorted((e["unit"], e["unitType"]) for e in spawns) == [
        ("ext-claude-code-aaaaaaaa", "claude"),
        ("ext-codex-bbbbbbbb", "codex"),
        ("ext-cursor-cccccccc", "scout"),
    ]


# ─── Fail-open ───────────────────────────────────────────────────────────────
def test_run_suv_error_codes(tmp_path):
    with pytest.raises(st.SuvaduError, match="binary_not_found"):
        st.run_suv(str(tmp_path / "nope"), ["agent", "sessions"], 1)
    with pytest.raises(st.SuvaduError, match="exit_1"):
        st.run_suv("false", [], 1)
    with pytest.raises(st.SuvaduError, match="timeout"):
        st.run_suv("sleep", ["5"], 0.1)
    assert st.run_suv("echo", ["{}"], 1).strip() == "{}"


def test_missing_binary_fails_open_and_reports():
    sent: list[dict[str, Any]] = []
    config = st.TrackerConfig(bin_path="/nonexistent/suv")
    t = st.ExternalAgentTracker(config, send=sent.append, repo_paths=lambda: [])
    t.poll_once()  # must not raise
    assert sent == []
    status = t.status()
    assert (status["ok"], status["error"], status["units"]) == (False, "binary_not_found", 0)


def test_failure_ages_out_units_already_shown(repos):
    suv, clock, sent = FakeSuv(), Clock(), []
    repo = str(repos / "repociv")
    suv.sessions = _sessions_json(_session("aging000", cwd=repo))
    t = _tracker([repo], suv, clock, sent)
    t.poll_once()
    sent.clear()

    suv.fail_sessions = st.SuvaduError("timeout")
    clock.ms += 30_000
    t.poll_once()
    assert sent == [] and t.status()["error"] == "timeout"
    clock.ms = NOW_MS + 11 * MIN
    t.poll_once()
    assert sent == [{"type": "unit_despawn", "unit": "ext-claude-code-aging000"}]


def test_history_failure_is_non_fatal(repos):
    suv, clock, sent = FakeSuv(), Clock(), []
    suv.sessions = _sessions_json(_session("okokokok", cwd=str(repos / "repociv")))
    suv.fail_history = st.SuvaduError("exit_2")
    t = _tracker([str(repos / "repociv")], suv, clock, sent)
    t.poll_once()
    assert _types(sent) == ["unit_spawn", "unit_state"]
    assert (t.status()["ok"], t.status()["heartbeat"]) == (True, False)


def test_send_and_repo_errors_do_not_escape(repos):
    suv, clock = FakeSuv(), Clock()
    suv.sessions = _sessions_json(_session("boom0000"))

    def bad_send(_evt: dict[str, Any]) -> None:
        raise RuntimeError("socket gone")

    def bad_repos() -> list[str]:
        raise OSError("state file unreadable")

    t = st.ExternalAgentTracker(
        st.TrackerConfig(bin_path="suv"), send=bad_send, repo_paths=bad_repos, run=suv, clock=clock
    )
    t.poll_once()
    assert t.agents()[0]["cityId"] == "capital"


# ─── Read side / privacy ─────────────────────────────────────────────────────
def test_snapshot_is_metadata_only(repos):
    suv, clock, sent = FakeSuv(), Clock(), []
    repo = str(repos / "repociv")
    suv.sessions = _sessions_json(_session("privacy0", cwd=repo + "/src"))
    suv.history = _history_line("claude-privacy0", NOW_MS, cwd=repo + "/src")
    t = _tracker([repo], suv, clock, sent)
    t.poll_once()
    [agent] = t.agents()
    assert set(agent) == {
        "unit", "unitType", "cityId", "state", "agent", "model", "repo", "mission",
        "firstActivityAt", "lastActivityAt", "commandCount", "eventCount", "totalTokens",
    }
    assert agent["repo"] == "repociv" and agent["state"] == "working"
    blob = json.dumps({"agents": t.agents(), "events": sent})
    assert "id_ed25519" not in blob  # command text
    assert "/src" not in blob  # raw cwd
    assert "privacy0" in agent["unit"]


def test_module_snapshot_before_start():
    assert st.status()["enabled"] in (False, True)
    snap = st.snapshot()
    assert "agents" in snap and "status" in snap


def test_start_disabled_by_env(monkeypatch):
    monkeypatch.setenv("REPOCIV_EXT_AGENTS", "0")
    assert st.start(send=lambda _e: None) is False


def test_config_from_env(monkeypatch):
    monkeypatch.setenv("SUVADU_BIN", "~/bin/suv")
    monkeypatch.setenv("REPOCIV_EXT_AGENTS_WINDOW_MIN", "5")
    monkeypatch.setenv("REPOCIV_EXT_AGENTS_WORKING_MIN", "9")
    monkeypatch.setenv("REPOCIV_EXT_AGENTS_POLL_S", "bogus")
    cfg = st.TrackerConfig.from_env()
    assert cfg.bin_path == os.path.expanduser("~/bin/suv")
    assert cfg.window_s == 300 and cfg.working_s == 300  # working clamped to window
    assert cfg.poll_s == 30.0


def test_external_agents_route_registered():
    from server.routes import registry
    from server.routes.core import get_external_agents

    assert registry.GET_EXACT["/api/external-agents"] is get_external_agents
    status, body = get_external_agents({"params": {}})
    assert status == 200 and "agents" in body
