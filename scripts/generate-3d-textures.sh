#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "[RepoCiv] generating terrain texture atlas (numpy + PIL)..."
python3 scripts/generate-3d-texture-atlas.py
echo "[RepoCiv] atlas generation complete"
