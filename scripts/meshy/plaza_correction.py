"""One explicit Plaza image restoration; keep the approved original immutable."""
from pathlib import Path
import workshop_concept as runner

OUT = Path(__file__).resolve().parents[2] / "assets-src/meshy/civic-plaza/image-correction"


def main():
    previous = runner.OUT
    runner.OUT = OUT
    try:
        runner.main()
    finally:
        runner.OUT = previous


if __name__ == "__main__":
    main()
