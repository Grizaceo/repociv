"""One Plaza mesh using the inspected corrected image, never defective original."""
from contextlib import contextmanager
from pathlib import Path

import workshop_geometry as runner

ASSET = Path(__file__).resolve().parents[2] / "assets-src/meshy/civic-plaza"
SOURCE_ID = "01a16734-64bb-75ab-9c44-0dd077f2e2cc"


@contextmanager
def configured():
    previous = runner.ASSET, runner.OUT, runner.SOURCE_ID
    runner.ASSET = ASSET / "image-correction"
    runner.OUT = ASSET / "geometry"
    runner.SOURCE_ID = SOURCE_ID
    try:
        yield
    finally:
        runner.ASSET, runner.OUT, runner.SOURCE_ID = previous


def main():
    with configured():
        runner.main()


if __name__ == "__main__":
    main()
