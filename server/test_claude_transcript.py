from __future__ import annotations

import json

import pytest

from server import claude_transcript


def _entry(kind, content, **extra):
    return {
        "type": kind,
        "message": {"content": content},
        "timestamp": "2025-01-02T03:04:05.000Z",
        **extra,
    }


def _write(path, entries):
    path.write_text("\n".join(json.dumps(row) for row in entries) + "\n")


def test_reads_only_prompt_and_response_text_with_millisecond_timestamps(tmp_path):
    path = tmp_path / "session.jsonl"
    _write(path, [
        _entry("user", "hello"),
        _entry("user", "meta", isMeta=True),
        _entry("user", "side", isSidechain=True),
        _entry("user", [{"type": "tool_result", "content": "secret"}]),
        _entry("user", [{"type": "text", "text": "one"}, {"type": "text", "text": "two"}]),
        _entry("assistant", [{"type": "thinking", "thinking": "secret"}]),
        _entry("assistant", [{"type": "tool_use", "name": "tool"}]),
        _entry("assistant", [{"type": "text", "text": "answer"}, {"type": "tool_use"}]),
        _entry("assistant", [{"type": "text", "text": "side"}], isSidechain=True),
        {"type": "assistant", "message": None},
    ])
    with path.open("a") as f:
        f.write("not json\n")
    chat = claude_transcript.read_chat(str(path), limit=2)
    assert chat["available"] is True and chat["hasMore"] is True
    assert chat["messages"] == [
        {"role": "user", "text": "one\ntwo", "at": 1735787045000, "turn": None, "truncated": False},
        {"role": "assistant", "text": "answer", "at": 1735787045000, "turn": None, "truncated": False},
    ]
    assert [m["text"] for m in claude_transcript.read_chat(str(path), limit=10)["messages"]] == [
        "hello", "one\ntwo", "answer",
    ]


def test_tail_discards_partial_line_and_caps_text(tmp_path):
    path = tmp_path / "large.jsonl"
    entry = _entry("user", "ok")
    long_entry = _entry("assistant", [{"type": "text", "text": "a" * 120_000}])
    path.write_text("x" * (4 * 1024 * 1024) + "\n" + json.dumps(entry) + "\n" + json.dumps(long_entry) + "\n")
    chat = claude_transcript.read_chat(str(path), limit=10)
    assert chat["hasMore"] is True
    assert [m["role"] for m in chat["messages"]] == ["user", "assistant"]
    assert chat["messages"][1]["truncated"] is True
    assert len(chat["messages"][1]["text"]) < 120_000


def test_missing_file_falls_back_at_the_caller(tmp_path):
    with pytest.raises(OSError):
        claude_transcript.read_chat(str(tmp_path / "missing"), limit=10)
