from server import run_state


def test_save_and_load_run_state(tmp_path):
    run_state.init(tmp_path)
    saved = run_state.save("m1", {
        "unitId": "DAVI",
        "runtimeId": "hermes-local",
        "status": "running",
        "phase": "executing",
    })

    loaded = run_state.load("m1")
    assert saved["missionId"] == "m1"
    assert loaded is not None
    assert loaded["unitId"] == "DAVI"
    assert loaded["status"] == "running"


def test_patch_run_state(tmp_path):
    run_state.init(tmp_path)
    run_state.save("m2", {"status": "running", "retries": 0})
    updated = run_state.patch("m2", status="completed", retries=1, filesTouched=["a.py"])

    assert updated["status"] == "completed"
    assert updated["retries"] == 1
    assert updated["filesTouched"] == ["a.py"]

    loaded = run_state.load("m2")
    assert loaded is not None
    assert loaded["status"] == "completed"
