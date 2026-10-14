"""R16 — path confinement for the local state stores.

Covers the shared identifier contract (``server/identifiers.py``) and its
enforcement at every boundary of ``checkpoint.py`` and
``workspace_issue.py``, plus the HTTP/WS command-schema layer.

All writes stay inside per-test scratch roots (TMPDIR isolation). No live
bridge, agent, approval, or external model is touched.
"""
from __future__ import annotations

import pytest

import server.checkpoint as cp
import server.workspace_issue as wi
import server.locks as _locks
from server.identifiers import IdentifierError, confine, validate_identifier
from server.command_schema import CommandValidationError, validate_command


MALFORMED_IDS = [
    "..",
    ".",
    "../escape",
    "sub/../../escape",
    "/etc/passwd",
    "/",
    "a/b",
    "a\\b",
    "\\..\\..",
    "",
    "   ",
    "..\\..",
    ".hidden",
    "sub/..",
    "a\x00b",
    "x" * 129,
]

VALID_IDS = ["repo", "my-repo", "My_Repo", "ISS-42", "v1.2", "A1", "iss-42.x"]


# ─── Helper contract ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", MALFORMED_IDS)
def test_validate_identifier_rejects_without_repair(bad):
    with pytest.raises(IdentifierError):
        validate_identifier(bad, field="repo")


def test_validate_identifier_rejects_non_string():
    for bad in (None, 1, 2.5, [], {}, True):
        with pytest.raises(IdentifierError):
            validate_identifier(bad, field="repo")


@pytest.mark.parametrize("good", VALID_IDS)
def test_validate_identifier_accepts_literal_components(good):
    assert validate_identifier(good, field="repo") == good


def test_confine_rejects_absolute_candidate(tmp_path):
    with pytest.raises(IdentifierError):
        confine(tmp_path, "/etc/passwd")


def test_confine_rejects_resolved_escape(tmp_path):
    root = tmp_path / "store"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("x", encoding="utf-8")
    (root / "link").symlink_to(outside, target_is_directory=True)
    with pytest.raises(IdentifierError):
        confine(root, root / "link" / "secret.txt")


# ─── checkpoint.py confinement ────────────────────────────────────────────────

