from server import tech_debt


def test_scan_tech_debt_detects_markers_and_uses_cache(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    src = repo / "main.py"
    src.write_text("# TODO tech debt: split this\nprint('ok')\n", encoding="utf-8")

    monkeypatch.setattr(tech_debt, "_TD_CACHE", {})
    first = tech_debt.scan_tech_debt(str(tmp_path))
    assert len(first) == 1
    assert first[0]["repo"] == "repo"
    assert first[0]["severity"] == "high"

    src.write_text("print('clean')\n", encoding="utf-8")
    second = tech_debt.scan_tech_debt(str(tmp_path))
    assert second == first
