"""Position hooks: canonical references, native identity and private metadata."""
from dataclasses import replace

import pytest

from server import agent_positions as ap
from server import suvadu_tracker as st

NOW = 1_800_000_000_000


@pytest.fixture
def workspace(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    for repo in (a, b):
        (repo / "src").mkdir(parents=True)
        (repo / ".git").mkdir()
    return a, b


def observation(native="native-session-0001", **kw):
    return st.Observation(session_id=f"claude-{native}", agent="claude-code",
                          native_id=native, cwd="/", model="model", first_activity_ms=NOW,
                          last_activity_ms=NOW, command_count=4, event_count=5,
                          total_tokens=None, **kw)


def emit(store, repo, *, cli="claude", native="native-session-0001", event="tool_use", **kw):
    return store.ingest({"cli": cli, "session_id": native, "event": event,
                         "cwd": str(repo), "authority": "tool" if event == "tool_use" else "cwd", **kw}, [str(repo)], NOW)


def test_first_tool_moves_same_unit_despite_old_transcript_votes(workspace):
    a, b = workspace
    store = ap.PositionStore()
    assert emit(store, b)["cityId"] == st.encode_repo_id(str(b))
    obs = observation(work_dirs=(str(a),) * 12)
    tracker = st.ExternalAgentTracker(st.TrackerConfig(bin_path="unused"), send=lambda _: None,
                                     sources=[], positions=store)
    tracker.reconcile([obs], NOW, [str(a), str(b)])
    assert tracker.agents()[0]["cityId"] == st.encode_repo_id(str(b))
    result = emit(store, a)
    assert result["accepted"]
    events = tracker.reconcile([obs], NOW, [str(a), str(b)])
    assert [e["type"] for e in events] == ["unit_relocate"]
    assert events[0]["unit"] == st.unit_id_for("claude-code", obs.native_id)


def test_merge_existing_native_identity_not_duplicate(workspace):
    a, _ = workspace
    store = ap.PositionStore()
    emit(store, a)
    rows = store.overlay([observation()], NOW)
    assert len(rows) == 1
    assert rows[0].source == "suvadu" and rows[0].event_count == 5
    assert rows[0].session_id == "claude-native-session-0001"


def test_new_session_before_suvadu_import(workspace):
    a, _ = workspace
    store = ap.PositionStore()
    emit(store, a, event="session_start")
    rows = store.overlay([], NOW)
    assert rows == []  # early hint waits for a verified source identity
    assert store.overlay([observation()], NOW)[0].position_repo == "a"


def test_hermes_chain_identity_and_profile_isolation(workspace):
    a, _ = workspace
    store = ap.PositionStore()
    emit(store, a, cli="hermes", native="compressed-child", profile="default")
    obs = replace(observation(), session_id="hermes-default-chain-root", agent="hermes",
                  native_id="compressed-child", source="hermes", profile="default",
                  unit_id="ext-hermes-hash")
    other = replace(obs, session_id="hermes-lexo-chain-root", profile="lexo")
    rows = store.overlay([obs, other], NOW)
    assert rows[0].session_id == obs.session_id and rows[0].unit_id == obs.unit_id
    assert rows[0].position_city_id and not rows[1].position_city_id
    assert store.overlay([], NOW) == []  # no unverified Hermes duplicates


def test_boundaries_keep_tool_location_and_session_end_does_not_respawn(workspace):
    a, b = workspace
    store = ap.PositionStore()
    emit(store, b)
    emit(store, a, event="turn_end")
    assert store.overlay([observation()], NOW)[0].position_city_id == st.encode_repo_id(str(b))
    emit(store, a, event="session_end")
    assert store.overlay([observation()], NOW)[0].ended
    assert store.overlay([], NOW) == []


def test_expired_hook_falls_back_and_selection_removal(workspace):
    a, _ = workspace
    store = ap.PositionStore(ttl_ms=100)
    emit(store, a)
    assert not store.overlay([observation()], NOW + 101)[0].position_city_id
    assert store.location(store.overlay([observation()], NOW)[0], [], NOW) is None


def test_symlink_longest_prefix_and_unselected_privacy(workspace, tmp_path):
    a, _ = workspace
    alias = tmp_path / "alias"
    alias.symlink_to(a, target_is_directory=True)
    store = ap.PositionStore()
    result = store.ingest({"cli": "claude", "event": "position", "session_id": "session-0001",
                           "cwd": str(alias / "src"), "prompt": "SECRET", "cityId": "FORGED"},
                          [str(a)], NOW)
    assert result["cityId"] == st.encode_repo_id(str(a))
    assert "SECRET" not in str(result) and "cwd" not in str(result)
    result = emit(store, tmp_path / "a-old")
    assert result == {"accepted": False, "reason": "unmapped"}


@pytest.mark.parametrize("body", [None, [], {}, {"cli": "evil"},
    {"cli": "claude", "session_id": "../bad", "event": "position", "cwd": "/"},
    {"cli": "claude", "session_id": "session", "event": "position", "cwd": "relative"}])
def test_bad_input_is_rejected(body):
    with pytest.raises(ValueError):
        ap.PositionStore().ingest(body, [], NOW)


def test_hook_only_sessions_exclude_repociv_owned_ids(workspace):
    a, _ = workspace
    store = ap.PositionStore()
    emit(store, a, native="owned-0001")
    assert store.overlay([], NOW, owned_ids={"owned-0001"}) == []


def test_capacity_is_bounded_and_sessions_do_not_share_position(workspace):
    a, b = workspace
    store = ap.PositionStore(capacity=2)
    emit(store, a, native="session-0001")
    emit(store, b, native="session-0002")
    emit(store, a, native="session-0003")
    rows = store.overlay([observation(native=f"session-000{x}") for x in (1, 2, 3)], NOW)
    assert not rows[0].position_city_id
    assert {r.position_city_id for r in rows[1:]} == {st.encode_repo_id(str(a)), st.encode_repo_id(str(b))}


def test_lifecycle_outside_any_repo_keeps_tool_then_closes(workspace):
    a, _ = workspace
    store = ap.PositionStore()
    emit(store, a)
    for event in ("turn_start", "turn_end", "session_end"):
        result = store.ingest({"cli": "claude", "session_id": "native-session-0001",
                              "event": event, "cwd": "/"}, [str(a)], NOW)
        assert result["accepted"] and result["cityId"] == st.encode_repo_id(str(a))
    assert store.overlay([observation()], NOW)[0].ended


def test_hermes_compression_inherits_workdir_not_shutdown_or_launch_cwd(workspace):
    a, b = workspace
    store = ap.PositionStore()
    emit(store, b, cli="hermes", native="ancestor", profile="default")
    obs = replace(observation(), agent="hermes", native_id="child", source="hermes",
        profile="default", unit_id="ext-hermes-stable", session_id="hermes-default-ancestor",
        related_native_ids=("child", "ancestor"))
    emit(store, a, cli="hermes", native="child", profile="default", event="session_start")
    assert store.overlay([obs], NOW)[0].position_repo == "b"
    emit(store, b, cli="hermes", native="ancestor", profile="default", event="session_end")
    assert not store.overlay([obs], NOW)[0].ended
    store.ingest({"cli": "hermes", "profile": "default", "session_id": "child",
        "event": "tool_use", "cwd": str(a), "authority": "tool"}, [str(a), str(b)], NOW + 1)
    rows = store.overlay([obs], NOW + 1)
    assert len(rows) == 1 and rows[0].position_repo == "a" and rows[0].unit_id == "ext-hermes-stable"


@pytest.mark.parametrize("cli", ["claude", "codex"])
def test_unverified_hooks_never_spawn_or_replace_source_identity(workspace, cli):
    a, b = workspace
    store = ap.PositionStore()
    emit(store, b, cli=cli, native="uuid-0001")
    tracker = st.ExternalAgentTracker(st.TrackerConfig(bin_path="unused"), send=lambda _: None,
        sources=[], positions=store)
    assert tracker.reconcile([], NOW, [str(a), str(b)]) == []
    # Suvadu variants: native_id may duplicate the source-prefixed session id.
    obs = replace(observation(), session_id=f"{cli}-uuid-0001",
        native_id=f"{cli}-uuid-0001", agent="claude-code" if cli == "claude" else cli,
        cwd=str(a), imported=True, live=True, total_tokens=17)
    tracker.reconcile([obs], NOW, [str(a), str(b)])
    assert len(tracker.agents()) == 1 and tracker.agents()[0]["repo"] == "b"
    emit(store, a, cli=cli, native="uuid-0001")
    events = tracker.reconcile([obs], NOW, [str(a), str(b)])
    assert [e["type"] for e in events] == ["unit_relocate"]
    assert tracker.agents()[0]["unit"] == st._unit_id(obs)
    assert store.overlay([obs], NOW)[0].total_tokens == 17


@pytest.mark.parametrize("error", [OSError("private path"), RuntimeError("private state"), ValueError("bad registry")])
def test_hook_endpoint_failures_return_sanitized_503(monkeypatch, error):
    class Failed:
        def ingest_position(self, body):
            raise error
    monkeypatch.setattr(st, "_tracker", Failed())
    assert ap.post_agent_events({}, {}) == (503, {"error": "position_unavailable"})


def test_repo_snapshot_read_once_outside_writer_lock(workspace):
    from concurrent.futures import ThreadPoolExecutor
    a, _ = workspace
    reads = []
    tracker = st.ExternalAgentTracker(st.TrackerConfig(bin_path="unused"), send=lambda _: None,
        sources=[], clock=lambda: NOW / 1000)
    def repos():
        def writer_available():
            acquired = tracker._writer_lock.acquire(timeout=0.1)
            if acquired:
                tracker._writer_lock.release()
            return acquired
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(writer_available).result(timeout=1)
        reads.append(True)
        return [str(a)]
    tracker._repo_paths = repos
    tracker.ingest_position({"cli": "claude", "session_id": "uuid", "event": "tool_use", "cwd": str(a)})
    assert reads == [True]


def test_empty_hermes_profile_uses_default_key(workspace):
    a, _ = workspace
    store = ap.PositionStore()
    emit(store, a, cli="hermes", profile="")
    obs = replace(observation(), agent="hermes", profile="", source="hermes")
    assert store.overlay([obs], NOW)[0].position_repo == "a"


@pytest.mark.parametrize("cli", ["claude", "codex"])
def test_prefixed_source_alias_can_close_same_identity(workspace, cli):
    a, _ = workspace
    store = ap.PositionStore()
    emit(store, a, cli=cli, native="uuid", event="session_end")
    obs = replace(observation(), session_id=f"{cli}-uuid", native_id=f"{cli}-uuid",
                  agent="claude-code" if cli == "claude" else cli)
    assert store.overlay([obs], NOW)[0].ended


@pytest.mark.parametrize("error_type", [OSError, RuntimeError, ValueError])
def test_real_http_hook_returns_503_then_recovers(monkeypatch, workspace, error_type):
    import json
    import urllib.error
    import urllib.request
    from server import bridge
    from server.test_bridge_integration import _start_test_server, _auth_headers
    a, _ = workspace
    # The hook endpoint refuses to run on an auth-off bridge
    # (503 position_auth_required), so configure a token like the isolated
    # guard tests do — otherwise CI, which has no .env, never reaches the
    # tracker path this test exercises. _auth_headers sends it.
    monkeypatch.setattr(bridge, "REPOCIV_TOKEN", "isolated-test-token-xxxxxxxxxxxxxxxx")
    def unavailable():
        raise error_type("private registry detail")
    tracker = st.ExternalAgentTracker(st.TrackerConfig(bin_path="unused"), send=lambda _: None,
        sources=[], repo_paths=unavailable, clock=lambda: NOW / 1000)
    monkeypatch.setattr(st, "_tracker", tracker)
    server, base = _start_test_server()
    def post(body):
        req = urllib.request.Request(base + "/api/agent-events", data=json.dumps(body).encode(),
            headers=_auth_headers({"Content-Type": "application/json"}), method="POST")
        try:
            response = urllib.request.urlopen(req, timeout=2)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)
    try:
        assert post({}) == (503, {"error": "position_unavailable"})
        tracker._repo_paths = lambda: [str(a)]
        assert post({}) == (400, {"error": "invalid_position"})
        status, body = post({"cli": "claude", "session_id": "uuid", "event": "tool_use", "cwd": str(a)})
        assert status == 200 and body["accepted"]
        assert tracker.agents() == []  # no invented identity at any stage
    finally:
        server.shutdown()
        server.server_close()


