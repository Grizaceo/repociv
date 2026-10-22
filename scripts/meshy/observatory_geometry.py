"""One authorized 5-credit Observatory mesh using the tested locked runner."""
from contextlib import contextmanager
from pathlib import Path

import workshop_geometry as runner

ASSET = Path(__file__).resolve().parents[2] / "assets-src/meshy/observatory"
SOURCE_ID = "01a165ed-d906-7099-bd79-6b08b87b95b8"


@contextmanager
def configured():
    previous = runner.ASSET, runner.OUT, runner.SOURCE_ID
    runner.ASSET, runner.OUT, runner.SOURCE_ID = ASSET, ASSET / "geometry", SOURCE_ID
    try:
        yield
    finally:
        runner.ASSET, runner.OUT, runner.SOURCE_ID = previous


def main():
    with configured():
        runner.main()


if __name__ == "__main__":
    main()
