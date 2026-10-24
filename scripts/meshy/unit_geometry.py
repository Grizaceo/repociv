"""Approved unit concepts; one locked untextured mesh per authorized figurine."""
from contextlib import contextmanager
import json
from pathlib import Path
import sys

import workshop_geometry as runner

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    "unit-coordinator": "01a16c24-00fe-76f9-ae51-df9f162c5b81",
    "unit-builder": "01a16c24-d1f3-7631-9fdc-b2e01f2ce360",
    "unit-ranger": "01a16c25-4690-71aa-bfe8-96cf37dcd0e4",
    "unit-guardian": "01a16c25-ef25-70b9-a75e-6ac9fb8caaef",
    "unit-builder-v002": "01a16c40-7b90-71a1-891e-cc8b04267dcd",
}
TARGET_POLYCOUNT = 2000


def asset_paths(asset):
    """Concept folder (spec + I2I generation) and geometry output folder."""
    if asset == "unit-builder-v002":
        parent = ROOT / "assets-src/meshy/unit-builder"
        return parent / "concept-v002", parent / "geometry-v002"
    path = ROOT / "assets-src/meshy" / asset
    return path, path / "geometry"


@contextmanager
def configured(asset):
    if asset not in SOURCES:
        raise ValueError("Select an authorized unit with an approved concept")
    path, out = asset_paths(asset)
    spec = json.loads((path / "spec.json").read_text())
    if "artist-approved" not in spec["status"]:
        raise ValueError("Concept artistic approval missing")
    request = spec["geometry_after_concept_approval"]["request_without_input_task_id"]
    if request.get("target_polycount") != TARGET_POLYCOUNT:
        raise ValueError("Unit geometry is locked to 2000 triangles")
    previous = runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT
    runner.ASSET, runner.OUT, runner.SOURCE_ID = path, out, SOURCES[asset]
    runner.TARGET_POLYCOUNT = TARGET_POLYCOUNT
    try:
        yield
    finally:
        runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT = previous


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in SOURCES:
        raise SystemExit("Select one of: " + ", ".join(SOURCES))
    argv = sys.argv
    try:
        with configured(argv[1]):
            sys.argv = [argv[0], *argv[2:]]
            runner.main()
    finally:
        sys.argv = argv


if __name__ == "__main__":
    main()
