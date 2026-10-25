"""Characterization captured from agent_runner at 869e143, before extraction."""

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from server import agent_runner


def _cases():
    cases = [
        {
            "id": "root-state",
            "kind": "root",
            "active": "$FIXTURE/state-root",
            "env": ["map", "repos", "ws"],
        },
        {"id": "root-map", "kind": "root", "env": ["map", "repos", "ws"]},
        {"id": "root-repos", "kind": "root", "env": ["", "repos", "ws"]},
        {"id": "root-workspace", "kind": "root", "env": ["", "", "ws"]},
        {"id": "root-default", "kind": "root", "env": ["", "", ""]},
        {"id": "root-tilde", "kind": "root", "env": ["~/repos", "", ""]},
        {"id": "root-state-tilde", "kind": "root", "active": "~/state", "env": ["map", "", ""]},
        {"id": "root-whitespace", "kind": "root", "env": ["  ", "repos", "ws"]},
        {"id": "root-error", "kind": "root", "raise": True},
    ]
    for i, city in enumerate(
        [
            "",
            "main",
            " MAIN ",
            "capital",
            " CaPiTaL ",
            "repo-a",
            "repo:encoded",
            "../outside",
            "ciudad ñ",
        ]
    ):
        for selected in (False, True):
            cases.append(
                {
                    "id": f"workdir-{i}-{selected}",
                    "kind": "workdir",
                    "city": city,
                    "repo": "$FIXTURE/explicit" if selected else "",
                    "selected": selected,
                }
            )
    cases.extend(
        [
            {"id": "capital-missing", "kind": "workdir", "city": "capital", "missing_bridge": True},
            {"id": "selection-error", "kind": "workdir", "city": "repo-a", "raise": True},
        ]
    )
    for i, file in enumerate(
        [
            "",
            " ",
            ".",
            "nested/file.txt",
            "missing.txt",
            " nested/file.txt ",
            "nested/../missing.txt",
            "../outside/secret.txt",
            "../repo-evil/file.txt",
            "$FIXTURE/repo/nested/file.txt",
            "$FIXTURE/outside/secret.txt",
            "escape/secret.txt",
            "inside/file.txt",
            "loop/file.txt",
            "nul\u0000name",
        ]
    ):
        cases.append({"id": f"file-{i}", "kind": "file", "file": file})
    cases.extend(
        [
            {"id": "file-cwd", "kind": "file", "file": "missing.txt", "cwd_root": True},
            {"id": "file-guard-override", "kind": "file", "file": "nested/file.txt", "deny": True},
        ]
    )
    for i, candidate in enumerate(
        [
            "$FIXTURE/repo",
            "$FIXTURE/repo/nested/file.txt",
            "$FIXTURE/repo-evil/file.txt",
            "$FIXTURE/repo/../outside",
            "$FIXTURE/repo/escape",
            "$FIXTURE/repo/inside",
            "$FIXTURE/repo/loop",
            "$FIXTURE/repo/nul\u0000name",
        ]
    ):
        cases.append({"id": f"within-{i}", "kind": "within", "candidate": candidate})
    for i, (city, cwd) in enumerate(
        [("", None), (" main ", ""), ("CARCOSA", "$FIXTURE/repo"), ("ciudad ñ", "$FIXTURE/outside")]
    ):
        cases.append({"id": f"spatial-{i}", "kind": "spatial", "city": city, "cwd": cwd})
    cases.append({"id": "spatial-root-error", "kind": "spatial", "city": "repo-a", "raise": True})
    return cases


