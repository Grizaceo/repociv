import json

from server import sessions


def test_get_or_create_creates_canonical_session(tmp_path):
    sessions.init(tmp_path)
    data = sessions.get_or_create("MAIN", defaults={"runtimeId": "hermes-local", "repo": "repociv"})

    assert data["unitId"] == "MAIN"
    assert data["runtimeId"] == "hermes-local"
    assert data["repo"] == "repociv"
    assert data["messageCount"] == 0

    saved = json.loads((tmp_path / "sessions" / "MAIN" / "canonical.json").read_text(encoding="utf-8"))
    assert saved["unitId"] == "MAIN"


def test_append_message_updates_counts_and_transcript(tmp_path):
    sessions.init(tmp_path)
    sessions.append_message("MAIN", "user", "hola", {"missionId": "m1"})
    canonical = sessions.append_message("MAIN", "assistant", "respuesta", {"missionId": "m1"})

    assert canonical["messageCount"] == 2
    assert canonical["inputChars"] == 4
    assert canonical["outputChars"] == len("respuesta")
    assert canonical["lastMissionId"] == "m1"

    lines = (tmp_path / "sessions" / "MAIN" / "transcript.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    second = json.loads(lines[1])
    assert first["role"] == "user"
    assert second["role"] == "assistant"


def test_patch_and_get_recent(tmp_path):
    sessions.init(tmp_path)
    sessions.patch("SCOUT", runtimeId="local-cli", workingDirectory="/tmp/repo")
    sessions.append_message("SCOUT", "user", "one")
    sessions.append_message("SCOUT", "assistant", "two")
    recent = sessions.get_recent("SCOUT", limit=1)
    canonical = sessions.get_or_create("SCOUT")

    assert recent == [json.loads((tmp_path / "sessions" / "SCOUT" / "transcript.jsonl").read_text(encoding="utf-8").splitlines()[-1])]
    assert canonical["runtimeId"] == "local-cli"
    assert canonical["workingDirectory"] == "/tmp/repo"
