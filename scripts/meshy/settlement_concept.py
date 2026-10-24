"""Single-submit entrypoint for Wave 1 Step 2 settlement concepts. Never retry POST."""
import sys
from pathlib import Path

import workshop_concept as runner

ASSETS = ("city-dwelling", "city-guild", "city-forum", "city-citadel")
ROOT = Path(__file__).resolve().parents[2]


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ASSETS:
        raise SystemExit("Select one authorized settlement asset: " + ", ".join(ASSETS))
    asset = sys.argv[1]
    previous_out, previous_argv = runner.OUT, sys.argv
    try:
        runner.OUT = ROOT / "assets-src/meshy" / asset
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        runner.main()
    finally:
        runner.OUT, sys.argv = previous_out, previous_argv


if __name__ == "__main__":
    main()
