#!/usr/bin/env bash
set -euo pipefail
BLENDER="${BLENDER:-/home/gris/tools/blender/blender-5.1.2-linux-x64/blender}"
echo "[DAVI] generating terrain texture atlas with Blender..."
"$BLENDER" --background --factory-startup --python scripts/generate-3d-texture-atlas.py
echo "[DAVI] atlas generation complete"
