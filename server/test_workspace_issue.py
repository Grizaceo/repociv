"""Tests for server/workspace_issue.py — task-folder portable per issue."""
from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path

import pytest

import server.workspace_issue as wi
import server.locks as _locks


@pytest.fixture(autouse=True)
def _setup() -> None:
    """Reset module state and provide a fresh temp-based store each test."""
    wi._reset()
    _locks._reset()
    tmp = tempfile.mkdtemp()
    wi.init(Path(tmp))
    yield
    # No teardown needed beyond reset


# ── 1. init creates all 4 items ──────────────────────────────────────────────

def test_init_creates_all_four_items():
    state = wi.init_issue_workspace("my-repo", "ISSUE-1")

    assert state is not None
    assert state["repo"] == "my-repo"
    assert state["issueId"] == "ISSUE-1"
    assert state["phase"] == "init"

    issue_dir = wi._issue_dir("my-repo", "ISSUE-1")
    assert issue_dir.is_dir()
    assert (issue_dir / "spec.md").exists()
    assert (issue_dir / "plan.md").exists()
    assert (issue_dir / "state.json").exists()
    assert (issue_dir / "output").is_dir()


# ── 2. idempotent init ───────────────────────────────────────────────────────

def test_init_idempotent():
    state1 = wi.init_issue_workspace("repo", "ISS-2")
    state2 = wi.init_issue_workspace("repo", "ISS-2")

    assert state1 == state2
    assert state1["createdAt"] == state2["createdAt"]


# ── 3. load/save/patch cycle ─────────────────────────────────────────────────

def test_load_save_patch_cycle():
    wi.init_issue_workspace("repo", "ISS-3")

    # Load fresh
    s = wi.load_issue_state("repo", "ISS-3")
    assert s is not None
    assert s["phase"] == "init"

    # Save modified
    s["phase"] = "plan"
    s["custom"] = "value"
    saved = wi.save_issue_state("repo", "ISS-3", s)
    assert saved["phase"] == "plan"
    assert saved["custom"] == "value"

    # Load back
    loaded = wi.load_issue_state("repo", "ISS-3")
    assert loaded is not None
    assert loaded["phase"] == "plan"
    assert loaded["custom"] == "value"

    # Patch
    patched = wi.patch_issue_state("repo", "ISS-3", {"phase": "fix"})
    assert patched["phase"] == "fix"
    assert patched["custom"] == "value"  # preserved

    # Load again
    final = wi.load_issue_state("repo", "ISS-3")
    assert final is not None
    assert final["phase"] == "fix"


# ── 4. missing issue returns None ────────────────────────────────────────────

def test_missing_issue_returns_none():
    result = wi.load_issue_state("no-such-repo", "no-such-issue")
    assert result is None

    spec = wi.read_spec("no-such-repo", "no-such-issue")
    assert spec is None

    plan = wi.read_plan("no-such-repo", "no-such-issue")
    assert plan is None

    summary = wi.get_issue_summary("no-such-repo", "no-such-issue")
    assert summary["exists"] is False


# ── 5. artifact add + list ───────────────────────────────────────────────────

def test_artifact_add_and_list():
    wi.init_issue_workspace("repo", "ISS-4")

    wi.add_artifact("repo", "ISS-4", "diff.patch",
                    content="--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new")
    wi.add_artifact("repo", "ISS-4", "log.txt", content="build output here")
    wi.add_artifact("repo", "ISS-4", "screenshot.png", content="fake-binary")

    artifacts = wi.list_artifacts("repo", "ISS-4")
    assert artifacts == ["diff.patch", "log.txt", "screenshot.png"]

    # Verify counter
    state = wi.load_issue_state("repo", "ISS-4")
    assert state is not None
    assert state["artifactCount"] == 3


# ── 6. artifact content roundtrip ────────────────────────────────────────────

def test_artifact_content_roundtrip():
    wi.init_issue_workspace("repo", "ISS-5")

    wi.add_artifact("repo", "ISS-5", "README.md", content="# Hello\n\nWorld")
    content = wi.read_artifact("repo", "ISS-5", "README.md")
    assert content == "# Hello\n\nWorld"

    # Non-existent
    assert wi.read_artifact("repo", "ISS-5", "nope.txt") is None


