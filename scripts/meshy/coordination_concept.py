"""Authorized Coordination Court concept; isolated state and single-submit guard."""
from pathlib import Path

import workshop_concept as runner

OUT = Path(__file__).resolve().parents[2] / "assets-src/meshy/coordination-court"


def main():
    previous = runner.OUT
    try:
        runner.OUT = OUT
        runner.main()
    finally:
        runner.OUT = previous


if __name__ == "__main__":
    main()
