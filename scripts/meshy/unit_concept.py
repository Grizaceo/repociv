"""Single-submit entrypoint for knowledge-city unit concepts. Never retry POST."""
import sys
from pathlib import Path

import workshop_concept as runner

ASSETS = ("unit-coordinator", "unit-builder", "unit-ranger", "unit-guardian")
REVISIONS = ("unit-builder-v002",)
ROOT = Path(__file__).resolve().parents[2]
PREFIX = (
    "Create ONE original standalone STRATEGY-GAME FIGURINE for the SAME knowledge-city "
    "civilization as the supplied Memory Archive image. That image is a BUILDING: use it "
    "only as a strict material and craftsmanship reference — warm pale limestone, dark "
    "slate ceramic, aged copper-bronze with contained turquoise patina, subtle warm amber "
    "— NOT as a silhouette to copy. The subject is a compact stylized standing humanoid "
    "inhabitant with a slightly large head for map readability, full body, feet together. "
    "Handcrafted stylized finish, sophisticated proportions rather than photorealism, "
    "medieval fantasy, anime or chibi. Thick connected sculptural pieces, no thin fingers, "
    "railings or filigree, no text, logos, extra people, gears, dramatic baked shadows, "
    "excessive grime, floating pieces or surrounding scenery. No terrain hex. A tiny "
    "circular limestone figurine plinth under the feet is allowed. Show the complete "
    "standalone figurine in one clearly ELEVATED THREE-QUARTER ISOMETRIC view, with both "
    "front and side visible, all edges inside frame, neutral background and transparent "
    "cutout. Readable at small strategy-map scale. "
)
ROLES = {
    "unit-coordinator": (
        "Unit Coordinator: a civic scholar-steward of knowledge. Long limestone robe, a "
        "slate shoulder mantle, and a copper reading tablet held at the chest. No wizard "
        "hat, no pointed cap, no staff, no orb, no magic effects. Read clearly as a "
        "coordinator, not a mage, builder, ranger, guardian, knight or monk."
    ),
    "unit-builder": (
        "Unit Builder: a compact artisan of the knowledge city. Short limestone tunic, a "
        "slate satchel on the back, a copper chisel in the right hand. No hardhat, no "
        "wrench, no overalls, no power tools. Read clearly as a builder, not an engineer "
        "mascot, coordinator, ranger or guardian."
    ),
    "unit-ranger": (
        "Unit Ranger: a compact scout of the knowledge city. Limestone tunic, a slate hood "
        "and backpack, a copper cylindrical map-case at the hip. No daggers, no bow, no "
        "quiver, no cape flourish. Read clearly as a ranger-messenger, not a rogue, "
        "assassin, coordinator, builder or guardian."
    ),
    "unit-guardian": (
        "Unit Guardian: a compact civic sentinel of knowledge. Broader limestone tunic, "
        "copper pauldrons, a rectangular slate tablet-shield on the left arm. No sword, "
        "no greathelm, no crest, no heraldic cross. Read clearly as a guardian, not a "
        "knight, soldier, coordinator, builder or ranger."
    ),
}
BUILDER_V002_ROLE = (
    "Unit Builder: a compact artisan of the knowledge city. Short limestone tunic, "
    "empty unobstructed back — no backpack, no satchel, no pack, no bedroll. A copper "
    "hammer in the right hand, short thick handle and a blocky head. No sickle, no "
    "chisel, no hardhat, no wrench, no overalls, no power tools. Read clearly as a "
    "builder, not an engineer mascot, coordinator, ranger or guardian."
)
RUNTIME = {
    "unit-coordinator": {
        "consumer": "src/three/UnitProps3D.ts KNOWLEDGE_CITY_UNIT_URLS (overlays unit-mage)",
        "public_path": "public/assets/3d/props/meshy/unit-coordinator-map.glb",
        "fallback": "unit-mage",
    },
    "unit-builder": {
        "consumer": "src/three/UnitProps3D.ts KNOWLEDGE_CITY_UNIT_URLS (overlays unit-engineer)",
        "public_path": "public/assets/3d/props/meshy/unit-builder-map.glb",
        "fallback": "unit-engineer",
    },
    "unit-ranger": {
        "consumer": "src/three/UnitProps3D.ts KNOWLEDGE_CITY_UNIT_URLS (overlays unit-rogue)",
        "public_path": "public/assets/3d/props/meshy/unit-ranger-map.glb",
        "fallback": "unit-rogue",
    },
    "unit-guardian": {
        "consumer": "src/three/UnitProps3D.ts KNOWLEDGE_CITY_UNIT_URLS (overlays unit-knight)",
        "public_path": "public/assets/3d/props/meshy/unit-guardian-map.glb",
        "fallback": "unit-knight",
    },
}


def revision_out(asset: str) -> Path:
    if asset != "unit-builder-v002":
        raise ValueError("Only the builder backpack revision is authorized")
    return ROOT / "assets-src/meshy/unit-builder/concept-v002"


