#!/usr/bin/env python3
"""Per-city alignment diagnosis for the Repociv 3D city view.

The previous session's subagent measured on the USER's clip:
  plaza centroid (252,158) vs wall-ring hole centroid (195,176): 60 px offset
  ring radii 38-112 px (std 16.3), 30° vs 210° differ 52.8 px

This script: capture fresh, mask walls + plazas, find each city ring, measure
the plaza centroid vs wall hole centroid and ring radii, compare against
the predicted projection offset.
"""
import json
import sys
import time
import urllib.request

import numpy as np
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
from scipy import ndimage
from PIL import Image

OUT = Path("/home/gris/.hermes/workspace/repos/repociv/.hermes/artifacts/3d-audit")
OUT.mkdir(parents=True, exist_ok=True)


def capture():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
        ctx.add_init_script("""
        const SEED = {
          version: 1,
          selectedRepoPaths: [
            '/tmp/repociv-fixtures/repo-alpha',
            '/tmp/repociv-fixtures/repo-beta',
            '/tmp/repociv-fixtures/repo-gamma',
            '/tmp/repociv-fixtures/repo-delta',
            '/tmp/repociv-fixtures/repo-epsilon',
            '/tmp/repociv-fixtures/repo-zeta',
          ],
          filters: { owners: [], topics: [], languages: [] },
        };
        localStorage.setItem('repociv:renderer', 'webgl');
        localStorage.setItem('repociv:selected-repos:v1', JSON.stringify(SEED));
        """)
        page = ctx.new_page()
        page.goto("http://localhost:5273/?cam=auto,1.4&freeze=2&reveal=all",
                  wait_until="domcontentloaded", timeout=30_000)
        page.locator("#loading-screen").wait_for(state="hidden", timeout=20_000)
        if page.locator("#repo-onboarding").is_visible(timeout=2000):
            page.locator("#repo-onboarding-next").click()
            page.locator("#repo-onboarding").wait_for(state="hidden", timeout=20_000)
        page.wait_for_timeout(5000)
        path = OUT / "plaza-vs-ring-fresh.png"
        page.locator("#main-canvas").screenshot(path=str(path), animations="disabled", timeout=60_000)
        browser.close()
    return path


def wall_mask(arr):
    """Warm-beige walls under ACES tone mapping + warm sun.

    Wall material 0xb0a898 (176,168,152) → shifts to ~(184,154,108) on the lit
    face and ~(110,92,68) on the shaded face. Both are warm-beige (R>G>B).
    """
    r, g, b = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)
    beige = (r > g) & (g > b) & ((r - b) >= 18)
    in_band = (
        (r >= 100) & (r <= 220) &
        (g >=  85) & (g <= 175) &
        (b >=  60) & (b <= 135)
    )
    return beige & in_band


def plaza_mask(arr):
    """Plaza: stepped stone dais, base 0xc9bfa6. With shading."""
    r, g, b = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)
    warm = (r > g) & (g >= b - 5) & (r > b)
    in_band = (
        (r >= 140) & (r <= 220) &
        (g >= 120) & (g <= 190) &
        (b >=  90) & (b <= 160)
    )
    return warm & in_band


def centroid(mask):
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return float(xs.mean()), float(ys.mean()), int(mask.sum())


def find_largest_connected(mask, min_size=200):
    labeled, n = ndimage.label(mask, structure=np.ones((3, 3)))
    sizes = ndimage.sum(mask, labeled, range(1, n + 1))
    if len(sizes) == 0:
        return None, None
    biggest = np.argmax(sizes) + 1
    cluster = (labeled == biggest)
    if sizes[biggest - 1] < min_size:
        return None, None
    return cluster, sizes[biggest - 1]


def find_interior_hole(wall_cluster):
    """For a wall ring (closed), find the largest interior empty region."""
    h, w = wall_cluster.shape
    # Interior = not wall
    interior = ~wall_cluster
    # Exclude regions that touch the bbox edge (those are the "outside")
    bbox = wall_cluster
    labeled, n = ndimage.label(interior, structure=np.ones((3, 3)))
    if n == 0:
        return None
    sizes = ndimage.sum(interior, labeled, range(1, n + 1))
    # Bbox of the wall cluster
    ys, xs = np.where(wall_cluster)
    if len(xs) == 0:
        return None
    bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max(), ys.max()
    # Find the largest interior region that is fully enclosed (doesn't touch bbox edge)
    candidates = []
    for i in range(1, n + 1):
        mask = (labeled == i)
        # Get bbox of this interior region
        iys, ixs = np.where(mask)
        if len(ixs) == 0:
            continue
        if (ixs.min() <= bx0 + 1 or ixs.max() >= bx1 - 1 or
            iys.min() <= by0 + 1 or iys.max() >= by1 - 1):
            continue  # touches bbox edge = outside
        candidates.append((sizes[i - 1], mask))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def ring_radii(wall_cluster, hole_mask, n=12):
    """Sample wall radius in n directions from hole centroid."""
    cy, cx, _ = centroid(hole_mask)
    if cx is None:
        return []
    radii = []
    for i in range(n):
        angle = 2 * np.pi * i / n
        dx, dy = np.cos(angle), np.sin(angle)
        # Ray march from hole center outward
        for r in range(1, 400):
            x = int(cx + dx * r)
            y = int(cy + dy * r)
            if x < 0 or y < 0 or x >= wall_cluster.shape[1] or y >= wall_cluster.shape[0]:
                break
            if wall_cluster[y, x]:
                radii.append((i, int(np.degrees(angle)), r))
                break
    return radii