# ── 7. spec write + read ─────────────────────────────────────────────────────

def test_spec_write_read():
    wi.init_issue_workspace("repo", "ISS-6")

    md = "## Requirements\n\n- [ ] thing 1\n- [ ] thing 2\n"
    wi.write_spec("repo", "ISS-6", md)

    read = wi.read_spec("repo", "ISS-6")
    assert read == md


# ── 8. plan write + read ─────────────────────────────────────────────────────

def test_plan_write_read():
    wi.init_issue_workspace("repo", "ISS-7")

    md = "## Approach\n\n1. Diagnose\n2. Plan\n3. Fix\n"
    wi.write_plan("repo", "ISS-7", md)

    read = wi.read_plan("repo", "ISS-7")
    assert read == md


# ── 9. summary reflects current state ────────────────────────────────────────

def test_summary_reflects_state():
    wi.init_issue_workspace("repo", "ISS-8")
    wi.patch_issue_state("repo", "ISS-8", {"phase": "validate"})
    wi.add_artifact("repo", "ISS-8", "output.txt",
                    content="test results: 5/5 OK")

    summary = wi.get_issue_summary("repo", "ISS-8")
    assert summary["exists"] is True
    assert summary["phase"] == "validate"
    assert summary["hasSpec"] is True
    assert summary["hasPlan"] is True
    assert summary["artifactCount"] == 1
    assert "output.txt" in summary["artifactNames"]
    assert summary["repo"] == "repo"
    assert summary["issueId"] == "ISS-8"


# ── 10. artifact with path copy ──────────────────────────────────────────────

def test_artifact_from_source_path():
    wi.init_issue_workspace("repo", "ISS-9")

    # Create a source file in a temp location
    src = Path(tempfile.mkdtemp()) / "src-file.txt"
    src.write_text("original content from disk", encoding="utf-8")

    wi.add_artifact("repo", "ISS-9", "copied.txt", source_path=str(src))

    artifacts = wi.list_artifacts("repo", "ISS-9")
    assert "copied.txt" in artifacts

    content = wi.read_artifact("repo", "ISS-9", "copied.txt")
    assert content == "original content from disk"


# ── 11. issue listing across repos ───────────────────────────────────────────

def test_list_issues_across_repos():
    wi.init_issue_workspace("repo-A", "ISS-1")
    wi.init_issue_workspace("repo-A", "ISS-2")
    wi.init_issue_workspace("repo-B", "ISS-3")

    # All issues
    all_issues = wi.list_issues()
    assert len(all_issues) == 3
    repos = {r["repo"] for r in all_issues}
    assert repos == {"repo-A", "repo-B"}

    # Filter by repo
    a_issues = wi.list_issues(repo="repo-A")
    assert len(a_issues) == 2
    for i in a_issues:
        assert i["repo"] == "repo-A"

    # Empty filter
    assert wi.list_issues(repo="repo-C") == []


# ── 12. concurrent init safety ───────────────────────────────────────────────

def test_concurrent_init_safety():
    """Multiple threads calling init_issue_workspace concurrently should
    not corrupt state or raise exceptions."""
    errors: list[Exception] = []
    results: list[dict] = []

    def worker() -> None:
        try:
            r = wi.init_issue_workspace("repo", "ISS-CONC")
            results.append(r)
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(errors) == 0, f"errors during concurrent init: {errors}"
    assert len(results) == 10

    # All results should be identical (same issue dir)
    first = results[0]
    for r in results[1:]:
        assert r == first


# ── 13. register_run ─────────────────────────────────────────────────────────

def test_register_run():
    wi.init_issue_workspace("repo", "ISS-RUN")

    wi.register_run("repo", "ISS-RUN", "run-001")
    wi.register_run("repo", "ISS-RUN", "run-002")
    wi.register_run("repo", "ISS-RUN", "run-002")  # duplicate — no double-add

    state = wi.load_issue_state("repo", "ISS-RUN")
    assert state is not None
    assert state["runIds"] == ["run-001", "run-002"]


# ── 14. patch creates state if missing ──────────────────────────────────────

