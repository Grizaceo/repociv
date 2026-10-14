#!/usr/bin/env python3
"""RepoCiv 2D Asset Atlas Generator (Phase 2 — SBS Hex Tiles + Kenney Buildings).

Generates:
  - public/assets/hex-tiles-2d.webp  (pointy-topped 2.5D bevelled hex tiles from SBS CC0)
  - public/assets/terrain-atlas.webp (seamless 512x512 terrain pattern fallback)
  - public/assets/decor-atlas.png    (transparent terrain props + 4 Kenney city level clusters)
  - public/assets/asset-atlas.json   (manifest consumed by src/hexRenderer.ts)
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "public" / "assets"
SRC_DIR = REPO_ROOT / "scripts" / "assets_src"
SBS_PATH = SRC_DIR / "sbs_hex_terrain.png"
KENNEY_HB_DIR = SRC_DIR / "kenney_hb"

HEX_CELL = 256
DECOR_CELL = 512

TERRAIN_ORDER = [
    "plains",
    "forest",
    "desert",
    "ocean",
    "mountain",
    "ice",
    "hills",
    "sacred",
    "fog",
]

# Mapping from RepoCiv terrain -> (row, col) in SBS 6x3 128x144 sheet
SBS_CELL_MAP: dict[str, tuple[int, int]] = {
    "plains": (2, 1),    # lush green grass
    "forest": (2, 2),    # dense pine forest
    "desert": (1, 1),    # golden sand dunes
    "ocean": (2, 4),     # deep water caustics
    "mountain": (1, 3),  # dark craggy rock
    "ice": (0, 5),       # glacial blue ice
    "hills": (0, 2),     # mossy highland hills
    "sacred": (2, 3),    # ancient mossy cobblestone
    "fog": (1, 0),       # pale parchment mist base
}


def _pointy_hex_vertices(cx: float, cy: float, radius: float) -> list[tuple[float, float]]:
    """Return the 6 vertices of a pointy-topped hexagon matching src/hexRenderer.ts."""
    pts: list[tuple[float, float]] = []
    for i in range(6):
        angle = math.radians(60 * i - 30)
        pts.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return pts


def _extract_sbs_texture(sbs_sheet: Image.Image, row: int, col: int, size: int) -> Image.Image:
    """Extract the inner seamless painted patch from a 128x144 SBS cell and tile/upscale it."""
    cell_w, cell_h = 128, 144
    x0 = col * cell_w
    y0 = row * cell_h
    # The safe interior of the flat-topped 128x128 top face is [30..98, 26..94] (68x68)
    patch = sbs_sheet.crop((x0 + 30, y0 + 26, x0 + 98, y0 + 94)).convert("RGBA")

    # Create a 2x2 mirrored quilt of the patch so there are no hard seams when scaled
    quilt = Image.new("RGBA", (136, 136))
    quilt.paste(patch, (0, 0))
    quilt.paste(patch.transpose(Image.FLIP_LEFT_RIGHT), (68, 0))
    quilt.paste(patch.transpose(Image.FLIP_TOP_BOTTOM), (0, 68))
    quilt.paste(patch.transpose(Image.ROTATE_180), (68, 68))
    return quilt.resize((size, size), Image.LANCZOS)


def _build_bevelled_hex_tile(tex: Image.Image, terrain: str) -> Image.Image:
    """Mask a square texture into a 2.5D bevelled pointy-topped hex sprite (256x256)."""
    canvas = Image.new("RGBA", (HEX_CELL, HEX_CELL), (0, 0, 0, 0))
    cx, cy = HEX_CELL / 2.0, HEX_CELL / 2.0 - 3.0
    radius = HEX_CELL * 0.465
    lip_h = 7.0

    verts = _pointy_hex_vertices(cx, cy, radius)
    # Vertices index (angle = 60*i - 30):
    # 0: NE (-30°), 1: SE (30°), 2: S (90°), 3: SW (150°), 4: NW (210°), 5: N (270°)

    if terrain == "fog":
        # Tint parchment mist for fog of war
        tex = ImageEnhance.Color(tex).enhance(0.25)
        tex = ImageEnhance.Brightness(tex).enhance(0.42)

    # 1. Draw 2.5D extruded lower cliff lip along bottom edges (1->2 and 2->3)
    dark_tex = ImageEnhance.Brightness(tex).enhance(0.58)
    lip_mask = Image.new("L", (HEX_CELL, HEX_CELL), 0)
    lip_draw = ImageDraw.Draw(lip_mask)
    for a, b in ((verts[1], verts[2]), (verts[2], verts[3]), (verts[0], verts[1]), (verts[3], verts[4])):
        poly = [a, b, (b[0], b[1] + lip_h), (a[0], a[1] + lip_h)]
        lip_draw.polygon(poly, fill=255)
    canvas.paste(dark_tex, (0, 0), lip_mask)

    # 2. Paste top face masked to pointy-topped hex
    top_mask = Image.new("L", (HEX_CELL, HEX_CELL), 0)
    ImageDraw.Draw(top_mask).polygon(verts, fill=255)
    canvas.paste(tex, (0, 0), top_mask)

    # 3. Inner boardgame bevel + subtle rim (inspired by tranberry-bysa3-gameboard.jpg)
    overlay = Image.new("RGBA", (HEX_CELL, HEX_CELL), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    # Sunlit NW/N/NE edges (3->4, 4->5, 5->0)
    for i in (3, 4, 5):
        a, b = verts[i], verts[(i + 1) % 6]
        odraw.line([a, b], fill=(255, 248, 220, 78), width=3)
    # Shaded E/SE/SW edges (0->1, 1->2, 2->3)
    for i in (0, 1, 2):
        a, b = verts[i], verts[(i + 1) % 6]
        odraw.line([a, b], fill=(15, 12, 8, 115), width=3)

    # Subtle inner inset ring
    inner_verts = _pointy_hex_vertices(cx, cy, radius * 0.90)
    odraw.polygon(inner_verts, outline=(255, 245, 215, 28), width=1)

    return Image.alpha_composite(canvas, overlay)


def build_hex_and_terrain_atlases(
    sbs_sheet: Image.Image,
) -> tuple[Image.Image, dict[str, list[int]], Image.Image, dict[str, list[int]]]:
    """Build both the 2.5D hex sprite strip and the seamless square pattern strip."""
    hex_strip = Image.new("RGBA", (HEX_CELL * len(TERRAIN_ORDER), HEX_CELL), (0, 0, 0, 0))
    hex_rects: dict[str, list[int]] = {}

    pat_cell = 512
    pat_strip = Image.new("RGBA", (pat_cell * len(TERRAIN_ORDER), pat_cell), (0, 0, 0, 0))
    pat_rects: dict[str, list[int]] = {}

    for idx, name in enumerate(TERRAIN_ORDER):
        row, col = SBS_CELL_MAP[name]
        tex_hex = _extract_sbs_texture(sbs_sheet, row, col, HEX_CELL)
        hex_tile = _build_bevelled_hex_tile(tex_hex, name)
        hx0 = idx * HEX_CELL
        hex_strip.paste(hex_tile, (hx0, 0))
        hex_rects[name] = [hx0, 0, hx0 + HEX_CELL, HEX_CELL]

        tex_pat = _extract_sbs_texture(sbs_sheet, row, col, pat_cell)
        if name == "fog":
            tex_pat = ImageEnhance.Color(tex_pat).enhance(0.25)
            tex_pat = ImageEnhance.Brightness(tex_pat).enhance(0.42)
        px0 = idx * pat_cell
        pat_strip.paste(tex_pat, (px0, 0))
        pat_rects[name] = [px0, 0, px0 + pat_cell, pat_cell]

    return hex_strip, hex_rects, pat_strip, pat_rects


def _load_hb_piece(name: str, scale: float = 1.8) -> Image.Image:
    """Load a Kenney Hexagon Buildings tile piece and scale it cleanly."""
    img = Image.open(KENNEY_HB_DIR / f"{name}.png").convert("RGBA")
    w = max(1, round(img.width * scale))
    h = max(1, round(img.height * scale))
    return img.resize((w, h), Image.LANCZOS)


def _paste_centered(canvas: Image.Image, piece: Image.Image, cx: int, cy: int) -> None:
    x = round(cx - piece.width / 2)
    y = round(cy - piece.height / 2)
    canvas.alpha_composite(piece, (x, y))


def _draw_ground_shadow(canvas: Image.Image, cx: int, cy: int, rx: int, ry: int, gold_ring: bool = False) -> None:
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(12, 10, 8, 125))
    if gold_ring:
        draw.ellipse(
            [cx - rx - 6, cy - ry - 4, cx + rx + 6, cy + ry + 4],
            outline=(225, 185, 80, 190),
            width=3,
        )
    layer = layer.filter(ImageFilter.GaussianBlur(radius=3))
    canvas.alpha_composite(layer)


def _build_city_sprite(level: str) -> Image.Image:
    """Compose a 2D city cluster sprite from Kenney Hexagon Buildings (CC0)."""
    c = Image.new("RGBA", (DECOR_CELL, DECOR_CELL), (0, 0, 0, 0))
    cx, cy = DECOR_CELL // 2, DECOR_CELL // 2 + 30

    if level == "city_hamlet":
        _draw_ground_shadow(c, cx, cy + 28, 110, 48)
        # Left small wood cottage
        _paste_centered(c, _load_hb_piece("woodDoorLeft", 1.75), cx - 48, cy + 4)
        _paste_centered(c, _load_hb_piece("redRoofShort", 1.75), cx - 48, cy - 42)
        # Right stone cottage
        _paste_centered(c, _load_hb_piece("stoneDoorRight", 1.85), cx + 44, cy + 12)
        _paste_centered(c, _load_hb_piece("stoneRoofRounded", 1.85), cx + 44, cy - 36)

    elif level == "city_village":
        _draw_ground_shadow(c, cx, cy + 32, 138, 58)
        # Back 2-story guild hall
        _paste_centered(c, _load_hb_piece("stoneDoorWindow", 1.85), cx, cy - 22)
        _paste_centered(c, _load_hb_piece("stoneWindows", 1.85), cx, cy - 68)
        _paste_centered(c, _load_hb_piece("redRoofPointy", 1.85), cx, cy - 122)
        # Left house
        _paste_centered(c, _load_hb_piece("woodDoorWindow", 1.7), cx - 72, cy + 18)
        _paste_centered(c, _load_hb_piece("redRoofRounded", 1.7), cx - 72, cy - 26)
        # Right house
        _paste_centered(c, _load_hb_piece("sandDoorRight", 1.7), cx + 72, cy + 20)
        _paste_centered(c, _load_hb_piece("sandRoofShort", 1.7), cx + 72, cy - 24)

    elif level == "city_town":
        _draw_ground_shadow(c, cx, cy + 36, 156, 66)
        # Back tall watchtower
        _paste_centered(c, _load_hb_piece("stoneWindows", 1.85), cx - 42, cy - 28)
        _paste_centered(c, _load_hb_piece("stoneWindows", 1.85), cx - 42, cy - 76)
        _paste_centered(c, _load_hb_piece("redRoofTall", 1.85), cx - 42, cy - 134)
        # Right battlement tower
        _paste_centered(c, _load_hb_piece("sandWindows", 1.8), cx + 56, cy - 14)
        _paste_centered(c, _load_hb_piece("sandRing", 1.8), cx + 56, cy - 62)
        # Front market & gatehouse
        _paste_centered(c, _load_hb_piece("woodWindowBlinds", 1.75), cx - 74, cy + 24)
        _paste_centered(c, _load_hb_piece("redRoofStraight", 1.75), cx - 74, cy - 24)
        _paste_centered(c, _load_hb_piece("stoneGateLeft", 1.85), cx + 10, cy + 30)
        _paste_centered(c, _load_hb_piece("stoneRing", 1.85), cx + 10, cy - 18)

    else:  # city_capital
        _draw_ground_shadow(c, cx, cy + 40, 178, 76, gold_ring=True)
        # Central 3-story imperial keep
        _paste_centered(c, _load_hb_piece("stoneDoorWindow", 1.95), cx, cy - 30)
        _paste_centered(c, _load_hb_piece("stoneWindows", 1.95), cx, cy - 82)
        _paste_centered(c, _load_hb_piece("stoneWindows", 1.95), cx, cy - 132)
        _paste_centered(c, _load_hb_piece("redRoofTall", 1.95), cx, cy - 192)
        # Left spire
        _paste_centered(c, _load_hb_piece("rockWindows", 1.8), cx - 78, cy - 4)
        _paste_centered(c, _load_hb_piece("rockWindows", 1.8), cx - 78, cy - 52)
        _paste_centered(c, _load_hb_piece("redRoofPointy", 1.8), cx - 78, cy - 106)
        # Right citadel turret
        _paste_centered(c, _load_hb_piece("sandWindows", 1.8), cx + 80, cy - 4)
        _paste_centered(c, _load_hb_piece("sandWindows", 1.8), cx + 80, cy - 52)
        _paste_centered(c, _load_hb_piece("sandRing", 1.8), cx + 80, cy - 98)
        # Front twin gatehouses
        _paste_centered(c, _load_hb_piece("stoneGateLeft", 1.8), cx - 36, cy + 42)
        _paste_centered(c, _load_hb_piece("stoneRing", 1.8), cx - 36, cy - 6)
        _paste_centered(c, _load_hb_piece("woodDoorWindowBlinds", 1.75), cx + 42, cy + 42)
        _paste_centered(c, _load_hb_piece("redRoofRounded", 1.75), cx + 42, cy - 4)

    return c


def _build_terrain_prop_sprite(kind: str, sbs_sheet: Image.Image) -> Image.Image:
    """Build clean alpha-masked 2D terrain decor sprites (hill, mountain, forest)."""
    c = Image.new("RGBA", (DECOR_CELL, DECOR_CELL), (0, 0, 0, 0))
    draw = ImageDraw.Draw(c)

    if kind == "hill_sprite":
        # Two soft layered 2.5D mounds in the left and right halves (hexRenderer splits width/2)
        for idx, (cx, cy, rw, rh) in enumerate(((128, 300, 96, 58), (384, 300, 86, 52))):
            draw.ellipse([cx - rw, cy - rh // 2, cx + rw, cy + rh], fill=(18, 15, 10, 90))
            pts = [
                (cx - rw, cy + 20),
                (cx - rw // 2, cy - rh),
                (cx + rw // 3, cy - rh + 8),
                (cx + rw, cy + 20),
            ]
            base_col = (118, 110, 78, 235) if idx == 0 else (106, 98, 70, 230)
            draw.polygon(pts, fill=base_col)
            # Sunlit left slope
            sun_pts = [pts[0], pts[1], (cx, cy + 20)]
            draw.polygon(sun_pts, fill=(148, 140, 102, 180))
            draw.line([pts[0], pts[1], pts[2], pts[3]], fill=(62, 56, 38, 210), width=3)

    elif kind == "mountain_sprite":
        # Two faceted Civ-style alpine peaks (left half + right half) with snow caps & zero background
        peaks = [
            (128, 360, 104, 240),
            (384, 360, 92, 210),
        ]
        for cx, base_y, half_w, height in peaks:
            apex = (cx, base_y - height)
            left = (cx - half_w, base_y)
            right = (cx + half_w, base_y)
            mid = (cx + 10, base_y + 12)
            # Drop shadow
            draw.ellipse([cx - half_w, base_y - 24, cx + half_w + 14, base_y + 26], fill=(10, 10, 12, 115))
            # Left sunlit rock face
            draw.polygon([left, apex, mid], fill=(126, 124, 120, 248))
            # Right shaded rock face
            draw.polygon([mid, apex, right], fill=(74, 73, 76, 248))
            # Snow cap (top 38%)
            s_left = ( round(cx - half_w * 0.38), round(base_y - height * 0.62) )
            s_mid = ( round(cx + 4), round(base_y - height * 0.56) )
            s_right = ( round(cx + half_w * 0.38), round(base_y - height * 0.62) )
            draw.polygon([s_left, apex, s_mid], fill=(242, 246, 250, 252))
            draw.polygon([s_mid, apex, s_right], fill=(195, 206, 218, 250))
            # Ridge line
            draw.line([left, apex, right], fill=(42, 40, 44, 220), width=3)
            draw.line([apex, mid], fill=(55, 54, 58, 190), width=2)

    elif kind == "forest_sprite":
        # 2x2 grid of pine/deciduous tree clusters (hexRenderer samples 4 quadrants)
        quads = [(128, 136), (384, 136), (128, 392), (384, 392)]
        for qx, qy in quads:
            for ox, oy, scale in ((-28, 10, 0.85), (26, 14, 0.8), (0, -8, 1.0)):
                tx, ty = qx + ox, qy + oy
                r = round(42 * scale)
                # Shadow
                draw.ellipse([tx - r, ty + r - 8, tx + r, ty + r + 18], fill=(10, 16, 10, 110))
                # Trunk
                draw.rectangle([tx - 5, ty + r - 12, tx + 5, ty + r + 8], fill=(92, 62, 36, 245))
                # 3 tiered conifer cones
                for tier in range(3):
                    tw = round(r * (1.05 - tier * 0.22))
                    top_y = ty - r - tier * round(22 * scale)
                    bot_y = ty + r - 10 - tier * round(18 * scale)
                    draw.polygon(
                        [(tx - tw, bot_y), (tx, top_y), (tx + tw, bot_y)],
                        fill=(34 + tier * 10, 88 + tier * 16, 42 + tier * 8, 248),
                    )
                    # Sunlit left half
                    draw.polygon(
                        [(tx - tw, bot_y), (tx, top_y), (tx, bot_y)],
                        fill=(52 + tier * 12, 114 + tier * 16, 56 + tier * 10, 210),
                    )

    return c


def build_decor_atlas(sbs_sheet: Image.Image) -> tuple[Image.Image, dict[str, list[int]]]:
    """Build 7-cell 512x512 transparent decor + city atlas."""
    items = [
        "hill_sprite",
        "mountain_sprite",
        "forest_sprite",
        "city_hamlet",
        "city_village",
        "city_town",
        "city_capital",
    ]
    strip = Image.new("RGBA", (DECOR_CELL * len(items), DECOR_CELL), (0, 0, 0, 0))
    rects: dict[str, list[int]] = {}

    for i, name in enumerate(items):
        if name.startswith("city_"):
            cell = _build_city_sprite(name)
        else:
            cell = _build_terrain_prop_sprite(name, sbs_sheet)
        x0 = i * DECOR_CELL
        strip.paste(cell, (x0, 0))
        rects[name] = [x0, 0, x0 + DECOR_CELL, DECOR_CELL]

    return strip, rects


def main() -> None:
    print("=== RepoCiv 2D Asset Atlas Generator (SBS + Kenney CC0) ===\n")
    if not SBS_PATH.exists():
        raise SystemExit(f"Missing SBS source sheet: {SBS_PATH}")

    sbs_sheet = Image.open(SBS_PATH).convert("RGBA")
    hex_strip, hex_rects, pat_strip, pat_rects = build_hex_and_terrain_atlases(sbs_sheet)
    decor_strip, decor_rects = build_decor_atlas(sbs_sheet)

    hex_path = ASSETS_DIR / "hex-tiles-2d.webp"
    hex_strip.save(str(hex_path), "WEBP", quality=90)
    print(f"  -> {hex_path.name} ({hex_path.stat().st_size // 1024} KB)")

    terrain_path = ASSETS_DIR / "terrain-atlas.webp"
    pat_strip.save(str(terrain_path), "WEBP", quality=88)
    print(f"  -> {terrain_path.name} ({terrain_path.stat().st_size // 1024} KB)")

    decor_png_path = ASSETS_DIR / "decor-atlas.png"
    decor_strip.save(str(decor_png_path), "PNG", optimize=True)
    print(f"  -> {decor_png_path.name} ({decor_png_path.stat().st_size // 1024} KB)")

    manifest = {
        "terrainAtlas": "/assets/terrain-atlas.webp",
        "hexTilesAtlas": "/assets/hex-tiles-2d.webp",
        "hexTileSize": HEX_CELL,
        "hexTileRects": hex_rects,
        "decorAtlas": "/assets/decor-atlas.png",
        "cellSize": DECOR_CELL,
        "terrainRects": pat_rects,
        "decorRects": decor_rects,
    }
    manifest_path = ASSETS_DIR / "asset-atlas.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"  -> {manifest_path.name}")


if __name__ == "__main__":
    main()
