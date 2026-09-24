"""Hermes state.db → external agents. Every database here is synthetic (tmp_path)."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from server import hermes_sessions as hs
from server import suvadu_tracker as st

NOW = 1_789_800_000.0  # seconds, like Hermes
MIN = 60.0

_SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
    message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, title TEXT,
    cwd TEXT, git_repo_root TEXT, profile_name TEXT, last_activity_at REAL,
    hidden INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_effective_activity
    ON sessions(COALESCE(last_activity_at, started_at) DESC, started_at DESC);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0,
    display_kind TEXT, _compressed_summary INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
"""

_LEGACY_SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, ended_at REAL, message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT, tool_name TEXT, timestamp REAL NOT NULL
);
"""


class Home:
    """A fake ~/.hermes: root state.db plus profiles/<name>/state.db."""

    def __init__(self, root: Path) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def db(self, profile: str = "default", *, schema: str = _SCHEMA, journal: str = "wal") -> Path:
        path = self.root / "state.db" if profile == "default" else self.root / "profiles" / profile / "state.db"
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(path)
            conn.execute(f"PRAGMA journal_mode={journal}")
            conn.executescript(schema)
            conn.commit()
            conn.close()
        return path

    def session(self, sid: str, *, profile: str = "default", source: str = "cli", started: float = NOW - 5 * MIN,
                last: float | None = NOW - 1 * MIN, ended: float | None = None, end_reason: str | None = None,
                parent: str | None = None, cwd: str | None = None, repo_root: str | None = None,
                model: str = "meituan/longcat-2.0:free", title: str | None = None, hidden: int = 0,
                tools: int = 3, messages: int = 6) -> None:
        conn = sqlite3.connect(self.db(profile))
        conn.execute(
            "INSERT INTO sessions (id, source, model, parent_session_id, started_at, ended_at, end_reason,"
            " message_count, tool_call_count, input_tokens, output_tokens, title, cwd, git_repo_root,"
            " profile_name, last_activity_at, hidden) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, source, model, parent, started, ended, end_reason, messages, tools, 1000, 234, title, cwd,
             repo_root, profile, last, hidden),
        )
        conn.commit()
        conn.close()

    def message(self, sid: str, role: str, content: str | None, ts: float, *, profile: str = "default",
                tool_name: str | None = None, tool_calls: str | None = None, **extra: Any) -> None:
        conn = sqlite3.connect(self.db(profile))
        cols = ["session_id", "role", "content", "timestamp", "tool_name", "tool_calls", *extra]
        conn.execute(
            f"INSERT INTO messages ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
            (sid, role, content, ts, tool_name, tool_calls, *extra.values()),
        )
        conn.commit()
        conn.close()


class Clock:
    def __init__(self, s: float = NOW) -> None:
        self.s = s

    def __call__(self) -> float:
        return self.s


@pytest.fixture()
def home(tmp_path: Path) -> Home:
    return Home(tmp_path / "hermes")


@pytest.fixture()
def repos(tmp_path: Path) -> Path:
    w = tmp_path / "w"
    for rel in ("alpha/src", "beta"):
        (w / rel).mkdir(parents=True)
    return w


def _source(home: Home, clock: Clock, *, owned: frozenset[str] = frozenset(), **kw: Any) -> hs.HermesSource:
    return hs.HermesSource(str(home.root), owned_ids=lambda: owned, clock=clock, **kw)


def _tracker(source: hs.HermesSource, clock: Clock, sent: list[dict[str, Any]],
             repo_paths: list[str] | None = None) -> st.ExternalAgentTracker:
    config = st.TrackerConfig(bin_path="suv", window_s=600, working_s=120)
    return st.ExternalAgentTracker(
        config, send=sent.append, repo_paths=lambda: repo_paths or [], clock=clock, sources=[source]
    )


def _by_native(obs: list[st.Observation]) -> dict[str, st.Observation]:
    return {o.native_id: o for o in obs}


# ─── Liveness ────────────────────────────────────────────────────────────────
def test_liveness_is_last_activity_not_ended_at(home: Home) -> None:
    clock = Clock()
    home.session("20260919_060000_live01", last=NOW - 1 * MIN)
    home.session("20260919_010000_stale1", started=NOW - 5 * 3600, last=NOW - 4 * 3600)  # never closed
    home.session("20260917_010000_old001", started=NOW - 40 * 3600, last=NOW - 30 * 3600)
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent)
    t.poll_once()
    assert [e["type"] for e in sent] == ["unit_spawn", "unit_state"]
    rows = {r["sessionId"]: r for r in t.sessions()}
    assert set(rows) == {"hermes-default-20260919_060000_live01", "hermes-default-20260919_010000_stale1"}
    assert rows["hermes-default-20260919_060000_live01"]["state"] == "working"
    stale = rows["hermes-default-20260919_010000_stale1"]
    assert (stale["active"], stale["state"], stale["unit"]) == (False, "inactive", None)


def test_newest_message_beats_a_lagging_last_activity(home: Home) -> None:
    clock = Clock()
    home.session("20260919_060000_lag001", last=NOW - 11 * MIN)  # outside the window…
    home.message("20260919_060000_lag001", "assistant", "still here", NOW - 20)  # …but talking
    [obs] = _source(home, clock).poll()
    assert obs.last_activity_ms == int((NOW - 20) * 1000)


def test_closed_session_leaves_the_map_at_once(home: Home) -> None:
    clock = Clock()
    home.session("20260919_060000_bye001", last=NOW - 1 * MIN)
    sent: list[dict[str, Any]] = []
    src = _source(home, clock)
    t = _tracker(src, clock, sent)
    t.poll_once()
    unit = sent[0]["unit"]
    sent.clear()
    conn = sqlite3.connect(home.db())
    conn.execute("UPDATE sessions SET ended_at = ?, end_reason = 'cli_close' WHERE id = '20260919_060000_bye001'",
                 (NOW - 30,))
    conn.commit()
    conn.close()
    clock.s += 30
    t.poll_once()
    assert sent == [{"type": "unit_despawn", "unit": unit}]
    [row] = t.sessions()
    assert (row["active"], row["state"]) == (False, "inactive")


def test_resumed_after_close_is_live_again(home: Home) -> None:
    clock = Clock()
    home.session("20260919_050000_resume", started=NOW - 3600, ended=NOW - 1800, end_reason="cli_close",
                 last=NOW - 30)
    [obs] = _source(home, clock).poll()
    assert obs.ended is False


def test_despawn_when_the_window_passes(home: Home) -> None:
    clock = Clock()
    home.session("20260919_060000_quiet1", last=NOW - 1 * MIN)
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent)
    t.poll_once()
    unit = sent[0]["unit"]
    clock.s += 3 * MIN
    t.poll_once()
    assert sent[-1] == {"type": "unit_state", "unit": unit, "state": "idle"}
    clock.s = NOW + 10 * MIN
    t.poll_once()
    assert sent[-1] == {"type": "unit_despawn", "unit": unit}


# ─── Mapping ─────────────────────────────────────────────────────────────────
def test_city_from_repo_root_then_cwd(home: Home, repos: Path) -> None:
    clock = Clock()
    alpha, beta = str(repos / "alpha"), str(repos / "beta")
    home.session("20260919_060000_inalph", cwd=alpha + "/src")
    home.session("20260919_060001_rootwi", cwd="/tmp", repo_root=beta)
    home.session("20260919_060002_nocwd0")  # desktop sessions often have none
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent, repo_paths=[alpha, beta])
    t.poll_once()
    cities = {e["unit"]: e["cityId"] for e in sent if e["type"] == "unit_spawn"}
    by_native = {r["sessionId"].rsplit("-", 1)[-1]: r for r in t.sessions()}
    assert by_native["20260919_060000_inalph"]["cityId"] == st.encode_repo_id(alpha)
    assert by_native["20260919_060001_rootwi"]["cityId"] == st.encode_repo_id(beta)
    assert by_native["20260919_060002_nocwd0"]["cityId"] == "capital"
    assert sorted(cities.values()) == sorted([st.encode_repo_id(alpha), st.encode_repo_id(beta), "capital"])


def test_cwd_derived_from_tool_paths_when_the_row_has_none(home: Home, repos: Path) -> None:
    clock = Clock()
    alpha, beta = str(repos / "alpha"), str(repos / "beta")
    (Path(alpha) / ".git").mkdir()  # subdirs aggregate under their repo root
    derived, lone = "20260919_060000_derivd", "20260919_060001_lone00"
    home.session(derived, source="desktop")  # desktop rows carry no cwd
    for rel in ("src/one.py", "src/two.py", "README.md"):
        home.message(derived, "assistant", "", NOW - 120,
                     tool_calls=json.dumps([{"function": {"name": "read_file", "arguments":
                                                          json.dumps({"path": f"{alpha}/{rel}"})}}]))
    home.session(lone, source="desktop")
    home.message(lone, "assistant", "", NOW - 120,
                 tool_calls=json.dumps([{"function": {"name": "read_file",
                                                      "arguments": json.dumps({"path": f"{beta}/solo.py"})}}]))
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent, repo_paths=[alpha, beta])
    t.poll_once()
    by_native = {r["sessionId"].rsplit("-", 1)[-1]: r for r in t.sessions()}
    assert by_native[derived]["cityId"] == st.encode_repo_id(alpha)
    assert by_native[derived]["repo"] == "alpha"
    assert by_native[lone]["cityId"] == "capital"  # one mention is a passing glance


def test_cwd_derived_from_terminal_cd_when_the_row_has_none(home: Home, repos: Path) -> None:
    clock = Clock()
    alpha, beta = str(repos / "alpha"), str(repos / "beta")
    sid = "20260919_060000_cd0001"
    home.session(sid, source="cli")
    for _ in range(3):
        home.message(sid, "assistant", "", NOW - 120,
                     tool_calls=json.dumps([{"function": {"name": "terminal", "arguments":
                                                          json.dumps({"command": f"cd {beta} && git status"})}}]))
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent, repo_paths=[alpha, beta])
    t.poll_once()
    by_native = {r["sessionId"].rsplit("-", 1)[-1]: r for r in t.sessions()}
    assert by_native[sid]["cityId"] == st.encode_repo_id(beta)


def _call(home: Home, sid: str, name: str, ts: float = NOW - 120, **args: Any) -> None:
    home.message(sid, "assistant", "", ts,
                 tool_calls=json.dumps([{"function": {"name": name, "arguments": json.dumps(args)}}]))


def test_activity_beats_a_launch_cwd_outside_any_repo(home: Home, repos: Path, tmp_path: Path) -> None:
    # Live case (2026-09-24): `hermes` launched from ~ keeps cwd=/home/<user>,
    # and every tool call after the first look around lands in one repo.
    clock = Clock()
    alpha, beta = str(repos / "alpha"), str(repos / "beta")
    launch = tmp_path / "home"
    launch.mkdir()
    sid = "20260924_192345_88e905"
    home.session(sid, source="cli", cwd=str(launch))
    for _ in range(4):
        _call(home, sid, "search_files", ts=NOW - 300, path=str(launch), pattern="*bot*")
    for name in ("README.md", "bot.ts", "package.json"):
        _call(home, sid, "read_file", path=f"{beta}/{name}")
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent, repo_paths=[alpha, beta])
    t.poll_once()
    # One unit, in beta: the folder outside any repo neither pins it nor clones it.
    assert [e["cityId"] for e in sent if e["type"] == "unit_spawn"] == [st.encode_repo_id(beta)]


def test_one_unit_where_the_session_works_now(home: Home, repos: Path) -> None:
    clock = Clock()
    alpha, beta = str(repos / "alpha"), str(repos / "beta")
    sid = "20260919_060000_moved0"
    home.session(sid, source="desktop")
    for i in range(6):
        _call(home, sid, "read_file", ts=NOW - 600 + i, path=f"{alpha}/src/f{i}.py")
    for i in range(8):
        _call(home, sid, "patch", ts=NOW - 120 + i, path=f"{beta}/g{i}.py")
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent, repo_paths=[alpha, beta])
    t.poll_once()
    spawns = [(e["unit"], e["cityId"]) for e in sent if e["type"] == "unit_spawn"]
    assert spawns == [(hs.unit_id_for("default", sid), st.encode_repo_id(beta))]
    assert [r["repo"] for r in t.sessions()] == ["beta"]


def test_the_unit_follows_the_session_to_its_next_repo(home: Home, repos: Path) -> None:
    clock = Clock()
    alpha, beta = str(repos / "alpha"), str(repos / "beta")
    sid = "20260919_060000_walker"
    home.session(sid, source="desktop")
    for i in range(4):
        _call(home, sid, "read_file", ts=NOW - 300 + i, path=f"{alpha}/src/f{i}.py")
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent, repo_paths=[alpha, beta])
    t.poll_once()
    unit = hs.unit_id_for("default", sid)
    assert [e["cityId"] for e in sent if e["type"] == "unit_spawn"] == [st.encode_repo_id(alpha)]
    sent.clear()
    for i in range(10):
        _call(home, sid, "terminal", ts=NOW - 60 + i, command=f"cd {beta} && make t{i}")
    t.poll_once()
    assert sent == []  # its row did not change: last poll's folders are reused
    conn = sqlite3.connect(home.db())
    conn.execute("UPDATE sessions SET message_count = message_count + 10 WHERE id = ?", (sid,))
    conn.commit()  # as Hermes does on every insert
    conn.close()
    t.poll_once()
    # It moves (same unit); no clone stays behind in alpha.
    assert [(e["type"], e.get("cityId")) for e in sent if e["type"] != "unit_state"] == [
        ("unit_despawn", None), ("unit_spawn", st.encode_repo_id(beta))]
    assert {e["unit"] for e in sent} == {unit}


def test_folders_without_git_count_toward_their_city(home: Home, repos: Path) -> None:
    # A selected city with no .git (job-search-cristobal): mentions in its
    # subfolders add up to one place instead of one "repo" per subfolder.
    clock = Clock()
    beta = repos / "beta"
    for sub in ("a", "b", "c"):
        (beta / sub).mkdir()
    sid = "20260923_215936_54a804"
    home.session(sid, source="desktop")
    for sub in ("a", "b", "c"):
        _call(home, sid, "write_file", path=f"{beta}/{sub}/notes.md")
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent, repo_paths=[str(repos / "alpha"), str(beta)])
    t.poll_once()
    assert [e["cityId"] for e in sent if e["type"] == "unit_spawn"] == [st.encode_repo_id(str(beta))]


def test_unit_id_label_and_type(home: Home) -> None:
    clock = Clock()
    home.session("20260919_061733_615e9a", source="desktop")
    home.session("20260919_061733_aaaaaa", source="tui")  # same date prefix, other unit
    home.session("20260919_070000_lexo01", profile="lexo-alpha", model="anthropic/claude-opus-5")
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent)
    t.poll_once()
    spawns = {e["mission"]: e for e in sent if e["type"] == "unit_spawn"}
    desktop = spawns["default · longcat-2.0:free · desktop"]
    digest = hashlib.sha1(b"default\x0020260919_061733_615e9a").hexdigest()[:8]
    assert desktop["unit"] == f"ext-hermes-{digest}" and desktop["unitType"] == "hero"
    assert desktop["ephemeral"] is True
    assert spawns["lexo-alpha · claude-opus-5 · cli"]["unitType"] == "lexo"
    assert len({e["unit"] for e in spawns.values()}) == 3
    t.poll_once()  # stable across polls: nothing new
    assert len([e for e in sent if e["type"] == "unit_spawn"]) == 3


def test_compression_chain_keeps_one_unit(home: Home) -> None:
    clock = Clock()
    home.session("20260919_050000_seg001", started=NOW - 3600, ended=NOW - 10 * MIN, end_reason="compression",
                 last=NOW - 10 * MIN)
    home.session("20260919_055000_seg002", parent="20260919_050000_seg001", started=NOW - 10 * MIN,
                 last=NOW - 30)
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent)
    t.poll_once()
    [spawn] = [e for e in sent if e["type"] == "unit_spawn"]
    assert spawn["unit"] == hs.unit_id_for("default", "20260919_050000_seg001")
    [row] = t.sessions()
    assert row["sessionId"] == "hermes-default-20260919_050000_seg001"
    assert row["firstActivityAt"] == int((NOW - 3600) * 1000)
    assert row["subagent"] is False


def test_a_child_fresh_from_compression_stays_in_its_repo(home: Home, repos: Path) -> None:
    clock = Clock()
    alpha = str(repos / "alpha")
    home.session("20260919_050000_seg001", source="desktop", started=NOW - 3600, ended=NOW - 10 * MIN,
                 end_reason="compression", last=NOW - 10 * MIN)
    for i in range(5):
        _call(home, "20260919_050000_seg001", "read_file", ts=NOW - 15 * MIN + i, path=f"{alpha}/src/f{i}.py")
    home.session("20260919_055000_seg002", source="desktop", parent="20260919_050000_seg001",
                 started=NOW - 10 * MIN, last=NOW - 30)
    _call(home, "20260919_055000_seg002", "read_file", path=f"{alpha}/src/next.py")
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent, repo_paths=[alpha])
    t.poll_once()
    [spawn] = [e for e in sent if e["type"] == "unit_spawn"]
    assert spawn["cityId"] == st.encode_repo_id(alpha)


def test_sections_cron_gateway_and_subagents(home: Home) -> None:
    clock = Clock()
    home.session("cron_7c6ef7cbe273_20260919_061053", source="cron")
    home.session("20260919_060000_tele01", source="telegram")
    home.session("20260919_060000_api001", source="api_server")
    home.session("20260919_060000_parent", source="cli")
    home.session("20260919_060100_child1", source="subagent", parent="20260919_060000_parent")
    home.session("20260919_060100_cronsb", source="subagent", parent="cron_7c6ef7cbe273_20260919_061053")
    home.session("20260919_060000_kanban", source="kanban")
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent)
    t.poll_once()
    rows = {r["sessionId"].split("-", 2)[2]: r for r in t.sessions()}
    assert rows["cron_7c6ef7cbe273_20260919_061053"]["section"] == "cron"
    assert rows["20260919_060100_cronsb"]["section"] == "cron"
    assert rows["20260919_060000_tele01"]["section"] == "gateway"
    assert rows["20260919_060000_api001"]["section"] == "gateway"
    for sid in ("20260919_060000_parent", "20260919_060100_child1", "20260919_060000_kanban"):
        assert rows[sid]["section"] == "" and rows[sid]["unit"]
    assert rows["20260919_060100_child1"]["subagent"] is True
    # Panel-only sessions: live state, but no unit on the map.
    cron = rows["cron_7c6ef7cbe273_20260919_061053"]
    assert (cron["active"], cron["state"], cron["unit"]) == (True, "working", None)
    assert len([e for e in sent if e["type"] == "unit_spawn"]) == 3


# ─── Dedupe ──────────────────────────────────────────────────────────────────
def test_repociv_missions_and_their_subagents_are_skipped(home: Home, tmp_path: Path) -> None:
    clock = Clock()
    home.session("20260919_060000_tool01", source="tool", profile="lexo-alpha")
    home.session("20260919_060100_toolsb", source="subagent", parent="20260919_060000_tool01", profile="lexo-alpha")
    home.session("20260919_060000_resume", source="cli", profile="lexo-alpha")  # resumed by id
    home.session("20260919_060000_user01", source="cli", profile="lexo-alpha")
    state = tmp_path / "repociv" / "hermes-sessions.json"
    state.parent.mkdir()
    state.write_text(json.dumps({"lexo-alpha|lexo|capital": "20260919_060000_resume"}))
    src = hs.HermesSource(str(home.root), clock=clock, owned_ids=lambda: hs.repociv_session_ids(str(state)))
    assert [o.native_id for o in src.poll()] == ["20260919_060000_user01"]


def test_repociv_sessions_file_follows_config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path))
    (tmp_path / "hermes-sessions.json").write_text(json.dumps({"a|b|c": "x1", "bad": 3}))
    assert hs.repociv_session_ids() == frozenset({"x1"})
    (tmp_path / "hermes-sessions.json").write_text("not json")
    assert hs.repociv_session_ids() == frozenset()


def test_hidden_sessions_are_skipped(home: Home) -> None:
    home.session("20260919_060000_hidden", hidden=1)
    assert _source(home, Clock()).poll() == []


# ─── Profiles ────────────────────────────────────────────────────────────────
def test_reads_root_and_profiles_with_a_denylist(home: Home) -> None:
    clock = Clock()
    home.session("20260919_060000_root01")
    home.session("20260919_060000_cobalt", profile="cobalt")
    home.session("20260919_060000_lawyer", profile="lexo-lawyer")
    src = _source(home, clock, exclude=frozenset({"lexo-lawyer"}))
    got = {(o.profile, o.native_id) for o in src.poll()}
    assert got == {("default", "20260919_060000_root01"), ("cobalt", "20260919_060000_cobalt")}
    assert src.status() == {"databases": 2, "dbErrors": {}}
    assert src.reads_profile("cobalt") and not src.reads_profile("lexo-lawyer")


def test_old_schema_without_activity_columns(home: Home) -> None:
    home.db("worker", schema=_LEGACY_SCHEMA)
    conn = sqlite3.connect(home.db("worker"))
    conn.execute("INSERT INTO sessions (id, source, started_at) VALUES ('20260919_060000_legacy', 'cli', ?)",
                 (NOW - 60,))
    conn.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES "
                 "('20260919_060000_legacy', 'user', 'hola', ?)", (NOW - 50,))
    conn.commit()
    conn.close()
    src = _source(home, Clock())
    [obs] = src.poll()
    assert obs.profile == "worker" and obs.last_activity_ms == int((NOW - 50) * 1000)
    body = src.chat(obs, limit=10)
    assert [m["text"] for m in body["messages"]] == ["hola"]


# ─── Fail-open ───────────────────────────────────────────────────────────────
def test_missing_hermes_home_fails_open(tmp_path: Path) -> None:
    clock = Clock()
    sent: list[dict[str, Any]] = []
    src = hs.HermesSource(str(tmp_path / "nope"), owned_ids=frozenset, clock=clock)
    t = _tracker(src, clock, sent)
    t.poll_once()  # must not raise
    status = t.status()
    assert sent == [] and (status["ok"], status["error"]) == (False, "hermes_not_found")
    assert status["sources"]["hermes"]["error"] == "hermes_not_found"


def test_missing_root_db_is_reported_but_profiles_still_read(home: Home) -> None:
    home.session("20260919_060000_cobalt", profile="cobalt")
    src = _source(home, Clock())
    assert [o.profile for o in src.poll()] == ["cobalt"]
    assert src.status()["dbErrors"] == {"default": "db_not_found"}


def test_locked_db_keeps_last_units_and_reports(home: Home) -> None:
    clock = Clock()
    home.db(journal="delete")  # rollback journal: an exclusive lock blocks readers
    home.session("20260919_060000_lock01")
    sent: list[dict[str, Any]] = []
    src = _source(home, clock)
    t = _tracker(src, clock, sent)
    t.poll_once()
    unit = sent[0]["unit"]
    sent.clear()

    blocker = sqlite3.connect(home.db(), timeout=0)
    blocker.execute("BEGIN EXCLUSIVE")
    try:
        clock.s += 30
        t.poll_once()
        assert sent == []  # the unit stays while its last activity is fresh
        assert t.status()["error"] == "locked"
        clock.s = NOW + 11 * MIN
        t.poll_once()
        assert sent == [{"type": "unit_despawn", "unit": unit}]
    finally:
        blocker.rollback()
        blocker.close()


def test_corrupt_db_is_reported(home: Home) -> None:
    home.root.mkdir(parents=True, exist_ok=True)
    (home.root / "state.db").write_bytes(b"definitely not sqlite" * 100)
    with pytest.raises(st.SourceError, match="corrupt"):
        _source(home, Clock()).poll()


def test_one_failing_source_does_not_hide_the_other(home: Home) -> None:
    clock = Clock()
    home.session("20260919_060000_both01")

    def broken_suv(_args: list[str]) -> str:
        raise st.SuvaduError("binary_not_found")

    sent: list[dict[str, Any]] = []
    t = st.ExternalAgentTracker(
        st.TrackerConfig(bin_path="suv"), send=sent.append, repo_paths=lambda: [], clock=clock,
        sources=[st.SuvaduSource(broken_suv, clock), _source(home, clock)],
    )
    t.poll_once()
    assert [e["type"] for e in sent] == ["unit_spawn", "unit_state"]
    status = t.status()
    assert (status["ok"], status["error"]) == (False, "binary_not_found")
    assert status["sources"]["hermes"]["ok"] is True and status["sources"]["suvadu"]["ok"] is False


# ─── Read-only ───────────────────────────────────────────────────────────────
def test_never_writes_and_uses_the_activity_index(home: Home) -> None:
    clock = Clock()
    path = home.db(journal="delete")
    home.session("20260919_060000_ro0001", title="t")
    home.message("20260919_060000_ro0001", "user", "hola", NOW - 60)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    src = _source(home, clock)
    [obs] = src.poll()
    src.chat(obs, limit=10)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    assert not Path(str(path) + "-journal").exists()

    conn = hs.connect_ro(str(path), 1.0)
    plan = conn.execute(
        f"EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE {hs._ACTIVITY} >= ? "
        f"ORDER BY {hs._ACTIVITY} DESC LIMIT 5", (NOW,)
    ).fetchall()
    with pytest.raises(sqlite3.OperationalError):
        conn.execute("DELETE FROM sessions")
    conn.close()
    assert "idx_sessions_effective_activity" in " ".join(str(p[-1]) for p in plan)


# ─── Chat ────────────────────────────────────────────────────────────────────
def test_chat_text_and_tool_names_only(home: Home) -> None:
    clock = Clock()
    sid = "20260919_060000_chat01"
    home.session(sid, title="Revisar MCP")
    home.message(sid, "user", "revisa el MCP", NOW - 300)
    home.message(sid, "assistant", "", NOW - 290, tool_calls='[{"function": {"name": "terminal", '
                 '"arguments": "{\\"command\\": \\"cat ~/.ssh/id_ed25519\\"}"}}]')
    home.message(sid, "tool", "-----BEGIN OPENSSH PRIVATE KEY-----", NOW - 289, tool_name="terminal")
    home.message(sid, "tool", "secret output", NOW - 288, tool_name="read_file")
    home.message(sid, "assistant", "x" * 5000, NOW - 280)
    home.message(sid, "assistant", "", NOW - 279, display_kind="hidden")
    home.message(sid, "user", "background done: token=abc", NOW - 270, display_kind="process_complete")
    home.message(sid, "user", "[CONTEXT COMPACTION]", NOW - 265, _compressed_summary=1)
    home.message(sid, "user", "rewound", NOW - 262, active=0)
    home.message(sid, "user", "gracias", NOW - 260)
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent)
    t.poll_once()
    status, body = t.chat(f"hermes-default-{sid}", refresh=True)
    assert status == 200 and body["available"] is True and body["refresh"] == "ok"
    assert body["title"] == "Revisar MCP"
    msgs = body["messages"]
    assert [m["role"] for m in msgs] == ["user", "tool", "assistant", "user"]
    assert msgs[1]["tools"] == ["terminal", "read_file"] and msgs[1]["text"] == ""
    assert msgs[2]["truncated"] is True and len(msgs[2]["text"]) == 4000
    assert msgs[0] == {"role": "user", "text": "revisa el MCP", "at": int((NOW - 300) * 1000),
                       "truncated": False, "turn": None}
    blob = json.dumps(body) + json.dumps(t.sessions()) + json.dumps(t.agents()) + json.dumps(sent)
    for secret in ("OPENSSH", "secret output", "id_ed25519", "token=abc", "COMPACTION", "rewound"):
        assert secret not in blob
    assert "Revisar MCP" not in json.dumps(t.sessions()) + json.dumps(sent)  # title: on demand only


def test_chat_spans_the_compression_chain_and_pages(home: Home) -> None:
    clock = Clock()
    home.session("20260919_050000_seg001", started=NOW - 3600, ended=NOW - 600, end_reason="compression",
                 last=NOW - 600)
    home.session("20260919_055000_seg002", parent="20260919_050000_seg001", started=NOW - 600, last=NOW - 30)
    for i in range(3):
        home.message("20260919_050000_seg001", "user", f"old {i}", NOW - 3000 + i)
    for i in range(3):
        home.message("20260919_055000_seg002", "user", f"new {i}", NOW - 500 + i)
    src = _source(home, clock)
    live = next(o for o in src.poll() if o.native_id == "20260919_055000_seg002")
    body = src.chat(live, limit=80)
    assert [m["text"] for m in body["messages"]] == ["old 0", "old 1", "old 2", "new 0", "new 1", "new 2"]
    assert body["hasMore"] is False
    body = src.chat(live, limit=2)
    assert [m["text"] for m in body["messages"]] == ["new 1", "new 2"] and body["hasMore"] is True


def test_chat_of_a_subagent_does_not_leak_the_parent(home: Home) -> None:
    clock = Clock()
    home.session("20260919_060000_parent", ended=NOW - 60, end_reason="compression")
    home.session("20260919_060100_child1", source="subagent", parent="20260919_060000_parent")
    home.message("20260919_060000_parent", "user", "parent text", NOW - 200)
    home.message("20260919_060100_child1", "user", "child task", NOW - 100)
    src = _source(home, clock)
    child = next(o for o in src.poll() if o.native_id == "20260919_060100_child1")
    assert [m["text"] for m in src.chat(child, limit=10)["messages"]] == ["child task"]


def test_chat_when_the_db_vanished(home: Home) -> None:
    clock = Clock()
    home.session("20260919_060000_gone01")
    sent: list[dict[str, Any]] = []
    t = _tracker(_source(home, clock), clock, sent)
    t.poll_once()
    home.db().unlink()
    status, body = t.chat("hermes-default-20260919_060000_gone01")
    assert status == 200 and body["available"] is False and body["error"] == "db_not_found"


def test_collapse_caps_tool_names() -> None:
    rows = [("tool", None, "terminal", NOW + i) for i in range(100)]
    [group] = hs.collapse(rows)
    assert len(group["tools"]) == hs._TOOLS_MAX


# ─── Wiring ──────────────────────────────────────────────────────────────────
def test_source_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("REPOCIV_HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("REPOCIV_HERMES_PROFILES_EXCLUDE", "lexo-lawyer, curator ,")
    src = hs.source_from_env(recent_s=3600, window_s=300)
    assert src is not None and src.home == str(tmp_path)
    assert src.exclude == frozenset({"lexo-lawyer", "curator"}) and src.recent_s == 3600
    monkeypatch.setenv("REPOCIV_HERMES_SESSIONS", "0")
    assert hs.source_from_env() is None


def test_bridge_accepts_hermes_session_ids() -> None:
    from server import bridge

    for sid in ("hermes-default-20260919_061733_615e9a", "hermes-lexo-alpha-cron_7c6ef7cbe273_20260919_061053"):
        assert bridge._EXTERNAL_SESSION_RE.match(sid)


def test_covers_hermes_profile(home: Home, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = Clock()
    home.session("20260919_060000_lexo01", profile="lexo-alpha")
    t = _tracker(_source(home, clock), clock, [])
    monkeypatch.setattr(st, "_tracker", t)
    assert st.covers_hermes_profile("lexo-alpha") is False  # not polled yet
    t.poll_once()
    assert st.covers_hermes_profile("lexo-alpha") is True
    assert st.covers_hermes_profile("nyx") is False
    monkeypatch.setattr(st, "_tracker", None)
    assert st.covers_hermes_profile("lexo-alpha") is False


def test_retire_detected_lexo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from server import process_scanner as ps

    persist = tmp_path / "detected_lexo.json"
    persist.write_text(json.dumps({"123": "LEXO-abcd1234"}))
    monkeypatch.setattr(ps, "_LEXO_PERSIST_PATH", persist)
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(ps, "send_to_repociv", sent.append)
    ps.retire_detected_lexo()
    assert sent == [{"type": "unit_despawn", "unit": "LEXO-abcd1234"}]
    assert json.loads(persist.read_text()) == {}
    ps.retire_detected_lexo()
    assert len(sent) == 1
