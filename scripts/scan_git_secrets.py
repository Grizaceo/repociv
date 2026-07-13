#!/usr/bin/env python3
"""Fail on high-confidence credentials in tracked files or reachable Git history."""
from __future__ import annotations

import re
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "aws-access-key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "github-token": re.compile(r"\bgh[opusr]_[A-Za-z0-9]{36,255}\b"),
    "openai-key": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"),
    "anthropic-key": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b"),
    "stripe-live-key": re.compile(r"\bsk_live_[A-Za-z0-9]{16,}\b"),
    "slack-token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    "credential-assignment": re.compile(
        r"(?i)\b(?:REPOCIV_TOKEN|API_KEY|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD)"
        r"\s*[:=]\s*[\"']?([^\s\"'${}<]{12,})"
    ),
}
SAFE_MARKERS = (
    "example",
    "placeholder",
    "change-me",
    "changeme",
    "test-token",
    "dummy",
    "fake",
    "xxxx",
    "...",
    "the_generated_token",
    "os.environ",
    "process.env",
    "getenv(",
)
SAFE_FIXTURE_FILES = {
    "server/test_security_harness.py",
    "server/security_harness_test.py",
    "server/test_self_improve.py",
    "server/test_swarm_engine.py",
}
# RepoCiv-local bearer token accidentally committed in docs, then rotated.
# The current .env value was verified different on 2026-07-13. Fingerprint-only
# allowlisting avoids retaining or logging the credential itself.
SAFE_VALUE_HASHES = {
    "ba78b7711b513badf29f3ddc7f89e8a72f3126974dcaae695e99eb585e8dfad6",
}


def _safe_fixture(path: str, line: str) -> bool:
    lowered = line.lower()
    if path in SAFE_FIXTURE_FILES or any(marker in lowered for marker in SAFE_MARKERS):
        return True
    for name, pattern in PATTERNS.items():
        for match in pattern.finditer(line):
            value = match.group(1) if name == "credential-assignment" else match.group(0)
            if hashlib.sha256(value.encode()).hexdigest() in SAFE_VALUE_HASHES:
                return True
    return False


def _matches(path: str, line: str) -> list[str]:
    if _safe_fixture(path, line):
        return []
    return [name for name, pattern in PATTERNS.items() if pattern.search(line)]


def _tracked_findings() -> set[tuple[str, str, str]]:
    raw = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    findings: set[tuple[str, str, str]] = set()
    for item in raw.decode().split("\0"):
        if not item:
            continue
        path = ROOT / item
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for line_number, line in enumerate(text.splitlines(), 1):
            for detector in _matches(item, line):
                findings.add((detector, item, f"line {line_number}"))
    return findings


def _history_findings() -> set[tuple[str, str, str]]:
    proc = subprocess.Popen(
        [
            "git",
            "log",
            "--all",
            "-p",
            "--no-color",
            "--no-ext-diff",
            "--format=commit:%H",
            "--",
            ".",
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
    )
    assert proc.stdout is not None
    commit = "unknown"
    path = "unknown"
    findings: set[tuple[str, str, str]] = set()
    for line in proc.stdout:
        if line.startswith("commit:"):
            commit = line.removeprefix("commit:").strip()
            continue
        if line.startswith("+++ b/"):
            path = line.removeprefix("+++ b/").strip()
            continue
        if line.startswith("--- a/") or line.startswith("diff --git"):
            continue
        if not (line.startswith("+") or line.startswith("-")):
            continue
        content = line[1:]
        for detector in _matches(path, content):
            findings.add((detector, path, f"commit {commit[:12]}"))
    stderr = proc.stderr.read() if proc.stderr else ""
    return_code = proc.wait()
    if return_code != 0:
        raise RuntimeError(f"git history scan failed ({return_code}): {stderr[-500:]}")
    return findings


def main() -> int:
    findings = _tracked_findings() | _history_findings()
    if findings:
        print("High-confidence credential material found:", file=sys.stderr)
        for detector, path, location in sorted(findings):
            print(f"  {detector}: {path} ({location})", file=sys.stderr)
        return 1
    print("secret scan: no high-confidence credentials in tracked files or Git history")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
