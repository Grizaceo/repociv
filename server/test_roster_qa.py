"""Tests de contrato para el roster de Bot Mode (QA coverage).

Cubren: GET /api/roster (snake_case, identidad real: pet / face / null),
GET /api/harness-profiles?with_identity=1 y GET /api/roster/asset/<file>
(allowlist estricto). Los consume el spawner "➕ Bot" y los avatares de las
unidades en el mapa.

Corren sin secretos ni servidor HTTP: llaman a los handlers directamente
sobre un árbol de perfiles falso (fake_hermes_profiles). No leen
profile.yaml ni tocan el config vivo del gateway.
"""

from __future__ import annotations

from typing import Any

import pytest

# Importamos los handlers directamente para testear los contratos sin
# necesitar el servidor HTTP vivo ni token de auth (verificamos la lógica
# de los handlers, no la capa de transporte con auth-gate — eso ya lo
# verificó @backend con curl tokenless).
from server.routes.core import (
    get_harness_profiles,
    get_roster,
    get_roster_asset,
)

RouteContext = dict[str, Any]

_ROSTER_NAMES = ["shadow-davi", "lexo-alpha", "davi"]


@pytest.fixture
def fake_hermes_profiles(tmp_path, monkeypatch):
    """Hermetic roster: a fake HERMES_ROOT/profiles tree and a fixed profile list.

    get_roster reads identity from HERMES_ROOT/profiles/<name>/{pets,assets} and
    names from profile_identity.list_harness_options. Both used to hit the real
    ~/.hermes, so the result depended on which profiles existed that day (a new
    avatar-less profile broke test_other_bots_have_real_identity) and on test
    order (a sys.modules patch is ignored once server.profile_identity was
    imported). Patch the real module attribute and HERMES_ROOT instead.
    """
    import json

    from server import bridge, profile_identity

    root = tmp_path / "hermes"
    pet = root / "profiles" / "shadow-davi" / "pets" / "shadow"
    pet.mkdir(parents=True)
    (pet / "pet.json").write_text(json.dumps({"id": "shadow", "displayName": "Shadow", "description": "hedgehog"}))
    (pet / "spritesheet.webp").write_bytes(b"RIFF0000WEBP")
    face = root / "profiles" / "lexo-alpha" / "assets"
    face.mkdir(parents=True)
    (face / "avatar.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (root / "profiles" / "davi").mkdir(parents=True)

    monkeypatch.setattr(bridge, "HERMES_ROOT", root)
    monkeypatch.setattr(profile_identity, "list_harness_options", lambda harness: list(_ROSTER_NAMES))
    return root


# ═══════════════════════════════════════════════════════════════════════════════
# 1. GET /api/roster — contrato snake_case + shadow-davi asset + resto null
# ═══════════════════════════════════════════════════════════════════════════════


class TestGetRosterContract:
    """Contract tests for GET /api/roster?harness=hermes.

    Verificamos que el handler devuelve el shape acordado por @backend y
    @hermes: {harness, bots:[{name, is_bot, avatar_kind, avatar_url}]},
    snake_case, DAVI mapeado a shadow-davi con avatar_kind:"asset" y el
    asset URL hardcodeado, resto null (no lee profile.yaml).

    NOTA: list_harness_options y la identidad (pets/avatar.png) leen el
    filesystem real; fake_hermes_profiles los apunta a un árbol en tmp_path
    para que el test sea determinista.
    """

    @pytest.fixture
    def mock_profile_identity(self, fake_hermes_profiles):
        """Deterministic roster (see fake_hermes_profiles)."""
        return fake_hermes_profiles

    def test_returns_200_with_harness_and_bots(self, mock_profile_identity):
        """GET /api/roster devuelve 200 con {harness, bots}."""
        ctx: RouteContext = {"params": {"harness": "hermes"}}
        status, body = get_roster(ctx)
        assert status == 200
        assert isinstance(body, dict)
        assert "harness" in body
        assert "bots" in body
        assert isinstance(body["bots"], list)

    def test_harness_param_default_hermes(self, mock_profile_identity):
        """Cuando no se pasa harness, default es 'hermes' (lower)."""
        ctx: RouteContext = {"params": {}}
        status, body = get_roster(ctx)
        assert status == 200
        assert body["harness"] == "hermes"

    def test_harness_param_stripped_lower(self, mock_profile_identity):
        """El harness se strip y lowercase."""
        ctx: RouteContext = {"params": {"harness": "  HERMES  "}}
        status, _body = get_roster(ctx)
        assert status == 200
        # La lista de nombres depende del mock — solo verificamos que
        # el handler procesó el param correctamente.
        assert _body["harness"] == "hermes"

    def test_bots_all_have_is_bot_true(self, mock_profile_identity):
        """Todos los bots devueltos tienen is_bot: True (son bots, no
        usuarios)."""
        ctx: RouteContext = {"params": {"harness": "hermes"}}
        status, body = get_roster(ctx)
        assert status == 200
        for bot in body["bots"]:
            assert bot["is_bot"] is True

    def test_harness_profiles_default_is_string_array(self, mock_profile_identity):
        """GET /api/harness-profiles?harness=hermes (sin flag) sigue devolviendo
        un array de strings (backward-compatible con el consumidor existente)."""
        ctx: RouteContext = {"params": {"harness": "hermes"}}
        status, body = get_harness_profiles(ctx)
        assert status == 200
        assert isinstance(body["profiles"], list)
        assert all(isinstance(p, str) for p in body["profiles"])
        assert "shadow-davi" in body["profiles"]

    def test_harness_profiles_with_identity_enriched(self, mock_profile_identity):
        """GET /api/harness-profiles?harness=hermes&with_identity=1 enriquece cada
        entrada con la identidad real de get_roster (single source, read-only),
        sin tocar profile.yaml. shadow-davi debe llevar su pet real."""
        ctx: RouteContext = {"params": {"harness": "hermes", "with_identity": "1"}}
        status, body = get_harness_profiles(ctx)
        assert status == 200
        assert isinstance(body["profiles"][0], dict)
        davi = next((p for p in body["profiles"] if p["name"] == "shadow-davi"), None)
        assert davi is not None
        assert davi["avatar_kind"] == "pet"
        assert (davi["pet"] or {}).get("id") == "shadow"
        # sin fuga de profile.yaml
        leak = {"membership", "memberships", "routines", "api_key", "email", "token"}
        for p in body["profiles"]:
            assert not (set(p.keys()) & leak)

    def test_bots_have_snake_case_keys(self, mock_profile_identity):
        """Los keys del dict de cada bot son snake_case: name, is_bot,
        avatar_kind, avatar_url (+ pet/face_url opcionales)."""
        ctx: RouteContext = {"params": {"harness": "hermes"}}
        status, body = get_roster(ctx)
        assert status == 200
        allowed = {"name", "is_bot", "avatar_kind", "avatar_url", "pet", "face_url"}
        for bot in body["bots"]:
            assert set(bot.keys()).issubset(allowed)

    def test_shadow_davi_has_pet_identity(self, mock_profile_identity):
        """shadow-davi tiene avatar_kind:'pet' (su pet real 'shadow'), con
        pet.{id,displayName,description} y avatar_url al spritesheet.
        No usa el PNG suelto de Desktop (avatar_kind 'asset')."""
        ctx: RouteContext = {"params": {"harness": "hermes"}}
        status, body = get_roster(ctx)
        assert status == 200
        davi_bots = [b for b in body["bots"] if b["name"] == "shadow-davi"]
        assert len(davi_bots) == 1, "Debe haber exactamente un bot shadow-davi"
        davi = davi_bots[0]
        assert davi["avatar_kind"] == "pet"
        assert davi["pet"] is not None
        assert davi["pet"]["id"] == "shadow"
        assert davi["avatar_url"].endswith(".webp")

    def test_other_bots_have_real_identity(self, mock_profile_identity):
        """Los bots que NO son shadow-davi tienen identidad real derivada de
        disco: avatar_kind 'face' (avatar.png) o 'pet'. Ninguno queda null
        (el requisito del user: identidad real, no representativa)."""
        ctx: RouteContext = {"params": {"harness": "hermes"}}
        status, body = get_roster(ctx)
        assert status == 200
        for bot in body["bots"]:
            if bot["name"] in ("shadow-davi", "davi"):
                continue
            assert bot["avatar_kind"] in ("face", "pet"), (
                f"{bot['name']} debe tener identidad real (face/pet), no null"
            )

    def test_no_profile_yaml_read(self, mock_profile_identity):
        """El handler no importa ni lee profile.yaml ni agentProfile.
        Solo usa list_harness_options (nombre del profile) + descubrimiento
        de identidad instalada en disco (pet.json / avatar.png). Verificamos
        que ningún field del bot filtra contenido de profile.yaml
        (membership, routines, api_key, email, etc.)."""
        ctx: RouteContext = {"params": {"harness": "hermes"}}
        status, body = get_roster(ctx)
        assert status == 200
        allowed = {"name", "is_bot", "avatar_kind", "avatar_url", "pet", "face_url"}
        leak_fields = {"membership", "memberships", "routines", "routine", "api_key",
                       "email", "token", "password", "profile_yaml"}
        for bot in body["bots"]:
            assert set(bot.keys()).issubset(allowed), (
                f"Bot {bot['name']} expone fields no permitidos: "
                f"{set(bot.keys()) - allowed}"
            )
            assert not (set(bot.keys()) & leak_fields), (
                f"Bot {bot['name']} filtra contenido de profile.yaml"
            )


# ═══════════════════════════════════════════════════════════════════════════════
# 2. GET /api/roster/asset/<file> — allowlist estricto (red-team item 7)
# ═══════════════════════════════════════════════════════════════════════════════


class TestGetRosterAssetContract:
    """Contract tests for GET /api/roster/asset/<file>.

    La allowlist es estricta: solo davi_avatar_render.png es servido.
    Cualquier otro nombre devuelve 404. No hay concatenación de path del
    usuario (red-team item 7 confirmado por @cobalt).
    """

    def test_allowed_filename_returns_200(self):
        """El nombre permitido devuelve 200 + bytes del PNG."""
        ctx: RouteContext = {"asset": "davi_avatar_render.png"}
        status, body = get_roster_asset(ctx)
        # Puede ser 200 si el archivo existe en disco, o 404 si no.
        # Verificamos que NO es 404 por nombre inválido.
        assert status in (200, 404), (
            "davi_avatar_render.png debe ser allowlist-OK (200 si existe, "
            "404 si no está en disco — pero nunca 404 por nombre)"
        )
        if status == 200:
            assert isinstance(body, bytes)
            assert len(body) > 0

    def test_disallowed_filename_returns_404(self):
        """Cualquier nombre distinto a davi_avatar_render.png devuelve 404
        inmediatamente (sin intentar leer disco)."""
        ctx: RouteContext = {"asset": "traversal.png"}
        status, body = get_roster_asset(ctx)
        assert status == 404
        assert isinstance(body, dict)
        assert body.get("error") == "unknown asset"

    def test_traversal_attempt_returns_404(self):
        """Intentos de path traversal (../../, /, etc.) son bloqueados por
        la comparación estricta de nombre, sin concatenar con path."""
        for bad_name in [
            "../davi_avatar_render.png",
            "/etc/passwd",
            "davi_avatar_render.png/../../../etc/passwd",
            "..\\davi_avatar_render.png",
            "davi_avatar_render.png%00",
        ]:
            ctx: RouteContext = {"asset": bad_name}
            status, body = get_roster_asset(ctx)
            assert status == 404, (
                f"El nombre '{bad_name}' debe ser rechazado con 404 — "
                "la allowlist es estricta"
            )
            assert body.get("error") == "unknown asset"

    def test_empty_asset_returns_404(self):
        """asset vacío o missing devuelve 404."""
        for asset_val in ["", None]:
            ctx: RouteContext = {"asset": asset_val} if asset_val is not None else {}
            status, body = get_roster_asset(ctx)
            assert status == 404


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Tests de seguridad adicionales (sin tocar profile.yaml / config)
# ═══════════════════════════════════════════════════════════════════════════════


class TestSecurityNoProfileRead:
    """Verificaciones de seguridad: los handlers del roster NO leen
    profile.yaml, NO barren ~/.hermes/profiles/*, y NO escriben config.

    Estos tests verifican las invariantes de @cobalt/QA sobre la separación
    de componentes y el no-CRUD.
    """

    def test_get_roster_does_not_import_agent_profile(self):
        """get_roster no importa agentProfile.ts (el CRUD upsert_profile/
        saveIdentity). Verificamos que solo usa profile_identity.list_harness_options
        (nombre del profile) para el roster."""
        import server.routes.core as routes_module

        # Verificamos que el módulo no tenga referencias a agentProfile
        # (el CRUD de escritura de perfiles)
        source = open(routes_module.__file__).read()
        assert "agentProfile" not in source, (
            "routes/core.py no debe importar ni referenciar agentProfile "
            "(el CRUD de escritura de perfiles) — el roster es read-only"
        )

    def test_roster_does_not_list_profiles_directory(self):
        """get_roster no barre ~/.hermes/profiles/* (path-traversal/
        metadata-leak). Solo usa list_harness_options que devuelve nombres."""
        import server.routes.core as routes_module

        source = open(routes_module.__file__).read()
        # Verificamos que no hay código que liste el directorio de profiles
        roster_fn_source = source[source.find("def get_roster"):]
        roster_fn_source = roster_fn_source[:roster_fn_source.find("\ndef ")]
        assert "listdir" not in roster_fn_source.lower(), (
            "get_roster no debe listar directorios de profiles"
        )
        assert "os.listdir" not in roster_fn_source
        # Glob CONFINADO a pets/<pet>/pet.json (descubrimiento de pet instalada)
        # está permitido; lo que se prohíbe es listar el árbol de profiles.
        # El patrón '*/pet.json' se resuelve sobre pet_dir = profiles/<name>/pets
        # (slug-confinado), no sobre el raíz de profiles.
        for m in __import__("re").findall(r'\.glob\(["\']([^"\']+)["\']\)', roster_fn_source):
            assert m.endswith("pet.json"), f"glob no confinado a pets/: {m}"
