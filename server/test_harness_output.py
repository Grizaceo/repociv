"""Characterize harness output without invoking agents or subprocesses."""
from __future__ import annotations

import pytest

from server import agent_runner, harness_output


@pytest.mark.parametrize(
    "line,expected",
    [
        ("", ""),
        (" \t\n", ""),
        ("  plain output\n", "plain output"),
        ('{"type":', '{"type":'),
        ("null", "null"),
        ("[]", "[]"),
        ('"text"', '"text"'),
        ('{"type":"text","text":"hola"}', "hola"),
        ('{"type":"text"}', ""),
        ('{"type":"tool_use","text":"hidden"}', ""),
        ('{"type":"tool_result","text":"hidden"}', ""),
        ('{"type":"ping","text":"hidden"}', ""),
        ('{"type":"heartbeat","text":"hidden"}', ""),
        ('{"type":"unknown","text":"hidden"}', ""),
        ('{"type":"assistant","message":{"content":"hello"}}', "hello"),
        ('{"type":"assistant","message":{"content":[]}}', ""),
        ('{"type":"assistant","message":null}', '{"type":"assistant","message":null}'),
        ('{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"tool_use"},null,{"type":"text","text":"b"}]}}', "ab"),
        ('{"type":"result","output":"done","text":"ignored"}', "done"),
        ('{"type":"result","text":"fallback"}', "fallback"),
        ('{"type":"final_output","output":"done"}', "done"),
        ('{"type":"final_output"}', ""),
    ],
)
def test_cursor_output_contract(line, expected):
    assert harness_output.parse_cursor_ndjson_chunk(line) == expected
    assert agent_runner._parse_cursor_ndjson_chunk(line) == expected


@pytest.mark.parametrize(
    "output,expected",
    [
        ("", ""),
        ("plain output", ""),
        ("session_id:", ""),
        ("session_id: abc_123", "abc_123"),
        ("before\nsession_id:\tABC123\nafter", "ABC123"),
        ("session_id: first\nsession_id: second", "first"),
        ("SESSION_ID: upper", ""),
        ("session_id: abc-def", "abc"),
    ],
)
def test_hermes_session_id_contract(output, expected):
    # Preserve the existing first-match, case-sensitive, alphanumeric/underscore rule.
    assert harness_output.extract_hermes_session_id(output) == expected
    assert agent_runner._extract_hermes_session_id(output) == expected