def test_hook_reconciles_with_liveness_snapshot(workspace):
    a, _ = workspace
    store = ap.PositionStore()
    tracker = st.ExternalAgentTracker(st.TrackerConfig(bin_path="unused"), send=lambda _: None,
        sources=[], repo_paths=lambda: [str(a)], positions=store, clock=lambda: NOW / 1000)
    obs = observation()
    tracker._last_obs = {"suvadu": [obs]}
    seen = []
    def with_liveness(rows):
        seen.extend(rows)
        return [replace(o, live=False) for o in rows]
    tracker._with_liveness = with_liveness
    tracker.ingest_position({"cli": "claude", "session_id": obs.native_id, "event": "tool_use", "cwd": str(a)})
    assert seen == [obs]



def test_expired_position_resets_first_received_time(workspace):
    a, _ = workspace
    store = ap.PositionStore(ttl_ms=10)
    body = {"cli": "claude", "session_id": "uuid", "event": "tool_use", "cwd": str(a)}
    store.ingest(body, [str(a)], NOW)
    store.ingest(body, [str(a)], NOW + 11)
    assert store._positions[("claude", "", "uuid")].first_ms == NOW + 11


def test_hook_accepted_during_poll_then_applied(workspace):
    from concurrent.futures import ThreadPoolExecutor, TimeoutError
    a, b = workspace
    tracker = st.ExternalAgentTracker(st.TrackerConfig(bin_path="unused"), send=lambda _: None,
        sources=[], repo_paths=lambda: [str(a), str(b)], clock=lambda: NOW / 1000)
    obs = replace(observation(), cwd=str(a), live=True)
    tracker._last_obs = {"suvadu": [obs]}
    tracker.reconcile([obs], NOW, [str(a), str(b)])
    with ThreadPoolExecutor(max_workers=1) as pool:
        with tracker._writer_lock:
            future = pool.submit(tracker.ingest_position, {"cli": "claude", "session_id": obs.native_id,
                "event": "tool_use", "cwd": str(b), "authority": "tool"})
            # Do not time out waiting for an in-flight source poll.
            try:
                result = future.result(timeout=0.2)
                ready = result["accepted"]
            except TimeoutError:
                ready = False
        assert ready
        assert future.result(timeout=1)["accepted"]
    tracker.reconcile([obs], NOW, [str(a), str(b)])
    assert tracker.agents()[0]["repo"] == "b"