def test_patch_creates_state_if_missing():
    """patch_issue_state on a non-existent issue should create it."""
    result = wi.patch_issue_state("repo", "ISS-NEW", {"phase": "diagnose"})

    assert result is not None
    assert result["repo"] == "repo"
    assert result["issueId"] == "ISS-NEW"
    assert result["phase"] == "diagnose"

    # Verify on disk
    loaded = wi.load_issue_state("repo", "ISS-NEW")
    assert loaded is not None
    assert loaded["phase"] == "diagnose"


# ── 15. add_artifact without content or source_path raises ───────────────────

def test_add_artifact_requires_content_or_source():
    wi.init_issue_workspace("repo", "ISS-ERR")
    with pytest.raises(ValueError, match="content= or source_path="):
        wi.add_artifact("repo", "ISS-ERR", "bad.txt")


# ── 16. Validation Contract ──────────────────────────────────────────────────


class TestValidationContract:
    def setup_method(self):
        wi._reset()
        _locks._reset()
        self.tmp = tempfile.mkdtemp()
        wi.init(Path(self.tmp))

    def _init_issue(self):
        wi.init_issue_workspace("repo", "ISS-VC")

    def test_write_and_read_contract(self):
        self._init_issue()
        contract = wi.write_validation_contract("repo", "ISS-VC", {
            "goal": "Fix the thing",
            "deliverables": ["fix.py"],
            "mustPassChecks": ["tests-pass", "lint-clean"],
            "doneDefinition": "All tests pass",
        })
        assert contract["goal"] == "Fix the thing"
        assert contract["version"] == "1.0"
        assert contract["autoGenerated"] is False

        read = wi.read_validation_contract("repo", "ISS-VC")
        assert read is not None
        assert read["goal"] == "Fix the thing"
        assert read["deliverables"] == ["fix.py"]
        assert read["mustPassChecks"] == ["tests-pass", "lint-clean"]

    def test_has_validation_contract(self):
        self._init_issue()
        assert wi.has_validation_contract("repo", "ISS-VC") is False
        wi.write_validation_contract("repo", "ISS-VC", {"goal": "x"})
        assert wi.has_validation_contract("repo", "ISS-VC") is True

    def test_read_missing_contract_returns_none(self):
        self._init_issue()
        assert wi.read_validation_contract("repo", "ISS-VC") is None

    def test_contract_normalizes_defaults(self):
        self._init_issue()
        contract = wi.write_validation_contract("repo", "ISS-VC", {"goal": "x"})
        assert "deliverables" in contract
        assert "mustPassChecks" in contract
        assert "behaviourChecks" in contract
        assert "forbiddenChanges" in contract
        assert "evidenceRequired" in contract
        assert "doneDefinition" in contract

    def test_generate_contract_from_spec(self):
        self._init_issue()
        spec = (
            "# ISS-VC\n\n"
            "## Goal\n"
            "- Fix the critical bug\n"
            "- Improve performance\n"
            "\n"
            "## Deliverables\n"
            "- fix.py\n"
            "- tests/\n"
            "\n"
            "## Done Definition\n"
            "- All tests pass and lint is clean\n"
        )
        wi.write_spec("repo", "ISS-VC", spec)
        contract = wi.generate_contract_from_spec("repo", "ISS-VC")
        assert contract["autoGenerated"] is True
        assert "Fix the critical bug" in contract["goal"]
        assert "fix.py" in contract["deliverables"]
        # mustPassChecks added because spec mentions "tests"
        assert "tests-pass" in contract["mustPassChecks"]

    def test_generate_contract_no_checks_without_test_mention(self):
        self._init_issue()
        spec = (
            "# ISS-VC\n\n"
            "## Goal\n"
            "- Fix the thing\n"
            "\n"
            "## Deliverables\n"
            "- fix.py\n"
        )
        wi.write_spec("repo", "ISS-VC", spec)
        contract = wi.generate_contract_from_spec("repo", "ISS-VC")
        assert contract["autoGenerated"] is True
        assert contract["mustPassChecks"] == []

    def test_generate_contract_empty_spec(self):
        self._init_issue()
        contract = wi.generate_contract_from_spec("repo", "ISS-VC")
        assert contract["autoGenerated"] is True
        assert contract["goal"] == ""
        assert contract["deliverables"] == []

    def test_contract_overwrite(self):
        self._init_issue()
        wi.write_validation_contract("repo", "ISS-VC", {"goal": "first"})
        updated = wi.write_validation_contract("repo", "ISS-VC", {"goal": "second"})
        assert updated["goal"] == "second"
        read = wi.read_validation_contract("repo", "ISS-VC")
        assert read["goal"] == "second"


