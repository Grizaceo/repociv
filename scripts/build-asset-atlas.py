#!/usr/bin/env python3
"""
RepoCiv Asset Atlas Generator
Produces terrain-atlas.webp + decor-atlas.webp(+.png fallback) + asset-atlas.json
from the original 10 individual PNGs in public/assets/.
"""

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "public" / "assets"
CELL = 1024

TERRAIN_TILES = ["plains", "forest", "desert", "ocean", "mountain", "ice", "fog"]
DECOR_TILES = ["hill_sprite", "mountain_sprite", "forest_sprite"]


def load_source(name: str, prefix: str = "terrain_") -> Image.Image:
    """Load a source PNG by logical name."""
    if name == "fog":
        path = ASSETS_DIR / "fog_parchment.png"
    elif prefix == "terrain_":
        path = ASSETS_DIR / f"terrain_{name}.png"
    else:
        path = ASSETS_DIR / f"{name}.png"
    if not path.exists():
        sys.exit(f"ERROR: source not found: {path}")
    img = Image.open(path).convert("RGBA")
    if img.size != (CELL, CELL):
        print(f"  WARN: {path.name} is {img.size}, resizing to {CELL}x{CELL}")
        img = img.resize((CELL, CELL), Image.LANCZOS)
    return img


def build_terrain_atlas() -> tuple[Image.Image, dict[str, list[int]]]:
    """7 terrain tiles → 1 horizontal strip (7168x1024)."""
    total_w = CELL * len(TERRAIN_TILES)
    canvas = Image.new("RGBA", (total_w, CELL), (0, 0, 0, 0))
    rects: dict[str, list[int]] = {}
    for i, name in enumerate(TERRAIN_TILES):
        tile = load_source(name)
        x0 = i * CELL
        canvas.paste(tile, (x0, 0))
        rects[name] = [x0, 0, x0 + CELL, CELL]
    return canvas, rects


def chroma_key_white(img: Image.Image, threshold: int = 240) -> Image.Image:
    """Make white/very-near-white pixels transparent using pixel-level access."""
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if r > threshold and g > threshold and b > threshold:
                px[x, y] = (r, g, b, 0)
    return img


def build_decor_atlas() -> tuple[Image.Image, dict[str, list[int]]]:
    """3 decor tiles → 1 horizontal strip (3072x1024) with chroma-key alpha."""
    total_w = CELL * len(DECOR_TILES)
    canvas = Image.new("RGBA", (total_w, CELL), (0, 0, 0, 0))
    rects: dict[str, list[int]] = {}
    for i, name in enumerate(DECOR_TILES):
        tile = load_source(name, prefix="decor_")
        tile = chroma_key_white(tile)
        x0 = i * CELL
        canvas.paste(tile, (x0, 0))
        rects[name] = [x0, 0, x0 + CELL, CELL]
    return canvas, rects


def save_webp(img: Image.Image, path: Path, quality: int = 85) -> int:
    """Save image as WebP; returns file size in bytes."""
    img.save(str(path), "WEBP", quality=quality)
    return path.stat().st_size


def save_png_optimized(img: Image.Image, path: Path) -> int:
    """Save as PNG, run pngquant if available; returns file size."""
    img.save(str(path), "PNG", optimize=True)
    # Try pngquant if present
    try:
        subprocess.run(
            ["pngquant", "--force", "-o", str(path), "--quality=65-80", str(path)],
            check=True, capture_output=True, timeout=30,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        pass  # pngquant not available, keep unoptimized PNG
    return path.stat().st_size


def main() -> None:
    print("=== RepoCiv Asset Atlas Generator ===\n")

    # ── Measure before ──
    before_bytes = sum(
        f.stat().st_size for f in ASSETS_DIR.iterdir()
        if f.suffix in (".png", ".webp", ".json") and f.is_file()
    )
    print(f"Assets before: {before_bytes / 1024:.0f} KB ({len(list(ASSETS_DIR.glob('*.png')))} PNGs)\n")

    # ── Terrain atlas ──
    print("Building terrain atlas (7 tiles)...")
    terrain_img, terrain_rects = build_terrain_atlas()
    terrain_path = ASSETS_DIR / "terrain-atlas.webp"
    terrain_size = save_webp(terrain_img, terrain_path, quality=85)
    print(f"  → {terrain_path.name}  ({terrain_size / 1024:.0f} KB)")

    # ── Decor atlas ──
    print("Building decor atlas (3 tiles, chroma-key alpha)...")
    decor_img, decor_rects = build_decor_atlas()
    decor_webp_path = ASSETS_DIR / "decor-atlas.webp"
    decor_png_path = ASSETS_DIR / "decor-atlas.png"

    # Always generate PNG first (most reliable alpha)
    decor_png_size = save_png_optimized(decor_img, decor_png_path)
    print(f"  → {decor_png_path.name}  ({decor_png_size / 1024:.0f} KB)")

    # Also try WebP
    decor_webp_size = save_webp(decor_img, decor_webp_path, quality=85)
    print(f"  → {decor_webp_path.name}  ({decor_webp_size / 1024:.0f} KB)")

    # Decide decor format: prefer WebP if Pillow version supports alpha cleanly
    # For safety, default to PNG for decor (no alpha halo risk)
    decor_format = "decor-atlas.png"

    # ── Manifest ──
    manifest = {
        "terrainAtlas": "/assets/terrain-atlas.webp",
        "decorAtlas": f"/assets/{decor_format}",
        "cellSize": CELL,
        "terrainRects": terrain_rects,
        "decorRects": decor_rects,
    }
    manifest_path = ASSETS_DIR / "asset-atlas.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"\nManifest → {manifest_path.name}")

    # ── Summary ──
    after_bytes = sum(
        f.stat().st_size for f in ASSETS_DIR.iterdir()
        if f.suffix in (".png", ".webp", ".json") and f.is_file()
    )
    print("\n=== Results ===")
    print(f"Before: {before_bytes / 1024:.0f} KB")
    print(f"After:  {after_bytes / 1024:.0f} KB")
    print(f"Delta:  {(before_bytes - after_bytes) / 1024:.0f} KB saved ({100*(1-after_bytes/before_bytes):.0f}%)")
    print("\nDone. Output files:")
    for f in sorted(ASSETS_DIR.iterdir()):
        if f.suffix in (".png", ".webp", ".json") and "atlas" in f.name:
            print(f"  {f.relative_to(REPO_ROOT)}  ({f.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