@pytest.fixture()
def ckpt_store(tmp_path):
    """Redirect checkpoints to a temp directory per test."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(cp, "_CHECKPOINTS_DIR", tmp_path / "checkpoints", raising=False)
        yield tmp_path / "checkpoints"


@pytest.mark.parametrize("bad", MALFORMED_IDS)
def test_checkpoint_save_rejects_malformed_before_mkdir(ckpt_store, bad):
    before = sorted(p.name for p in ckpt_store.parent.iterdir())
    with pytest.raises(IdentifierError):
        cp.save_checkpoint(bad, "ISS-1", {"stepIndex": 0})
    with pytest.raises(IdentifierError):
        cp.save_checkpoint("repo", bad, {"stepIndex": 0})
    # No filesystem effect: nothing was created or removed.
    assert sorted(p.name for p in ckpt_store.parent.iterdir()) == before
    assert not ckpt_store.exists()


def test_checkpoint_parent_traversal_contained(ckpt_store):
    """repo='..' must not write outside the store root."""
    cp.save_checkpoint("repo", "ISS-1", {"stepIndex": 0})
    with pytest.raises(IdentifierError):
        cp.save_checkpoint("..", "ISS-1", {"stepIndex": 9})
    # The escaped file does not exist anywhere near the scratch root.
    assert not (ckpt_store.parent.parent / "ISS-1.json").exists()
    assert not (ckpt_store.parent / "ISS-1.json").exists()


@pytest.mark.parametrize("bad", MALFORMED_IDS)
def test_checkpoint_load_and_delete_reject_malformed(ckpt_store, bad):
    with pytest.raises(IdentifierError):
        cp.load_checkpoint(bad, "ISS-1")
    with pytest.raises(IdentifierError):
        cp.load_checkpoint("repo", bad)
    with pytest.raises(IdentifierError):
        cp.delete_checkpoint(bad, "ISS-1")


def test_checkpoint_valid_ids_still_round_trip(ckpt_store):
    cp.save_checkpoint("my-repo", "ISS-42", {"stepIndex": 3})
    loaded = cp.load_checkpoint("my-repo", "ISS-42")
    assert loaded == {"stepIndex": 3}
    cp.delete_checkpoint("my-repo", "ISS-42")
    assert cp.load_checkpoint("my-repo", "ISS-42") is None


def test_checkpoint_symlink_escape_rejected(ckpt_store):
    outside = ckpt_store.parent / "outside"
    outside.mkdir()
    ckpt_store.mkdir(parents=True, exist_ok=True)
    (ckpt_store / "linked").symlink_to(outside, target_is_directory=True)
    with pytest.raises(IdentifierError):
        cp.save_checkpoint("linked", "ISS-1", {"stepIndex": 0})
    assert not (outside / "ISS-1.json").exists()
    with pytest.raises(IdentifierError):
        cp.load_checkpoint("linked", "ISS-1")


# ─── workspace_issue.py confinement ───────────────────────────────────────────

@pytest.fixture()
def wi_store(tmp_path):
    wi._reset()
    _locks._reset()
    wi.init(tmp_path / "store")
    yield tmp_path / "store" / "workspaces"
    wi._reset()
    _locks._reset()


@pytest.mark.parametrize("bad", MALFORMED_IDS)
def test_workspace_issue_init_rejects_malformed(wi_store, bad):
    with pytest.raises(IdentifierError):
        wi.init_issue_workspace(bad, "ISS-1")
    with pytest.raises(IdentifierError):
        wi.init_issue_workspace("repo", bad)
    assert list(wi_store.iterdir()) == []


def test_workspace_issue_parent_traversal_contained(wi_store):
    with pytest.raises(IdentifierError):
        wi.init_issue_workspace("..", "ISS-1")
    assert not (wi_store.parent / "ISS-1").exists()
    assert not (wi_store.parent.parent / "ISS-1").exists()
    assert list(wi_store.iterdir()) == []


@pytest.mark.parametrize("bad", MALFORMED_IDS)
def test_workspace_issue_read_paths_reject_malformed(wi_store, bad):
    wi.init_issue_workspace("repo", "ISS-1")
    for fn in (
        wi.load_issue_state,
        wi.read_spec,
        wi.read_plan,
        wi.get_issue_summary,
        wi.list_artifacts,
        wi.read_sentinel,
    ):
        with pytest.raises(IdentifierError):
            fn(bad, "ISS-1")
        with pytest.raises(IdentifierError):
            fn("repo", bad)


@pytest.mark.parametrize("bad", MALFORMED_IDS)
def test_workspace_issue_write_paths_reject_malformed(wi_store, bad):
    with pytest.raises(IdentifierError):
        wi.write_spec(bad, "ISS-1", "# x")
    with pytest.raises(IdentifierError):
        wi.write_plan("repo", bad, "# x")
    with pytest.raises(IdentifierError):
        wi.save_issue_state(bad, "ISS-1", {})
    with pytest.raises(IdentifierError):
        wi.patch_issue_state("repo", bad, {})
    with pytest.raises(IdentifierError):
        wi.register_run(bad, "ISS-1", "run-1")
    assert list(wi_store.iterdir()) == []


@pytest.mark.parametrize("bad_name", ["../escape.txt", "/etc/passwd", "sub/dir.txt", "..", "."])
def test_workspace_issue_artifact_name_rejected(wi_store, bad_name):
    wi.init_issue_workspace("repo", "ISS-1")
    with pytest.raises(IdentifierError):
        wi.add_artifact("repo", "ISS-1", bad_name, content="x")
    with pytest.raises(IdentifierError):
        wi.read_artifact("repo", "ISS-1", bad_name)
    assert wi.list_artifacts("repo", "ISS-1") == []


def test_workspace_issue_symlink_escape_rejected(wi_store):
    outside = wi_store.parent / "outside"
    outside.mkdir()
    wi_store.mkdir(parents=True, exist_ok=True)
    (wi_store / "linked").symlink_to(outside, target_is_directory=True)
    with pytest.raises(IdentifierError):
        wi.init_issue_workspace("linked", "ISS-1")
    assert not (outside / "ISS-1").exists()
    with pytest.raises(IdentifierError):
        wi.load_issue_state("linked", "ISS-1")


def test_workspace_issue_list_issues_rejects_bad_filter(wi_store):
    with pytest.raises(IdentifierError):
        wi.list_issues(repo="..")
    with pytest.raises(IdentifierError):
        wi.list_issues(repo="../escape")


def test_workspace_issue_valid_ids_still_work(wi_store):
    state = wi.init_issue_workspace("my-repo", "ISS-42")
    assert state["phase"] == "init"
    wi.write_spec("my-repo", "ISS-42", "# spec")
    assert wi.read_spec("my-repo", "ISS-42") == "# spec"
    wi.add_artifact("my-repo", "ISS-42", "diff.patch", content="x")
    assert wi.list_artifacts("my-repo", "ISS-42") == ["diff.patch"]
    issues = wi.list_issues()
    assert {"repo": "my-repo", "issueId": "ISS-42"} in issues
    assert wi.list_issues(repo="my-repo") == [{"repo": "my-repo", "issueId": "ISS-42"}]


# ─── HTTP/WS command-schema layer ─────────────────────────────────────────────

def test_schema_accepts_task_run_with_valid_ids():
    cmd = validate_command({
        "type": "task_run",
        "target": "my-repo",
        "payload": {"repo": "my-repo", "issueId": "ISS-42"},
    })
    assert cmd.type == "task_run"


@pytest.mark.parametrize("bad", ["..", ".", "../x", "/abs", "a/b", ""])
def test_schema_rejects_task_run_malformed_issue_id(bad):
    with pytest.raises(CommandValidationError):
        validate_command({
            "type": "task_run",
            "target": "repo",
            "payload": {"repo": "repo", "issueId": bad},
        })


@pytest.mark.parametrize("bad", ["..", "../x", "/abs", "a/b"])
def test_schema_rejects_task_run_malformed_repo(bad):
    with pytest.raises(CommandValidationError):
        validate_command({
            "type": "task_run",
            "target": "repo",
            "payload": {"repo": bad, "issueId": "ISS-1"},
        })


def test_schema_task_run_missing_issue_id_still_rejected():
    with pytest.raises(CommandValidationError):
        validate_command({"type": "task_run", "target": "repo", "payload": {}})