# ── 17. Handoff artifacts ────────────────────────────────────────────────────


class TestHandoffArtifacts:
    def setup_method(self):
        wi._reset()
        _locks._reset()
        self.tmp = tempfile.mkdtemp()
        wi.init(Path(self.tmp))

    def _init_issue(self):
        wi.init_issue_workspace("repo", "ISS-HF")

    def test_write_and_read_handoff(self):
        self._init_issue()
        payload = {
            "completed_work": ["Fix auth module"],
            "commands_run": ["git commit -m 'fix auth'"],
            "files_changed": ["auth.py"],
            "tests_run": ["pytest tests/test_auth.py"],
            "open_risks": ["No test for edge case"],
            "known_failures": [],
            "recommended_next_role": "VALIDATOR",
            "recommended_next_action": "Run full test suite",
        }
        handoff = wi.write_handoff("repo", "ISS-HF", "execute", "WORKER", payload)
        assert handoff["role"] == "WORKER"
        assert handoff["phase"] == "execute"
        assert handoff["completedWork"] == ["Fix auth module"]
        assert handoff["recommendedNextRole"] == "VALIDATOR"

        read = wi.read_latest_handoff("repo", "ISS-HF")
        assert read is not None
        assert read["role"] == "WORKER"
        assert read["completedWork"] == ["Fix auth module"]

    def test_read_handoff_by_role(self):
        self._init_issue()
        wi.write_handoff("repo", "ISS-HF", "plan", "SCOUT", {
            "completed_work": ["Analysis"],
            "recommended_next_role": "WORKER",
            "recommended_next_action": "Implement",
        })
        wi.write_handoff("repo", "ISS-HF", "execute", "WORKER", {
            "completed_work": ["Implementation"],
            "recommended_next_role": "VALIDATOR",
            "recommended_next_action": "Validate",
        })

        worker = wi.read_latest_handoff("repo", "ISS-HF", role="WORKER")
        assert worker is not None
        assert worker["role"] == "WORKER"

        scout = wi.read_latest_handoff("repo", "ISS-HF", role="SCOUT")
        assert scout is not None
        assert scout["role"] == "SCOUT"

    def test_read_latest_returns_most_recent(self):
        self._init_issue()
        wi.write_handoff("repo", "ISS-HF", "step1", "SCOUT", {
            "completed_work": ["First"],
            "recommended_next_role": "WORKER",
            "recommended_next_action": "Continue",
        })
        import time
        time.sleep(0.05)  # ensure different mtime
        wi.write_handoff("repo", "ISS-HF", "step2", "WORKER", {
            "completed_work": ["Second"],
            "recommended_next_role": "VALIDATOR",
            "recommended_next_action": "Validate",
        })

        latest = wi.read_latest_handoff("repo", "ISS-HF")
        assert latest is not None
        assert latest["role"] == "WORKER"
        assert latest["completedWork"] == ["Second"]

    def test_read_handoff_missing(self):
        self._init_issue()
        assert wi.read_latest_handoff("repo", "ISS-HF") is None

    def test_write_handoff_invalid_role(self):
        self._init_issue()
        with pytest.raises(ValueError, match="Unknown handoff role"):
            wi.write_handoff("repo", "ISS-HF", "execute", "INVALID", {})

    def test_write_handoff_creates_output_dir(self):
        self._init_issue()
        # Remove output dir to test creation
        out_dir = wi._output_dir("repo", "ISS-HF")
        if out_dir.exists():
            import shutil
            shutil.rmtree(out_dir)
        handoff = wi.write_handoff("repo", "ISS-HF", "execute", "WORKER", {
            "completed_work": ["test"],
            "recommended_next_role": "",
            "recommended_next_action": "",
        })
        assert handoff["role"] == "WORKER"
        assert out_dir.exists()
