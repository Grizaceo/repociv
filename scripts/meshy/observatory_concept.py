"""One authorized Observatory concept, reusing the tested single-submit runner.

State and spec are isolated from Workshop. GET-only resume after a saved task;
exclusive marker prevents duplicate POST after an ambiguous failure.
"""
from pathlib import Path

import workshop_concept as runner

OUT = Path(__file__).resolve().parents[2] / "assets-src/meshy/observatory"


def main():
    runner.OUT = OUT
    runner.main()


if __name__ == "__main__":
    main()