def _exercise(case, tmp_path, monkeypatch):
    """Use only isolated files and injected state; never run an agent or model."""

    def expand(value):
        return value.replace("$FIXTURE", str(tmp_path)) if isinstance(value, str) else value

    home = tmp_path / "home"
    repo = tmp_path / "repo"
    for directory in (
        home,
        repo / "nested",
        tmp_path / "outside",
        tmp_path / "repo-evil",
        tmp_path / "bridge" / "server",
    ):
        directory.mkdir(parents=True, exist_ok=True)
    (repo / "nested" / "file.txt").write_text("fixture", encoding="utf-8")
    (repo / "escape").symlink_to(tmp_path / "outside", target_is_directory=True)
    (repo / "inside").symlink_to(repo / "nested", target_is_directory=True)
    (repo / "loop").symlink_to(repo / "loop", target_is_directory=True)
    monkeypatch.chdir(repo)
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(
        agent_runner,
        "__file__",
        str(
            tmp_path
            / ("absent" if case.get("missing_bridge") else "bridge")
            / "server"
            / "agent_runner.py"
        ),
    )
    for name, value in zip(
        ("REPOCIV_MAP_ROOT", "REPOCIV_REPOS_ROOT", "WORKSPACE_ROOT"), case.get("env", ["", "", ""])
    ):
        monkeypatch.setenv(name, expand(value))
    events = []

    def active_root():
        events.append(["active-root"])
        if case.get("raise"):
            raise ValueError("state unavailable")
        return expand(case.get("active", ""))

    def resolve_selected_repo(city, repo_path):
        events.append(["selected-repo", city, repo_path])
        if case.get("raise"):
            raise ValueError("selection unavailable")
        return str(repo) if case.get("selected") else None

    monkeypatch.setattr(
        agent_runner,
        "_rrs",
        SimpleNamespace(active_root=active_root, resolve_selected_repo=resolve_selected_repo),
    )
    kind = case["kind"]
    if kind == "spatial":

        def repos_root():
            events.append(["repos-root"])
            if case.get("raise"):
                raise ValueError("root unavailable")
            return str(tmp_path / "repos con espacios")

        monkeypatch.setattr(agent_runner, "_repos_root", repos_root)
    if kind == "file":
        original_guard = agent_runner._path_is_within

        def guard(candidate, root):
            events.append(["within", candidate, root])
            return False if case.get("deny") else original_guard(candidate, root)

        monkeypatch.setattr(agent_runner, "_path_is_within", guard)
    try:
        if kind == "root":
            result = agent_runner._repos_root()
        elif kind == "workdir":
            result = agent_runner.resolve_agent_working_dir(
                case["city"], expand(case.get("repo", ""))
            )
        elif kind == "file":
            result = agent_runner.resolve_absolute_file_path(
                "" if case.get("cwd_root") else str(repo), expand(case["file"])
            )
        elif kind == "within":
            result = agent_runner._path_is_within(expand(case["candidate"]), str(repo))
        else:
            result = agent_runner._spatial_context_block(case["city"], expand(case.get("cwd")))
        outcome = {"result": result}
    except Exception as exc:
        outcome = {"error": [type(exc).__name__, str(exc)]}
    outcome["events"] = events
    return json.loads(json.dumps(outcome, ensure_ascii=False).replace(str(tmp_path), "$FIXTURE"))


def _golden_outcome(golden, case):
    expected = golden["cases"][case["id"]]
    if case["id"] == "root-tilde":
        # Preserve the original capture bytes; normalize only its captured HOME.
        # Unlike Path.home(), expanduser reads HOME, now isolated in _exercise.
        captured_path = Path(expected["result"])
        expected = {
            **expected,
            "result": str(Path("$FIXTURE/home") / captured_path.relative_to(captured_path.parent)),
        }
    return expected


# CPython 3.12 changed the embedded-NUL failure from "embedded null byte" to
# "lstat: embedded null character in path". The golden below was captured on
# 3.11 (the CI interpreter); the wording is a stdlib detail, not the path
# behavior this characterization protects, and both 3.11 and 3.12 are
# supported (pyproject requires-python >=3.11).
_EMBEDDED_NULL_MESSAGE = re.compile(r"^(?:[a-z_]+: )?embedded null character in path$")


def _canonical_error_message(message):
    if _EMBEDDED_NULL_MESSAGE.match(message):
        return "embedded null byte"
    return message


def _canonical_outcome(outcome):
    """Normalize interpreter-specific stdlib wording before comparing to the golden."""
    if "error" not in outcome:
        return outcome
    kind, message = outcome["error"]
    return {**outcome, "error": [kind, _canonical_error_message(message)]}


@pytest.mark.parametrize("case", _cases(), ids=lambda case: case["id"])
def test_original_path_characterization(case, tmp_path, monkeypatch):
    golden = json.loads(
        (Path(__file__).parent / "fixtures" / "agent_paths.json").read_text(encoding="utf-8")
    )
    actual = _canonical_outcome(_exercise(case, tmp_path, monkeypatch))
    assert actual == _canonical_outcome(_golden_outcome(golden, case))


@pytest.mark.parametrize("city", ["MAIN", "CaPiTaL"])
def test_special_city_branches_are_case_insensitive(city, tmp_path, monkeypatch):
    def reject_selection(*args):
        pytest.fail("special city must not consult repository selection")

    monkeypatch.setattr(
        agent_runner, "_rrs", SimpleNamespace(resolve_selected_repo=reject_selection)
    )
    monkeypatch.setattr(agent_runner, "__file__", str(tmp_path / "bridge/server/agent_runner.py"))
    expected = None if city == "MAIN" else str(tmp_path / "bridge")
    assert agent_runner.resolve_agent_working_dir(city_id=city) == expected


def test_capital_absolutizes_relative_runner_file(tmp_path, monkeypatch):
    def reject_selection(*args):
        pytest.fail("capital must not consult repository selection")

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(agent_runner, "__file__", "bridge/server/agent_runner.py")
    monkeypatch.setattr(
        agent_runner, "_rrs", SimpleNamespace(resolve_selected_repo=reject_selection)
    )
    assert agent_runner.resolve_agent_working_dir("capital") == str(tmp_path / "bridge")


