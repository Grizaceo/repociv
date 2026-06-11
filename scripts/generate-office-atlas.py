#!/usr/bin/env python3
"""Generate procedural office-atlas for RepoCiv local view.

Produces:
  - public/assets/office-atlas.webp  (atlas image, 640x192, 5 cols x 3 rows)
  - public/assets/office-atlas.json  (manifest consumed by src/officeAtlas.ts)

Run via:
  python scripts/generate-office-atlas.py
  # or
  npm run assets:office

The JSON manifest is what the frontend actually imports; the image
URL is just a key in the JSON (the actual asset path can be swapped
to a hand-curated .svg if you want a higher-fidelity look — see
public/assets/office-atlas.svg for the current canonical).
"""
from __future__ import annotations

import json
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit('Pillow required: pip install pillow')

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'public' / 'assets'
OUT_IMG = ASSETS / 'office-atlas.webp'
OUT_JSON = ASSETS / 'office-atlas.json'

W, H = 640, 192
CELL_W, CELL_H = 128, 64

# (name, col, row, primary, accent). Layout: 5 columns, 3 rows.
SPRITES = [
    ('desk_l', 0, 0, '#B09060', '#D0D0D0'),
    ('desk_r', 1, 0, '#B09060', '#D0D0D0'),
    ('chair', 2, 0, '#B08090', None),
    ('partition_h', 3, 0, '#A8B0C0', None),
    ('partition_v', 4, 0, '#98A8B8', None),
    ('reception_desk', 0, 1, '#C4A880', '#D8DCE0'),
    ('watercooler', 1, 1, '#B0C8E0', '#E8F0FF'),
    ('plant', 2, 1, '#608860', '#90B090'),
    ('whiteboard', 3, 1, '#E8E8E8', '#4A90D4'),
    ('ceiling_light', 4, 1, '#F0E8D0', '#FFF8E0'),
    ('carpet_tile', 0, 2, '#9A8A7A', None),
]


def draw_sprite(draw: ImageDraw.ImageDraw, col: int, row: int, primary: str, accent: str | None) -> None:
    x0, y0 = col * CELL_W, row * CELL_H
    x1, y1 = x0 + CELL_W, y0 + CELL_H
    draw.rectangle([x0, y0, x1, y1], fill='#2A2A2E')
    cx, cy = x0 + CELL_W // 2, y0 + CELL_H // 2

    if accent:
        # Desk / monitor style
        draw.polygon(
            [(cx - 40, cy + 8), (cx, cy - 12), (cx + 40, cy + 8), (cx, cy + 20)],
            fill=primary,
        )
        draw.rectangle([cx - 22, cy - 28, cx + 22, cy - 10], fill=accent)
        draw.rectangle([cx - 18, cy - 26, cx + 18, cy - 12], fill='#1a2030')
    elif primary == '#B08090':
        draw.ellipse([cx - 18, cy - 4, cx + 18, cy + 16], fill=primary)
        draw.ellipse([cx - 6, cy + 14, cx + 6, cy + 22], fill='#888')
    elif primary.startswith('#9') or primary.startswith('#A8'):
        # Partition
        draw.rectangle([x0 + 20, y0 + 18, x1 - 20, y1 - 18], fill=primary)
        draw.line([(x0 + 24, y0 + 22), (x1 - 24, y1 - 22)], fill='#788898', width=2)
    elif primary == '#608860':
        draw.rectangle([cx - 14, cy + 4, cx + 14, cy + 20], fill='#8B7355')
        draw.ellipse([cx - 20, cy - 18, cx + 20, cy + 6], fill=primary)
    elif primary == '#B0C8E0':
        draw.rectangle([cx - 12, cy - 16, cx + 12, cy + 18], fill=primary)
        draw.ellipse([cx - 8, cy - 22, cx + 8, cy - 10], fill=accent or '#fff')
    elif primary == '#E8E8E8':
        draw.rectangle([x0 + 16, y0 + 12, x1 - 16, y1 - 12], fill=primary)
        draw.line([(x0 + 32, y0 + 20), (x1 - 32, y1 - 20)], fill=accent or '#000', width=3)
    elif primary == '#F0E8D0':
        draw.ellipse([cx - 28, cy - 10, cx + 28, cy + 18], fill=accent or '#fff')
        draw.ellipse([cx - 12, cy - 4, cx + 12, cy + 10], fill='#FFE8A0')
    else:
        draw.rectangle([x0 + 8, y0 + 8, x1 - 8, y1 - 8], fill=primary)


def sprite_rect(col: int, row: int) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1) in atlas pixels for a sprite at (col, row)."""
    x0, y0 = col * CELL_W, row * CELL_H
    return (x0, y0, x0 + CELL_W, y0 + CELL_H)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)

    # Image.
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for _name, col, row, primary, accent in SPRITES:
        draw_sprite(draw, col, row, primary, accent)
    img.save(OUT_IMG, 'WEBP', quality=90)
    print(f'Wrote {OUT_IMG} ({W}x{H})')

    # Manifest.
    sprite_rects = {name: list(sprite_rect(col, row)) for name, col, row, _p, _a in SPRITES}
    manifest = {
        'atlas': '/assets/office-atlas.webp',
        'cellWidth': CELL_W,
        'cellHeight': CELL_H,
        'spriteRects': sprite_rects,
    }
    OUT_JSON.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'Wrote {OUT_JSON} ({len(sprite_rects)} sprites)')


if __name__ == '__main__':
    main()
