"""Hook adapters do not transmit raw hook payloads or execute shell expansions."""
import io
import json
from server import agent_hook_client as hc


def test_allowlist_effective_workdir_and_native_id():
    payload = hc.position_payload("codex", "tool_use", {
        "session_id": "session-1", "cwd": "/home/me", "prompt": "SECRET",
        "tool_input": {"workdir": "/repo/b", "command": "print secret"},
        "tool_response": "PRIVATE", "cityId": "forged", "unitId": "MAIN"})
    assert payload == {"cli": "codex", "event": "tool_use", "session_id": "session-1",
                       "cwd": "/repo/b", "authority": "tool"}


def test_relative_file_cd_and_no_code_body_inference():
    raw = {"session_id": "session-1", "cwd": "/repo"}
    assert hc.position_payload("claude", "tool_use", {**raw, "tool_input": {"file_path": "src/a.py"}})["cwd"] == "/repo/src/a.py"
    assert hc.position_payload("claude", "tool_use", {**raw, "tool_input": {"command": "cd '../repo two' && git status"}})["cwd"] == "/repo two"
    assert hc.position_payload("hermes", "tool_use", {**raw, "tool_input": {"code": "read('/other-repo')"}})["cwd"] == "/repo"
    assert hc.position_payload("claude", "tool_use", {**raw, "tool_input": {"command": "cd $(evil)"}})["authority"] == "cwd"


def test_lifecycle_does_not_apply_tool_input():
    payload = hc.position_payload("claude", "turn_end", {"session_id": "s", "cwd": "/home/me", "tool_input": {"path": "/repo"}})
    assert payload["authority"] == "cwd" and payload["cwd"] == "/home/me"


def test_codex_json_arguments():
    payload = hc.position_payload("codex", "tool_use", {"session_id": "s", "cwd": "/",
        "tool_input": json.dumps({"workdir": "/repo"})})
    assert payload["cwd"] == "/repo"


def test_no_identity_no_send():
    assert hc.position_payload("claude", "tool_use", {"cwd": "/repo"}) is None
    assert hc.position_payload("claude", "nonsense", {"session_id": "s", "cwd": "/repo"}) is None


def test_fail_open_silent(monkeypatch, capsys):
    monkeypatch.setattr(hc.sys, "stdin", io.TextIOWrapper(io.BytesIO(b"bad json SECRET")))
    assert hc.main(["claude", "tool_use"]) == 0
    assert capsys.readouterr() == ("", "")


def test_no_remote_or_redirect_token_exfiltration(tmp_path):
    p = tmp_path / "client.json"
    for url in ("https://evil.example/api/agent-events", "http://127.0.0.1@evil.example/api/agent-events", "http://127.0.0.1/other"):
        p.write_text(json.dumps({"url": url, "token": "PRIVATE"}))
        assert not hc.deliver({"test": True}, p)
    assert hc._NoRedirect().redirect_request(None, None, None, None, None, None) is None


def test_url_not_a_local_file_and_hermes_payload_profile():
    payload = hc.position_payload("hermes", "tool_use", {"session_id": "s", "profile": "lexo",
        "cwd": "/repo", "tool_input": {"path": "https://elsewhere.example/file"}})
    assert payload["cwd"] == "/repo" and payload["authority"] == "cwd" and payload["profile"] == "lexo"


def test_no_cd_from_quoted_prose_code_or_heredoc():
    raw = {"session_id": "s", "cwd": "/repo"}
    for command in ["printf 'data;cd /other'", "python -c 'a=1;cd /other'",
                    "cat <<'EOF'\nx;cd /other\nEOF", "cd -P /other"]:
        payload = hc.position_payload("claude", "tool_use", {**raw, "tool_input": {"command": command}})
        assert payload["cwd"] == "/repo" and payload["authority"] == "cwd"
    payload = hc.position_payload("claude", "tool_use", {**raw,
        "tool_input": {"command": "  cd -- 'sub dir' && git status"}})
    assert payload["cwd"] == "/repo/sub dir"