def main():
    print("=== Capturing fresh screenshot ===")
    shot = capture()
    print(f"  saved to {shot}")
    img = np.array(Image.open(shot).convert("RGB"))
    H, W = img.shape[:2]
    print(f"  shape: {W}x{H}")

    print("\n=== Wall mask ===")
    wm = wall_mask(img)
    print(f"  wall pixels: {wm.sum()}")

    print("\n=== Plaza mask ===")
    pm = plaza_mask(img)
    print(f"  plaza pixels: {pm.sum()}")

    print("\n=== Wall ring components (size >= 500) ===")
    labeled, n = ndimage.label(wm, structure=np.ones((3, 3)))
    sizes = ndimage.sum(wm, labeled, range(1, n + 1))
    cities = []
    for i in range(1, n + 1):
        if sizes[i - 1] < 500:
            continue
        cluster = (labeled == i)
        ys, xs = np.where(cluster)
        bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if w < 60 or h < 60:
            continue  # too flat, not a ring
        # Aspect ratio: ring should be roughly square (1:1 ± 0.4)
        aspect = max(w, h) / max(min(w, h), 1)
        if aspect > 2.5:
            continue
        cities.append({
            "id": len(cities) + 1,
            "size": int(sizes[i - 1]),
            "bbox": bbox,
            "wh": (w, h),
        })

    # Sort by size, descending
    cities.sort(key=lambda c: -c["size"])
    print(f"  city-ring candidates: {len(cities)}")
    for c in cities:
        print(f"    #{c['id']}: size={c['size']}  bbox={c['bbox']}  wh={c['wh']}")

    # PREDICTED projection offset from Δy=4 world units
    # Camera tilt 0.62 rad ≈ 35.5°; px_per_unit at focal plane for zoom 1.4
    # Derived from subagent: ≈ 0.842 vertical projection * 4.10 px/unit * 4 units ≈ 14 px
    PREDICTED_OFFSET_PX = 14

    print(f"\n=== Per-city alignment (predicted Δy-projection offset ≈ {PREDICTED_OFFSET_PX} px) ===")
    reports = []
    for c in cities:
        x0, y0, x1, y1 = c["bbox"]
        wall_cluster = np.zeros_like(wm, dtype=bool)
        wall_cluster[y0:y1 + 1, x0:x1 + 1] = (labeled[y0:y1 + 1, x0:x1 + 1] == c["id"])
        # Force-bbox-grow to capture the whole wall ring
        # (the connected component might be just the wall pixels, the bbox grows to include the hole)

        # Find hole
        hole = find_interior_hole(wall_cluster)
        if hole is None:
            # Maybe the wall cluster IS the bbox — try expanding
            # Or this isn't a ring; skip
            print(f"  #{c['id']}: no interior hole (size={c['size']}, bbox={c['wh']}) — skipping")
            continue
        hcx, hcy, hsz = centroid(hole)
        if hsz < 50:
            print(f"  #{c['id']}: hole too small ({hsz}px) — skipping")
            continue

        # Plaza centroid (closest large plaza cluster to hole centroid)
        # We have the global plaza mask; find a connected component near the hole
        plaza_labeled, p_n = ndimage.label(pm, structure=np.ones((3, 3)))
        p_sizes = ndimage.sum(pm, plaza_labeled, range(1, p_n + 1))
        best_plaza = None
        best_dist = float("inf")
        for i in range(1, p_n + 1):
            if p_sizes[i - 1] < 50:
                continue
            p_cluster = (plaza_labeled == i)
            pcx, pcy, psz = centroid(p_cluster)
            if pcx is None:
                continue
            d = ((pcx - hcx) ** 2 + (pcy - hcy) ** 2) ** 0.5
            if d < best_dist:
                # Must be reasonably close to the hole
                if d < 200:
                    best_dist = d
                    best_plaza = p_cluster
        if best_plaza is None:
            print(f"  #{c['id']}: no nearby plaza (hole=({hcx:.0f},{hcy:.0f})) — skipping")
            continue
        pcx, pcy, psz = centroid(best_plaza)

        dx = pcx - hcx
        dy = pcy - hcy
        dist = (dx ** 2 + dy ** 2) ** 0.5

        # Ring radii
        radii = ring_radii(wall_cluster, hole, 12)
        rs = [r for _, _, r in radii]
        if rs:
            rmin, rmax, rmean, rstd = min(rs), max(rs), np.mean(rs), np.std(rs)
        else:
            rmin = rmax = rmean = rstd = 0
        # Opposite-side deltas
        opposite_deltas = []
        for i, ang, r in radii:
            opp_ang = (ang + 180) % 360
            opp_match = next((r2 for _, a2, r2 in radii if a2 == opp_ang), None)
            if opp_match is not None:
                opposite_deltas.append(abs(r - opp_match))
        max_opp_delta = max(opposite_deltas) if opposite_deltas else 0

        # Verdict
        if dist <= PREDICTED_OFFSET_PX + 8:
            verdict_offset = f"ARTIFACT (within {PREDICTED_OFFSET_PX+8}px of predicted {PREDICTED_OFFSET_PX}px)"
        elif dist <= PREDICTED_OFFSET_PX * 2:
            verdict_offset = f"~PLAZA ABOVE WALL by ~{int(dist - PREDICTED_OFFSET_PX)}px (mild artifact)"
        else:
            verdict_offset = f"REAL MISALIGNMENT ({dist:.0f}px ≫ {PREDICTED_OFFSET_PX}px predicted)"

        if rstd <= 4 and rmax - rmin <= 8:
            verdict_ring = f"REGULAR hex (σ={rstd:.1f}px)"
        else:
            verdict_ring = f"ASYMMETRIC (σ={rstd:.1f}px, span={rmax-rmin}px)"

        report = {
            "city": c["id"],
            "wall_size": c["size"],
            "wall_bbox": c["wh"],
            "hole": (round(hcx, 1), round(hcy, 1)),
            "plaza": (round(pcx, 1), round(pcy, 1)),
            "plaza_size": psz,
            "plaza_offset_px": (round(dx, 1), round(dy, 1)),
            "plaza_offset_dist": round(dist, 1),
            "verdict_offset": verdict_offset,
            "ring_radii": radii,
            "ring_min": rmin, "ring_max": rmax, "ring_mean": round(rmean, 1), "ring_std": round(rstd, 1),
            "max_opposite_delta": max_opp_delta,
            "verdict_ring": verdict_ring,
        }
        reports.append(report)

        print(f"\n  City #{c['id']} (wall={c['size']}px, bbox={c['wh']}):")
        print(f"    wall ring hole centroid: ({hcx:.0f}, {hcy:.0f})")
        print(f"    nearest plaza centroid:  ({pcx:.0f}, {pcy:.0f})  size={psz}px")
        print(f"    offset: dx={dx:+.0f} dy={dy:+.0f}  magnitude={dist:.0f}px")
        print(f"    → verdict: {verdict_offset}")
        print(f"    ring radii (12 dirs): r ∈ [{rmin}, {rmax}], mean={rmean:.1f}, σ={rstd:.1f}px")
        print(f"    max opposite-side delta: {max_opp_delta}px")
        print(f"    → verdict: {verdict_ring}")

    # Save report
    out_json = OUT / "alignment-report.json"
    # Strip non-serializable tuples for JSON
    json_safe = []
    for r in reports:
        r2 = dict(r)
        r2["ring_radii"] = [(i, a, rd) for i, a, rd in r["ring_radii"]]
        json_safe.append(r2)
    with open(out_json, "w") as f:
        json.dump({
            "predicted_offset_px": PREDICTED_OFFSET_PX,
            "cities": json_safe,
        }, f, indent=2)
    print(f"\nFull report saved to {out_json}")

    # Final summary
    print("\n=== VERDICT ===")
    if not reports:
        print("  Could not measure any city (mask too noisy or no clear ring found).")
        print("  Try increasing zoom to 1.8 or 2.0 for clearer wall detection.")
        sys.exit(2)
    n_artifact = sum(1 for r in reports if "ARTIFACT" in r["verdict_offset"])
    n_real = sum(1 for r in reports if "REAL" in r["verdict_offset"])
    n_regular = sum(1 for r in reports if "REGULAR" in r["verdict_ring"])
    n_asym = sum(1 for r in reports if "ASYMMETRIC" in r["verdict_ring"])
    print(f"  Plaza offset: {n_artifact}/{len(reports)} within ±8px of predicted (artifact); {n_real}/{len(reports)} real misalignment")
    print(f"  Ring symmetry: {n_regular}/{len(reports)} regular hex; {n_asym}/{len(reports)} asymmetric")
    if n_real == 0 and n_asym == 0:
        print("  → Both misalignments are PROJECTION / SAMPLING artifacts. No real bug.")
    elif n_real > 0:
        print("  → PLAZA OFFSET is a REAL bug. Investigate the geometry.")
    elif n_asym > 0:
        print("  → RING ASYMMETRY is real. Investigate the hex Shape vertex ordering.")


if __name__ == "__main__":
    main()