def spec_for_builder_v002() -> dict:
    role = RUNTIME["unit-builder"]
    return {
        "asset_id": "unit-builder-v002",
        "status": "awaiting concept review; v001 clay rejected for backpack silhouette",
        "license_status": "unverified; local only; distribution blocked",
        "reference_asset": "memory-archive-v001",
        "parent_asset": "unit-builder-v001",
        "authorization": (
            "Cristóbal: «todos estan bien salvo el constructor creo se entenderia más "
            "sin mochila y con martillo o una hoz». New Image-to-Image concept in "
            "concept-v002/; v001 lock and geometry stay immutable. Hammer chosen over "
            "sickle for builder identity. No automatic geometry or texturing."
        ),
        "runtime": {
            "consumer": role["consumer"],
            "public_path": role["public_path"],
            "phase5_fallback": role["fallback"],
            "default_enabled": True,
            "mapping_status": "wired as overlay; builder awaits v002 concept, geometry and material approval",
        },
        "concept": {
            "tool": "meshy_image_to_image",
            "advertised_credits": 9,
            "max_create_requests": 1,
            "reference_relative_paths": [
                "assets-src/meshy/memory-archive/textured/archive-textured.png"
            ],
            "request_without_reference_paths": {
                "ai_model": "nano-banana-pro",
                "prompt": PREFIX + BUILDER_V002_ROLE,
                "generate_multi_view": False,
                "aspect_ratio": "1:1",
                "remove_background": True,
            },
        },
        "geometry_after_concept_approval": {
            "authorization": "Submit only after human approval of this concept image. One untextured mesh, no automatic retry.",
            "advertised_credits": 5,
            "max_create_requests": 1,
            "request_without_input_task_id": {
                "ai_model": "meshy-t2.5",
                "model_type": "smart-topology",
                "target_polycount": 2000,
                "topology": "triangle",
                "should_texture": False,
                "enable_pbr": False,
                "target_formats": ["glb"],
                "alpha_thumbnail": True,
                "multi_view_thumbnails": True,
                "auto_size": False,
            },
        },
        "texturing_after_geometry_approval": {
            "tool": "meshy_retexture",
            "endpoint": "POST /openapi/v1/retexture",
            "authorization": "Submit only after human geometry approval. Geometry approval is not material approval.",
            "advertised_credits": 10,
            "max_create_requests": 1,
            "material_approval": "pending; geometry approval is not material approval",
        },
        "guards": {
            "auto_geometry": False,
            "auto_texture": False,
            "auto_retry_paid_requests": False,
        },
    }


def spec_for(asset: str) -> dict:
    role = RUNTIME[asset]
    return {
        "asset_id": asset + "-v001",
        "status": "awaiting concept review; local CSG rejected as too crude",
        "license_status": "unverified; local only; distribution blocked",
        "reference_asset": "memory-archive-v001",
        "authorization": (
            "Cristóbal: «en concepto bien, pero claro requieren de meshy porque como estan "
            "se ven horribles lol». One Image-to-Image concept per unit after that "
            "confirmation. No automatic geometry or texturing."
        ),
        "runtime": {
            "consumer": role["consumer"],
            "public_path": role["public_path"],
            "phase5_fallback": role["fallback"],
            "default_enabled": True,
            "mapping_status": "wired as overlay; awaiting Meshy concept, geometry and material approval",
        },
        "concept": {
            "tool": "meshy_image_to_image",
            "advertised_credits": 9,
            "max_create_requests": 1,
            "reference_relative_paths": [
                "assets-src/meshy/memory-archive/textured/archive-textured.png"
            ],
            "request_without_reference_paths": {
                "ai_model": "nano-banana-pro",
                "prompt": PREFIX + ROLES[asset],
                "generate_multi_view": False,
                "aspect_ratio": "1:1",
                "remove_background": True,
            },
        },
        "geometry_after_concept_approval": {
            "authorization": "Submit only after human approval of this concept image. One untextured mesh, no automatic retry.",
            "advertised_credits": 5,
            "max_create_requests": 1,
            "request_without_input_task_id": {
                "ai_model": "meshy-t2.5",
                "model_type": "smart-topology",
                "target_polycount": 2000,
                "topology": "triangle",
                "should_texture": False,
                "enable_pbr": False,
                "target_formats": ["glb"],
                "alpha_thumbnail": True,
                "multi_view_thumbnails": True,
                "auto_size": False,
            },
        },
        "texturing_after_geometry_approval": {
            "tool": "meshy_retexture",
            "endpoint": "POST /openapi/v1/retexture",
            "authorization": "Submit only after human geometry approval. Geometry approval is not material approval.",
            "advertised_credits": 10,
            "max_create_requests": 1,
            "material_approval": "pending; geometry approval is not material approval",
        },
        "guards": {
            "auto_geometry": False,
            "auto_texture": False,
            "auto_retry_paid_requests": False,
        },
    }


def write_specs() -> None:
    for asset in ASSETS:
        folder = ROOT / "assets-src/meshy" / asset
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "spec.json"
        path.write_text(json_dumps(spec_for(asset)))
    folder = revision_out("unit-builder-v002")
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "spec.json").write_text(json_dumps(spec_for_builder_v002()))


def json_dumps(value: dict) -> str:
    import json

    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--write-specs":
        write_specs()
        return
    if len(sys.argv) < 2 or sys.argv[1] not in (*ASSETS, *REVISIONS):
        raise SystemExit("Select one authorized unit asset: " + ", ".join((*ASSETS, *REVISIONS)))
    asset = sys.argv[1]
    previous_out, previous_argv = runner.OUT, sys.argv
    try:
        runner.OUT = revision_out(asset) if asset in REVISIONS else ROOT / "assets-src/meshy" / asset
        sys.argv = [sys.argv[0], *sys.argv[2:]]
        runner.main()
    finally:
        runner.OUT, sys.argv = previous_out, previous_argv


if __name__ == "__main__":
    main()
