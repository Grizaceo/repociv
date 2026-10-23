"""Contact sheets and black-wedge pixel counts for verify-family-textured.mjs output.

Usage: python scripts/meshy/family_contact_sheets.py <verifier-output-dir>
Dark pixels: brightest channel < 30 in the clay (normals-only) renders, excluding
the page background. Zero is required; it measures the old wedge signature, not
artistic quality or every possible occlusion.
"""
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ASSETS = {"memory-archive": "Archivo", "observatory": "Observatorio", "coordination-court": "Patio",
          "connection-gateway": "Portal", "artifact-vault": "Bóveda", "research-laboratory": "Laboratorio",
          "civic-plaza": "Plaza"}
BACKGROUND = np.array([32, 44, 54])
FONTS = ("/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/noto/NotoSans-Regular.ttf")


def font():
    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, 14)
    return ImageFont.load_default()


def dark_pixels(path):
    pixels = np.asarray(Image.open(path).convert("RGB")).astype(int)
    background = (np.abs(pixels - BACKGROUND) < 4).all(axis=2)
    return int(((pixels.max(axis=2) < 30) & ~background).sum())


def sheet(rows, target, tile=(300, 233)):
    width = tile[0] * max(len(r[1]) for r in rows)
    image = Image.new("RGB", (width, (tile[1] + 22) * len(rows)), (24, 32, 40))
    draw = ImageDraw.Draw(image)
    face = font()
    for y, (label, paths) in enumerate(rows):
        top = y * (tile[1] + 22)
        draw.text((6, top + 3), label, fill=(231, 189, 117), font=face)
        for x, path in enumerate(paths):
            thumb = Image.open(path).convert("RGB").resize(tile, Image.Resampling.LANCZOS)
            image.paste(thumb, (x * tile[0], top + 22))
            draw.text((x * tile[0] + 6, top + 26), path.stem, fill=(235, 235, 235), font=face)
    image.save(target, optimize=True)


def main(out):
    out = Path(out)
    report = {}
    for asset, label in ASSETS.items():
        folder = out / asset
        clay = sorted(folder.glob("clay-*.png"))
        report[asset] = {path.stem: dark_pixels(path) for path in clay}
        sheet([(f"{label} · PBR, iluminación de mapa", sorted(folder.glob("lit-*.png"))),
               (f"{label} · una cara (huecos visibles)", sorted(folder.glob("single-*.png"))),
               (f"{label} · arcilla (normales)", clay),
               (f"{label} · albedo sin luz", sorted(folder.glob("unlit-*.png")))], out / f"{asset}-sheet.png")
    sheet([("Familia · PBR", [out / "lineup" / f"lit-{v}.png" for v in ("iso", "front", "map")]),
           ("Familia · arcilla", [out / "lineup" / f"clay-{v}.png" for v in ("iso", "front", "map")])],
          out / "family-sheet.png", tile=(900, 300))
    (out / "dark-pixels.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    return report


if __name__ == "__main__":
    main(sys.argv[1])
