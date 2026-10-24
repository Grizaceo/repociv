#!/usr/bin/env python3
"""Deterministic knowledge-city unit figurines (0 Meshy credits).

Four static agents for UnitProps3D, same anatomy, tools by function — not a
fantasy army. Overlay replaces Phase 5 mage/engineer/rogue/knight when
VITE_MESHY_PREVIEW !== '0'. Slot 1 (material name contains 'tint') stays the
garment UnitMesh3D / LocalAgent3D colour with unit.color.

  unit-coordinator.glb  → unit-mage      (hero, claude, openclaw)
  unit-builder.glb      → unit-engineer  (worker, codex, cursor)
  unit-ranger.glb       → unit-rogue     (scout, caravan)
  unit-guardian.glb     → unit-knight    (praetorian, army, lexo)

Y-up, feet at Y=0, POSITION+NORMAL, 42° crease. Palette: limestone garment,
warm stone skin, slate kit, copper tools. No rigging, text, weapons-as-identity
or Meshy POST.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "public" / "assets" / "3d" / "props" / "knowledge-city"
WALLS_PATH = Path(__file__).with_name("generate-city-walls-glbs.py")

_spec = importlib.util.spec_from_file_location("generate_city_walls_glbs", WALLS_PATH)
walls = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(walls)

MAX_TRIANGLES = 280
SKIN = "#c4ae8e"

RUNTIME_IDS = {
    "unit-coordinator": "unit-mage",
    "unit-builder": "unit-engineer",
    "unit-ranger": "unit-rogue",
    "unit-guardian": "unit-knight",
}


def skin_mesh() -> walls.MaterialMesh:
    return walls.MaterialMesh("unit-skin", SKIN, roughness=0.70, metallic=0.0)


def garment_mesh() -> walls.MaterialMesh:
    return walls.MaterialMesh("unit-garment-tint", walls.LIMESTONE, roughness=0.84, metallic=0.0)


def slate_mesh() -> walls.MaterialMesh:
    return walls.MaterialMesh("unit-slate", walls.SLATE, roughness=0.62, metallic=0.0)


def copper_mesh() -> walls.MaterialMesh:
    return walls.MaterialMesh("unit-copper", walls.COPPER, roughness=0.38, metallic=0.82)


def add_shared_anatomy(skin: walls.MaterialMesh, garment: walls.MaterialMesh) -> None:
    """One compact humanoid. Role kits add massing; they do not change this skeleton."""
    skin.add_box(-0.070, 0.00, -0.040, -0.018, 0.08, 0.040)
    skin.add_box(0.018, 0.00, -0.040, 0.070, 0.08, 0.040)
    skin.add_box(-0.068, 0.08, -0.038, -0.020, 0.20, 0.038)
    skin.add_box(0.020, 0.08, -0.038, 0.068, 0.20, 0.038)
    skin.add_box(-0.055, 0.44, -0.050, 0.055, 0.56, 0.050)
    skin.add_box(-0.145, 0.26, -0.028, -0.100, 0.31, 0.028)
    skin.add_box(0.100, 0.26, -0.028, 0.145, 0.31, 0.028)
    garment.add_box(-0.095, 0.19, -0.055, 0.095, 0.44, 0.055)
    garment.add_box(-0.140, 0.24, -0.035, -0.095, 0.42, 0.035)
    garment.add_box(0.095, 0.24, -0.035, 0.140, 0.42, 0.035)


def build_coordinator() -> list[walls.MaterialMesh]:
    """Coordinator: long robe, slate mantle, copper reading tablet. No hat, staff or orb."""
    skin, garment, slate, copper = skin_mesh(), garment_mesh(), slate_mesh(), copper_mesh()
    add_shared_anatomy(skin, garment)
    garment.add_frustum(0.0, 0.0, 0.05, 0.20, 0.13, 0.09, sides=6, cap_bottom=True)
    slate.add_box(-0.11, 0.40, -0.07, 0.11, 0.45, 0.07)
    slate.add_box(-0.06, 0.56, -0.055, 0.06, 0.60, 0.055)
    copper.add_box(-0.155, 0.22, -0.010, -0.145, 0.34, 0.080)
    copper.add_box(-0.160, 0.33, -0.015, -0.140, 0.35, 0.085)
    return [skin, garment, slate, copper]


def build_builder() -> list[walls.MaterialMesh]:
    """Builder: short tunic, slate satchel, copper chisel. No hardhat or wrench."""
    skin, garment, slate, copper = skin_mesh(), garment_mesh(), slate_mesh(), copper_mesh()
    add_shared_anatomy(skin, garment)
    slate.add_box(-0.07, 0.24, -0.125, 0.07, 0.40, -0.060)
    slate.add_box(-0.08, 0.20, -0.06, 0.08, 0.23, 0.06)
    copper.add_box(0.145, 0.18, -0.015, 0.165, 0.42, 0.015)
    copper.add_box(0.135, 0.40, -0.035, 0.175, 0.46, 0.035)
    return [skin, garment, slate, copper]


def build_ranger() -> list[walls.MaterialMesh]:
    """Ranger: slate hood and pack, copper map-case. No daggers or quiver."""
    skin, garment, slate, copper = skin_mesh(), garment_mesh(), slate_mesh(), copper_mesh()
    add_shared_anatomy(skin, garment)
    slate.add_frustum(0.0, -0.01, 0.54, 0.64, 0.09, 0.04, sides=6)
    slate.add_box(-0.08, 0.22, -0.14, 0.08, 0.40, -0.07)
    copper.add_box(-0.04, 0.18, 0.055, 0.04, 0.32, 0.095)
    return [skin, garment, slate, copper]


def build_guardian() -> list[walls.MaterialMesh]:
    """Guardian: copper pauldrons, slate tablet-shield. No sword or greathelm."""
    skin, garment, slate, copper = skin_mesh(), garment_mesh(), slate_mesh(), copper_mesh()
    add_shared_anatomy(skin, garment)
    copper.add_box(-0.16, 0.38, -0.055, -0.095, 0.46, 0.055)
    copper.add_box(0.095, 0.38, -0.055, 0.16, 0.46, 0.055)
    slate.add_box(-0.06, 0.56, -0.05, 0.06, 0.61, 0.05)
    slate.add_box(-0.20, 0.16, -0.08, -0.155, 0.42, 0.08)
    copper.add_box(-0.205, 0.26, -0.015, -0.195, 0.32, 0.015)
    return [skin, garment, slate, copper]


BUILDERS = {
    "unit-coordinator": build_coordinator,
    "unit-builder": build_builder,
    "unit-ranger": build_ranger,
    "unit-guardian": build_guardian,
}


def export_glb(path: Path, node_name: str, parts: list[walls.MaterialMesh]) -> dict:
    previous = walls.MAX_TRIANGLES
    walls.MAX_TRIANGLES = MAX_TRIANGLES
    try:
        return walls.export_glb(path, node_name, parts)
    finally:
        walls.MAX_TRIANGLES = previous


def generate(out_dir: Path) -> list[dict]:
    reports = []
    for stem, builder in BUILDERS.items():
        reports.append(export_glb(out_dir / f"{stem}.glb", stem, builder()))
    return reports


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    reports = generate(args.out)
    print(json.dumps({"out": str(args.out), "pieces": reports, "runtime": RUNTIME_IDS}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
