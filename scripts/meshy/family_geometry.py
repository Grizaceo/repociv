"""Four approved concept sources; one locked untextured mesh per member."""
from contextlib import contextmanager
import json
from pathlib import Path
import sys

import workshop_geometry as runner

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    "coordination-court": "01a1671a-f9d4-73d6-a6f8-4f355a98d320",
    "connection-gateway": "01a16725-6eb0-749e-afd3-033746f0af79",
    "artifact-vault": "01a16725-ffa4-75b0-ade2-4b75561d7dfa",
    "research-laboratory": "01a16726-8dad-74f3-a9a3-44faf2b3bd22",
}


@contextmanager
def configured(asset):
    if asset not in SOURCES:
        raise ValueError("Select an authorized member; Plaza still requires image correction")
    path = ROOT / "assets-src/meshy" / asset
    if "artist-approved" not in json.loads((path / "spec.json").read_text())["status"]:
        raise ValueError("Concept artistic approval missing")
    previous = runner.ASSET, runner.OUT, runner.SOURCE_ID
    runner.ASSET, runner.OUT, runner.SOURCE_ID = path, path / "geometry", SOURCES[asset]
    try:
        yield
    finally:
        runner.ASSET, runner.OUT, runner.SOURCE_ID = previous


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
