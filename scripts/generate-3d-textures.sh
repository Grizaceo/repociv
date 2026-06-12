#!/usr/bin/env bash
set -euo pipefail
BLENDER="${BLENDER:-blender}"
if ! command -v "$BLENDER" >/dev/null 2>&1; then
  echo "[RepoCiv] Blender not found. Set BLENDER=/path/to/blender or install blender in PATH." >&2
  exit 127
fi
echo "[RepoCiv] generating terrain texture atlas with Blender..."
"$BLENDER" --background --factory-startup --python scripts/generate-3d-texture-atlas.py
echo "[RepoCiv] atlas generation complete"
