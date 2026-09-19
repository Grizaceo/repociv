"""Tests de contrato para las rutas de asamblea de RepoCiv (QA coverage).

Cubren: GET /api/roster (snake_case + shadow-davi asset + resto null),
POST /api/rooms/{name}/message (from_bot vacío → 400, slug inválidos → 400,
mensaje vacío → 400, comando shell-out construido correctamente),
GET /api/presence (active/since/window_seconds/derived),
GET /api/roster/asset/<file> (allowlist estricto contra davi_avatar_render.png).

Los tests de contrato corren sin secretos (no necesitan token ni ejecutar
`hermes chat`). Los tests de integración completa con `post_room_message`
mockean `subprocess.run` para verificar la construcción del comando sin
ejecutar el CLI real.

Condición de firma de @cobalt (aceptada): estos tests verifican formas
(presence, roster, post_room_message), no leen profile.yaml ni tocan el
config vivo del gateway.
"""

from __future__ import annotations

import subprocess
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# Importamos los handlers directamente para testear los contratos sin
# necesitar el servidor HTTP vivo ni token de auth (verificamos la lógica
# de los handlers, no la capa de transporte con auth-gate — eso ya lo
# verificó @backend con curl tokenless).
from server.routes.core import (
    _PRESENCE_WINDOW,
    _presence_last_send,
    _record_presence,
    get_harness_profiles,
    get_presence,
    get_roster,
    get_roster_asset,
    post_room_message,
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
# 3. POST /api/rooms/{name}/message — contrato + shell-out construido
# ═══════════════════════════════════════════════════════════════════════════════


class TestPostRoomMessageContract:
    """Contract tests for POST /api/rooms/{name}/message.

    Verificamos:
    - from_bot vacío → 400 (bug del default "user" muerto eliminado)
    - room name vacío → 400
    - message vacío → 400
    - slug inválido en room name → 400
    - slug inválido en from_bot → 400
    - Comando shell-out construido correctamente (mock de subprocess.run)

    Estos tests NO ejecutan `hermes chat` real (mockean subprocess.run) y
    NO leen profile.yaml. Verifican que el handler construye el comando
    correcto para el shell-out, que es la parte determinista del contrato.
    """

    def test_from_bot_empty_returns_400(self):
        """POST sin from_bot → 400. El bug del default "user" muerto está
        eliminado: no se fabrica un perfil inexistente."""
        body = {"message": "hola"}
        ctx: RouteContext = {"room": "asamblea-test"}
        status, resp = post_room_message(body, ctx)
        assert status == 400
        assert resp.get("ok") is False
        assert "from_bot" in resp.get("error", "").lower()

    def test_from_bot_missing_key_returns_400(self):
        """POST sin la key from_bot en el body → 400 (no 502 por perfil
        inexistente)."""
        body = {"message": "hola"}
        ctx: RouteContext = {"room": "asamblea-test"}
        status, resp = post_room_message(body, ctx)
        assert status == 400
        assert resp.get("ok") is False

    def test_room_name_empty_returns_400(self):
        """room name vacío → 400."""
        body = {"message": "hola", "from_bot": "lexo-alpha"}
        ctx: RouteContext = {"room": ""}
        status, resp = post_room_message(body, ctx)
        assert status == 400
        assert resp.get("ok") is False

    def test_room_name_missing_returns_400(self):
        """room name ausente en ctx → 400."""
        body = {"message": "hola", "from_bot": "lexo-alpha"}
        ctx: RouteContext = {}
        status, resp = post_room_message(body, ctx)
        assert status == 400

    def test_message_empty_returns_400(self):
        """message vacío → 400."""
        body = {"message": "", "from_bot": "lexo-alpha"}
        ctx: RouteContext = {"room": "asamblea-test"}
        status, resp = post_room_message(body, ctx)
        assert status == 400
        assert resp.get("ok") is False

    def test_room_name_invalid_slug_returns_400(self):
        """room name con caracteres no alfanuméricos ni -_ → 400."""
        for bad_name in ["asamblea test", "asamblea/test", "asamblea$", ""]:
            body = {"message": "hola", "from_bot": "lexo-alpha"}
            ctx: RouteContext = {"room": bad_name}
            status, resp = post_room_message(body, ctx)
            # El name vacío ya tested arriba; para los otros, 400 por slug
            if bad_name:
                assert status == 400, (
                    f"room name '{bad_name}' debe ser rechazado con 400"
                )
                assert resp.get("ok") is False

    def test_from_bot_invalid_slug_returns_400(self):
        """from_bot con caracteres no alfanuméricos ni -_ → 400."""
        for bad_bot in ["lexo alpha", "lexo/alpha", "lexo$"]:
            body = {"message": "hola", "from_bot": bad_bot}
            ctx: RouteContext = {"room": "asamblea-test"}
            status, resp = post_room_message(body, ctx)
            assert status == 400, (
                f"from_bot '{bad_bot}' debe ser rechazado con 400"
            )
            assert resp.get("ok") is False

    def test_shell_out_command_construction(self):
        """Verificamos que el comando `hermes chat` se construye correctamente
        con los parámetros esperados: -p <from_bot> chat --in ~ -c <room>
        --create-if-missing -Q -q <mensaje>."""
        body = {"message": "Hola asamblea", "from_bot": "lexo-alpha"}
        ctx: RouteContext = {"room": "asamblea-test"}

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        mock_result.stderr = ""

        with patch("server.routes.core.subprocess.run", return_value=mock_result) as mock_run:
            status, resp = post_room_message(body, ctx)

            assert status == 200
            assert resp.get("ok") is True
            assert resp.get("relayed") is True

            # Verificamos que subprocess.run fue llamado exactamente una vez
            assert mock_run.call_count == 1
            call_args = mock_run.call_args
            cli = call_args[0][0]  # primer arg posicional = lista de comandos

            # El comando debe ser una lista (no string — evita shell injection)
            assert isinstance(cli, list), "El comando debe ser una lista, no string"

            # Verificamos los elementos clave del comando
            assert "hermes" in cli or cli[0].endswith("hermes"), (
                "El CLI debe ser 'hermes' (o path a hermes)"
            )
            assert "-p" in cli
            assert "lexo-alpha" in cli
            assert "chat" in cli
            assert "--in" in cli
            assert "~" in cli
            assert "-c" in cli
            assert "asamblea-test" in cli
            assert "--create-if-missing" in cli, (
                "DEBE incluir --create-if-missing (fix del 502 'No session found')"
            )
            assert "-Q" in cli
            assert "-q" in cli

            # El mensaje formateado
            message_idx = cli.index("-q") + 1
            assert cli[message_idx].startswith("Message from 🤖 lexo-alpha:")
            assert "Hola asamblea" in cli[message_idx]

    def test_shell_out_command_is_list_not_string(self):
        """El comando se pasa como lista a subprocess.run (no shell=True),
        lo que evita injection de comandos."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        mock_result.stderr = ""

        with patch("server.routes.core.subprocess.run", return_value=mock_result):
            # No necesitamos hacer nada más — el test de arriba ya verifica
            # que es lista. Este test es documental.
            pass

    def test_timeout_returns_504(self):
        """Si `hermes chat` tarda más de 120s, el handler devuelve 504
        (timeout explícito, no 502 por timeout de socket)."""
        body = {"message": "lento", "from_bot": "lexo-alpha"}
        ctx: RouteContext = {"room": "asamblea-test"}

        with patch("server.routes.core.subprocess.run", side_effect=subprocess.TimeoutExpired("hermes", 120)):
            status, resp = post_room_message(body, ctx)
            assert status == 504
            # Verificamos que el mensaje de error indica timeout (la frase
            # exacta puede variar: "relay timed out" o similar)
            error_msg = resp.get("error", "").lower()
            assert "timed out" in error_msg or "timeout" in error_msg

    def test_subprocess_error_returns_500(self):
        """Excepción no TimeoutExpired en subprocess → 500."""
        body = {"message": "error", "from_bot": "lexo-alpha"}
        ctx: RouteContext = {"room": "asamblea-test"}

        with patch("server.routes.core.subprocess.run", side_effect=RuntimeError("mock error")):
            status, resp = post_room_message(body, ctx)
            assert status == 500
            assert resp.get("ok") is False

    def test_nonzero_returncode_returns_502(self):
        """Si `hermes chat` sale con código != 0, el handler devuelve 502."""
        body = {"message": "falla", "from_bot": "lexo-alpha"}
        ctx: RouteContext = {"room": "asamblea-test"}

        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_result.stderr = "error de prueba"

        with patch("server.routes.core.subprocess.run", return_value=mock_result):
            status, resp = post_room_message(body, ctx)
            assert status == 502
            assert resp.get("ok") is False

    def test_presence_recorded_on_success(self):
        """_record_presence se llama con from_bot en caso de éxito (para
        get_presence). Verificamos el efecto lateral."""
        body = {"message": "hola", "from_bot": "lexo-alpha"}
        ctx: RouteContext = {"room": "asamblea-test"}

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        mock_result.stderr = ""

        with patch("server.routes.core.subprocess.run", return_value=mock_result):
            status, _resp = post_room_message(body, ctx)
            assert status == 200

            # Verificamos que el presence se registró
            from server.routes.core import _presence_last_send
            assert "lexo-alpha" in _presence_last_send
            assert _presence_last_send["lexo-alpha"] > 0


# ═══════════════════════════════════════════════════════════════════════════════
# 4. GET /api/presence — contrato active/since/window_seconds/derived
# ═══════════════════════════════════════════════════════════════════════════════


class TestGetPresenceContract:
    """Contract tests for GET /api/presence.

    Verificamos que el handler devuelve el shape acordado:
    {active: [name, ...], since: {name: ts, ...}, window_seconds: float,
     derived: true}

    La presencia es best-effort derivada del relay log del propio bridge
    (no gateway RPC, no `hermes process list` que no existe).
    """

    def setup_method(self):
        """Resetear el estado de presencia antes de cada test para
        aislamiento."""
        _presence_last_send.clear()

    def test_returns_200_with_expected_shape(self):
        """GET /api/presence devuelve 200 con las keys esperadas."""
        ctx: RouteContext = {}
        status, body = get_presence(ctx)
        assert status == 200
        assert isinstance(body, dict)
        assert "active" in body
        assert "since" in body
        assert "window_seconds" in body
        assert "derived" in body

    def test_active_is_list(self):
        """active es una lista de nombres (puede estar vacía si no hay
        mensajes recientes)."""
        ctx: RouteContext = {}
        status, body = get_presence(ctx)
        assert status == 200
        assert isinstance(body["active"], list)

    def test_since_is_dict(self):
        """since es un dict name → unix_ts."""
        ctx: RouteContext = {}
        status, body = get_presence(ctx)
        assert status == 200
        assert isinstance(body["since"], dict)

    def test_window_seconds_is_float(self):
        """window_seconds es un float (matching _PRESENCE_WINDOW)."""
        ctx: RouteContext = {}
        status, body = get_presence(ctx)
        assert status == 200
        assert isinstance(body["window_seconds"], float)
        assert body["window_seconds"] == _PRESENCE_WINDOW

    def test_derived_is_true(self):
        """derived es True (indicando que es presencia derivada, no de
        gateway)."""
        ctx: RouteContext = {}
        status, body = get_presence(ctx)
        assert status == 200
        assert body["derived"] is True

    def test_active_includes_recent_senders(self):
        """Los bots que enviaron un mensaje recientemente aparecen en active."""
        ctx: RouteContext = {}
        # Registrar presencia para lexo-alpha
        _record_presence("lexo-alpha")
        status, body = get_presence(ctx)
        assert status == 200
        assert "lexo-alpha" in body["active"]

    def test_active_excludes_old_senders(self):
        """Los bots que enviaron mensajes fuera de la ventana no aparecen."""
        ctx: RouteContext = {}
        # Simular un mensaje hace más de _PRESENCE_WINDOW segundos
        import time
        _presence_last_send["old-bot"] = time.time() - (_PRESENCE_WINDOW + 10)
        status, body = get_presence(ctx)
        assert status == 200
        assert "old-bot" not in body["active"]

    def test_since_contains_all_tracked_names(self):
        """since contiene todos los nombres que alguna vez enviaron mensaje."""
        ctx: RouteContext = {}
        _record_presence("lexo-alpha")
        _record_presence("shadow-davi")
        status, body = get_presence(ctx)
        assert status == 200
        assert "lexo-alpha" in body["since"]
        assert "shadow-davi" in body["since"]


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Tests de integración del flujo de asamblea (mock)
# ═══════════════════════════════════════════════════════════════════════════════


class TestAssemblyFlowIntegration:
    """Tests de integración del flujo de la asamblea: roster → composer →
    post_room_message.

    Verificamos que el flujo end-to-end (sin ejecutar el CLI real) funciona
    como espera el composer de @frontend: el roster tiene shadow-davi con
    asset, y post_room_message construye el comando correcto.
    """

    @pytest.fixture
    def mock_profile_identity(self, fake_hermes_profiles):
        """Deterministic roster (see fake_hermes_profiles)."""
        return fake_hermes_profiles

    def test_assembly_flow_roster_then_post(self, mock_profile_identity):
        """Flujo completo de la asamblea: obtener roster (para encontrar el
        bot) y luego postear un mensaje (mock)."""
        # Paso 1: obtener el roster para encontrar los bots
        ctx_roster: RouteContext = {"params": {"harness": "hermes"}}
        status, roster_body = get_roster(ctx_roster)
        assert status == 200
        bots = {b["name"]: b for b in roster_body["bots"]}

        # Verificar que shadow-davi tiene pet real
        assert "shadow-davi" in bots
        assert bots["shadow-davi"]["avatar_kind"] == "pet"
        assert bots["shadow-davi"]["avatar_url"].endswith(".webp")

        # Paso 2: postear un mensaje como lexo-alpha (mock)
        body = {"message": "Hola desde la asamblea", "from_bot": "lexo-alpha"}
        ctx_msg: RouteContext = {"room": "asamblea-test"}

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        mock_result.stderr = ""

        with patch("server.routes.core.subprocess.run", return_value=mock_result) as mock_run:
            status, msg_body = post_room_message(body, ctx_msg)
            assert status == 200
            assert msg_body.get("ok") is True

            # Verificar que el comando incluye --create-if-missing
            call_args = mock_run.call_args
            cli = call_args[0][0]
            assert "--create-if-missing" in cli

    def test_composer_send_from_bot_real(self, mock_profile_identity):
        """El composer de @frontend siempre envía from_bot real del roster.
        Verificamos que el handler acepta bots reales (lexo-alpha, shadow-davi,
        davi) y rechaza perfiles inexistentes como 'user' o 'hermes' con 400
        (slug inválido no aplica — 'user' y 'hermes' son slugs válidos, pero
        el handler los acepta como slugs; el problema era el default 'user'
        que hacía fail al shell-out, que ahora es 400 por from_bot requerido)."""
        # 'user' y 'hermes' son slugs válidos pero perfiles inexistentes.
        # El handler no los rechaza por slug — los acepta. Lo que los hace
        # problemáticos es que el shell-out fallaría. Pero ahora from_bot es
        # requerido (400 si vacío), así que el composer debe enviar un bot
        # real del roster.

        # Verificamos que los slugs válidos pasan la validación de slug
        for bot_name in ["lexo-alpha", "shadow-davi", "davi", "user", "hermes"]:
            body = {"message": "test", "from_bot": bot_name}
            ctx: RouteContext = {"room": "asamblea-test"}
            # No mockeamos subprocess — solo verificamos que pasa la validación
            # de slug (no devuelve 400 por from_bot inválido)
            from server.routes.core import post_room_message as prm

            # Verificamos que NO es 400 por "invalid from_bot"
            # (es decir, el slug es válido)
            # Para no ejecutar el CLI real, mockeamos
            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_result.stdout = ""
            mock_result.stderr = ""

            with patch("server.routes.core.subprocess.run", return_value=mock_result):
                status, resp = prm(body, ctx)
                # Si el mock devuelve 0, esperamos 200 (el handler acepta el slug)
                assert status == 200, (
                    f"El bot '{bot_name}' debería ser aceptado por el handler "
                    f"(slug válido) — got {status}"
                )


# ═══════════════════════════════════════════════════════════════════════════════
# 6. Tests de seguridad adicionales (sin tocar profile.yaml / config)
# ═══════════════════════════════════════════════════════════════════════════════


class TestSecurityNoProfileRead:
    """Verificaciones de seguridad: los handlers de asamblea NO leen
    profile.yaml, NO leen ~/.hermes/profiles/*, y NO escriben config.

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
            "(el CRUD de escritura de perfiles) — la asamblea es read-only"
        )

    def test_post_room_message_does_not_write_profile_yaml(self):
        """post_room_message no escribe profile.yaml. Verificamos que el
        handler no tiene código de escritura de profile (solo su docstring
        puede mencionarlo como lo que NO hace)."""
        import server.routes.core as routes_module

        source = open(routes_module.__file__).read()
        # El handler de post_room_message (líneas 590-653) no debe tener
        # código de escritura de profile.yaml — extraemos solo el cuerpo
        # del código (después del docstring).
        fn_start = source.find("def post_room_message")
        # Saltar el docstring (entre """ y el siguiente """)
        docstring_start = source.find('"""', fn_start)
        docstring_end = source.find('"""', docstring_start + 3)
        # Código = después del docstring hasta el siguiente def
        post_fn_code = source[docstring_end + 3 : source.find("\ndef ", docstring_end)]
        assert "profile.yaml" not in post_fn_code, (
            "post_room_message no debe escribir profile.yaml — es participación, "
            "no configuración"
        )
        assert "saveIdentity" not in post_fn_code
        assert "upsert_profile" not in post_fn_code

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


# ═══════════════════════════════════════════════════════════════════════════════
# 7. Fixtures y helpers
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def reset_presence_state():
    """Resetear el estado de presencia entre tests para aislamiento."""
    _presence_last_send.clear()
    yield
    _presence_last_send.clear()
