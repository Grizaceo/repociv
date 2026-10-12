"""Install and remove in isolated homes, preserving all existing hooks and config."""
import json
from pathlib import Path

import yaml
import pytest

from server import agent_hook_install as hi


def test_json_append_idempotent_remove_preserves_suvadu():
    original = {"permissions": {"allow": ["Bash(git status)"]}, "hooks": {
        "Stop": [{"hooks": [{"type": "command", "command": "/suvadu", "timeout": 10}]}]}}
    specs = hi.commands(Path("/repo"), "/python")["claude"]
    merged = hi.merge_json_hooks(original, specs)
    assert merged["hooks"]["Stop"][0] == original["hooks"]["Stop"][0]
    assert merged["permissions"] == original["permissions"]
    assert hi.merge_json_hooks(merged, specs) == merged
    assert hi.merge_json_hooks(merged, specs, remove=True) == original


def test_yaml_preserves_bytes_outside_hooks_and_is_reversible():
    before = 'model: "private-value" # KEEP\nhooks:\n  post_tool_call:\n    - command: /suvadu\n      timeout: 10\n\nother: "private-value" # KEEP TOO\n'
    specs = hi.commands(Path("/repo"), "/python")["hermes"]
    merged = hi.merge_yaml_hooks(before, specs)
    assert merged.startswith('model: "private-value" # KEEP\n')
    assert merged.endswith('other: "private-value" # KEEP TOO\n')
    assert yaml.safe_load(merged)["hooks"]["post_tool_call"][0] == {"command": "/suvadu", "timeout": 10}
    assert hi.merge_yaml_hooks(merged, specs) == merged
    assert yaml.safe_load(hi.merge_yaml_hooks(merged, specs, remove=True)) == yaml.safe_load(before)
    assert specs["on_session_end"].endswith("hermes turn_end")


def test_install_backups_private_and_no_other_profiles(tmp_path):
    home = tmp_path / "home"
    for name in (".claude/settings.json", ".codex/hooks.json", ".hermes/config.yaml"):
        p = home / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{}\n")
    other = home / ".hermes/profiles/lexo/config.yaml"
    other.parent.mkdir(parents=True)
    other.write_text("# UNTOUCHED\n")
    result = hi.install(home, Path("/repo"), "/python")
    assert len(result["changed"]) == 3
    assert Path(result["backup"]).stat().st_mode & 0o777 == 0o700
    assert all(p.stat().st_mode & 0o777 == 0o600 for p in Path(result["backup"]).iterdir())
    assert hi.install(home, Path("/repo"), "/python")["changed"] == []
    hi.install(home, Path("/repo"), "/python", remove=True)
    assert json.loads((home / ".claude/settings.json").read_text())["hooks"] == {}
    assert other.read_text() == "# UNTOUCHED\n"



@pytest.mark.parametrize("cli", ["claude", "codex", "hermes"])
def test_interpreter_change_is_idempotent_and_removes_owned_variants(cli):
    old = hi.commands(Path("/repo"), "/old/python")[cli]
    new = hi.commands(Path("/repo"), "/new/python")[cli]
    if cli == "hermes":
        before = "other: keep\nhooks:\n  post_tool_call:\n    - command: /suvadu\n"
        one = hi.merge_yaml_hooks(before, old)
        assert hi.merge_yaml_hooks(one, new) == one
        assert yaml.safe_load(hi.merge_yaml_hooks(one, new, remove=True)) == yaml.safe_load(before)
    else:
        before = {"hooks": {"PostToolUse": [{"hooks": [{"type": "command", "command": "/suvadu"}]}]}}
        one = hi.merge_json_hooks(before, old)
        assert hi.merge_json_hooks(one, new) == one
        assert hi.merge_json_hooks(one, new, remove=True) == before


@pytest.mark.parametrize("cli", ["claude", "codex", "hermes"])
def test_cleanup_duplicate_keeps_first_command_and_foreign_hooks(cli):
    old = hi.commands(Path("/repo"), "/old/python")[cli]
    new = hi.commands(Path("/repo"), "/new/python")[cli]
    event = "post_tool_call" if cli == "hermes" else "PostToolUse"
    foreign = {"command": hi.commands(Path("/different-clone"), "/python")[cli][event], "timeout": 17}
    first = {"command": old[event], "timeout": 9}
    duplicate = {"command": new[event], "timeout": 2}
    if cli == "hermes":
        original = yaml.safe_dump({"hooks": {event: [first, duplicate, foreign]}})
        merged = yaml.safe_load(hi.merge_yaml_hooks(original, new))
        assert merged["hooks"][event] == [first, foreign]
    else:
        original = {"hooks": {event: [{"matcher": ".*", "hooks": [first, duplicate, foreign]}]}}
        merged = hi.merge_json_hooks(original, new)
        assert merged["hooks"][event][0]["hooks"] == [first, foreign]