@pytest.mark.parametrize("candidate", ["", "relative/path"])
def test_mixed_absolute_relative_containment_keeps_valueerror_fallback(candidate, tmp_path):
    assert agent_runner._path_is_within(candidate, str(tmp_path)) is False


def test_file_guard_is_late_bound_after_realpath(monkeypatch, tmp_path):
    original_realpath = agent_runner.os.path.realpath
    checked = []

    def deny(path, root):
        checked.append((path, root))
        return False

    def realpath(path):
        monkeypatch.setattr(agent_runner, "_path_is_within", deny)
        return original_realpath(path)

    monkeypatch.setattr(agent_runner.os.path, "realpath", realpath)
    with pytest.raises(ValueError, match="^file path is outside selected repo$"):
        agent_runner.resolve_absolute_file_path(repo_path=str(tmp_path), file_path="file.txt")
    assert checked == [(str(tmp_path / "file.txt"), str(tmp_path))]


@pytest.mark.parametrize(
    "scenario", ["relative", "absolute", "unselected", "traversal", "symlink", "repo-less"]
)
def test_run_agent_path_boundary_with_fake_execution(scenario, tmp_path, monkeypatch):
    """Real selection/path checks with fake adapter, stores and event outputs."""
    root = tmp_path / "root"
    selected = root / "selected"
    unselected = root / "unselected"
    outside = tmp_path / "outside"
    for directory in (selected, unselected, outside):
        directory.mkdir(parents=True)
    (selected / "escape").symlink_to(outside, target_is_directory=True)
    state = tmp_path / "state.json"
    state.write_text(
        json.dumps(
            {
                "version": 1,
                "activeRoot": str(root),
                "roots": {str(root): {"selectedRepoPaths": [str(selected)]}},
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state))
    events, failures, executions = [], [], []
    noop = lambda *args, **kwargs: None
    monkeypatch.setattr(agent_runner, "save_mission", noop)
    monkeypatch.setattr(agent_runner, "send_to_repociv", events.append)
    monkeypatch.setattr(
        agent_runner,
        "_es",
        SimpleNamespace(
            record_failed=lambda *args: failures.append(args),
            record_started=noop,
            record_completed=noop,
        ),
    )
    monkeypatch.setattr(agent_runner, "_ds", SimpleNamespace(record_outcome=noop))
    monkeypatch.setattr(agent_runner, "_sessions", SimpleNamespace(patch=noop, append_message=noop))
    monkeypatch.setattr(agent_runner, "_run_state", SimpleNamespace(save=noop, patch=noop))
    monkeypatch.setattr(
        agent_runner,
        "_runtime_adapters",
        SimpleNamespace(default_agent_runtime=lambda unit: SimpleNamespace(harness_id="fake")),
    )
    monkeypatch.setattr(
        agent_runner,
        "_token_ledger",
        SimpleNamespace(get_ledger=lambda: SimpleNamespace(log_usage=noop)),
    )
    monkeypatch.setattr(agent_runner, "_infer_model_label", lambda unit: "fake")

    def execute(*args, **kwargs):
        executions.append((args, kwargs))
        return True, "fake output"

    monkeypatch.setattr(agent_runner, "_execute_streaming", execute)
    city, repo_path, file_path = "selected", str(selected), "file.txt"
    if scenario == "absolute":
        file_path = str(selected / "file.txt")
    elif scenario == "unselected":
        city, repo_path = "unselected", str(unselected)
    elif scenario == "traversal":
        file_path = "../../outside/secret.txt"
    elif scenario == "symlink":
        file_path = "escape/secret.txt"
    elif scenario == "repo-less":
        city, repo_path = "main", ""
    agent_runner.run_agent(
        "MAIN",
        city,
        "inspect fixture",
        command_id="fixture-mission",
        repo_path=repo_path,
        file_path=file_path,
    )
    if scenario in {"relative", "absolute"}:
        assert not failures
        assert len(executions) == 1
        args, _ = executions[0]
        assert args[3:] == (str(selected), "selected")
        assert (
            args[2]
            == f"Trabaja en el archivo: `{selected / 'file.txt'}`\nInstrucción: inspect fixture"
        )
        assert any(event["type"] == "mission_complete" and event["success"] for event in events)
    else:
        assert not executions
        expected = {
            "unselected": "repoPath is not a selected RepoCiv repository",
            "traversal": "file path is outside selected repo",
            "symlink": "file path is outside selected repo",
            "repo-less": "filePath requires a selected repository",
        }[scenario]
        assert failures == [("fixture-mission", expected)]
        assert any(event["type"] == "log" and event["msg"] == expected for event in events)