def _posting_tracker(monkeypatch, *repos):
    tracker = st.ExternalAgentTracker(st.TrackerConfig(bin_path="unused"), send=lambda _: None,
        sources=[], repo_paths=lambda: [str(r) for r in repos], clock=lambda: NOW / 1000)
    monkeypatch.setattr(st, "_tracker", tracker)
    return lambda path, event="tool_use": ap.post_agent_events(
        {"cli": "claude", "session_id": "uuid", "event": event, "cwd": str(path), "authority": "tool"}, {})


def test_city_changes_are_recorded_once_without_cwd(monkeypatch, workspace, tmp_path):
    from server import event_store
    a, b = workspace
    post = _posting_tracker(monkeypatch, a, b)
    recorded = []
    monkeypatch.setattr(event_store, "record_event", lambda kind, data, **kw: recorded.append((kind, data, kw)))
    assert post(a / "src", "session_start")[0] == 200
    post(a / "src")
    post(a)  # same city: no new row
    post(b / "src")
    assert post(tmp_path / "elsewhere")[1] == {"accepted": False, "reason": "unmapped"}
    assert recorded == [
        ("AgentPosition:session_start", {"cli": "claude", "profile": "", "sessionId": "uuid",
                                         "cityId": st.encode_repo_id(str(a))}, {}),
        # No commandId: a native session is not a RepoCiv run.
        ("AgentPosition:tool_use", {"cli": "claude", "profile": "", "sessionId": "uuid",
                                    "cityId": st.encode_repo_id(str(b))}, {}),
    ]


def test_event_store_failure_does_not_fail_the_hook(monkeypatch, workspace):
    from server import event_store
    a, _ = workspace
    post = _posting_tracker(monkeypatch, a)
    def full_disk(*_args, **_kwargs):
        raise OSError("no space left")
    monkeypatch.setattr(event_store, "record_event", full_disk)
    status, body = post(a)
    assert status == 200 and body["accepted"]
