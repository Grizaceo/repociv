"""Approved settlement concepts; one locked untextured mesh per authorized member."""
from contextlib import contextmanager
import json
from pathlib import Path
import sys

import workshop_geometry as runner

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    "city-dwelling": "01a16b95-ea91-72d9-9172-63c020bf965e",
    "city-guild": "01a16bbb-3d5b-7487-ad55-38daf6e26b2b",
    "city-forum": "01a16bbc-2154-704a-ba19-e90b9d99c619",
    "city-citadel": "01a16bbc-d63e-7336-8a24-dd5ed260d433",
}
TARGET_POLYCOUNT = 3000


@contextmanager
def configured(asset):
    if asset not in SOURCES:
        raise ValueError("Select an authorized settlement member with an approved concept")
    path = ROOT / "assets-src/meshy" / asset
    spec = json.loads((path / "spec.json").read_text())
    if "artist-approved" not in spec["status"]:
        raise ValueError("Concept artistic approval missing")
    request = spec["geometry_after_concept_approval"]["request_without_input_task_id"]
    if request.get("target_polycount") != TARGET_POLYCOUNT:
        raise ValueError("Settlement geometry is locked to 3000 triangles")
    previous = runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT
    runner.ASSET, runner.OUT, runner.SOURCE_ID = path, path / "geometry", SOURCES[asset]
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
