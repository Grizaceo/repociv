# GhostDesk como Maravilla

[GhostDesk](https://github.com/YV17labs/GhostDesk) (FSL-1.1-ALv2, uso personal OK) es un
MCP que le da a un agente un escritorio Linux virtual dentro de Docker: pantalla, mouse,
teclado, portapapeles y apps. En RepoCiv es una maravilla iframe: el visor noVNC dentro
del Palacio, que el launcher levanta y detiene solo.

```
navegador (local o notebook por Tailscale)
  └─ http://<host>:5273/wonder-proxy/ghostdesk/   ← Vite (proxy, mismo origen, WS incluido)
        └─ 127.0.0.1:6080  noVNC ─┐
agente (Claude Code / Hermes)     │  contenedor ghostdesk (docker run --rm)
  └─ http://127.0.0.1:3000/mcp  ──┘  puertos solo en loopback
```

## Instalación (verificada 2026-09-19, GhostDesk 8.1.0)

```bash
docker pull ghcr.io/yv17labs/ghostdesk:8.1.0            # ~1,7 GB
umask 077; mkdir -p ~/.config/ghostdesk
printf 'GHOSTDESK_AUTH__TOKEN=%s\nTZ=America/Santiago\n' "$(openssl rand -hex 32)" \
  > ~/.config/ghostdesk/env                              # 0600, fuera del manifiesto y de `ps`
```

El launcher de RepoCiv corre el contenedor **en primer plano** para poder seguir su PID:

```bash
docker run --rm --name ghostdesk --shm-size 2g \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:6080:6080 \
  --env-file ~/.config/ghostdesk/env \
  -v ghostdesk-home:/home/agent \
  ghcr.io/yv17labs/ghostdesk:8.1.0
```

- Solo loopback. Docker publica puertos saltándose UFW, así que bindear a `127.0.0.1` es
  la única barrera: nunca `-p 3000:3000` a secas.
- Sin montar el home del host. El home del agente es el volumen nombrado `ghostdesk-home`,
  que persiste entre reinicios (`docker volume rm ghostdesk-home` lo borra).
- Sin `--cap-add SYS_ADMIN`. Solo lo necesitan las apps Electron; Firefox, foot,
  mousepad y galculator funcionan sin él.

### Maravilla: `~/.repociv/wonders/ghostdesk.json`

```json
{
  "id": "ghostdesk", "title": "GhostDesk", "kind": "iframe", "category": "operations",
  "version": "8.1.0", "defaultEnabled": true, "automationLevel": "passive",
  "passiveMode": true, "agenticMode": false, "canSuggest": false, "canAct": false,
  "requiresConfirmation": true,
  "ui": {
    "url": "/wonder-proxy/ghostdesk/?auto=1",
    "preferredWidth": "80vw", "preferredHeight": "80vh",
    "sandbox": ["allow-scripts", "allow-same-origin", "allow-forms", "allow-pointer-lock"]
  },
  "health": { "url": "http://127.0.0.1:3000/health/ready", "timeoutMs": 4000, "degradedAllowed": false },
  "permissions": { "readRepos": false, "writeRepos": false, "network": "loopback-only",
                   "requiresApprovalForMutations": true },
  "optionalFeatures": [],
  "actions": [{ "id": "open", "label": "Abrir", "risk": "safe", "requiresUserOptIn": false }],
  "events": { "emits": [], "accepts": [] },
  "mcp": { "enabled": true, "server": "http://127.0.0.1:3000/mcp" },
  "launch": {
    "repo_dir": "/home/<usuario>/.config/ghostdesk",
    "api_url": "http://127.0.0.1:3000",
    "api_health_path": "/health/ready",
    "ui_url": "http://127.0.0.1:6080",
    "procs": [{
      "name": "container",
      "argv": ["docker", "run", "--rm", "--name", "ghostdesk", "--shm-size", "2g",
               "-p", "127.0.0.1:3000:3000", "-p", "127.0.0.1:6080:6080",
               "--env-file", "/home/<usuario>/.config/ghostdesk/env",
               "-v", "ghostdesk-home:/home/agent", "ghcr.io/yv17labs/ghostdesk:8.1.0"],
      "log": "ghostdesk.log"
    }]
  }
}
```

Y en el `.env` del repo (Vite necesita reiniciarse para tomarlo):

```bash
REPOCIV_WONDER_PROXIES=ghostdesk=http://127.0.0.1:6080
```

`health` apunta al endpoint del MCP (`/health/ready` no pide token). El navegador no
puede leerlo (GhostDesk no manda CORS, y desde el notebook `127.0.0.1` es el notebook),
así que la viñeta sigue el camino del auto-arranque, igual que el resto de las maravillas
iframe: `POST /api/wonders/ghostdesk/launch` levanta el contenedor, o lo adopta si ya
corre, y el bridge sondea `api_url` / `ui_url` desde el host.

## Por qué el proxy de Vite

Un iframe a `http://127.0.0.1:6080` solo funciona en un navegador de omarchy-1: desde el
notebook (`http://omarchy-1:5273`) ese `127.0.0.1` es el notebook. `REPOCIV_WONDER_PROXIES`
publica el servicio bajo `/wonder-proxy/<id>/` en el mismo origen de RepoCiv, con HTTP y
WebSocket (`vite-plugins/wonderProxy.ts`), y el contenedor sigue en loopback. Una
`ui.url` relativa le indica a la viñeta que no la reemplace por `launch.ui_url`
(`resolveMountUrl`).

Alternativas descartadas (2026-09-19):
- Bindear `:6080` a la IP de Tailscale deja el escritorio abierto a toda la tailnet sin
  contraseña.
- Un túnel SSH funciona sin exponer nada, pero exige un paso manual cada vez.
- `tailscale serve` toca la configuración de Tailscale del sistema.

## Seguridad: qué queda expuesto

| Superficie | Estado |
|---|---|
| MCP `:3000` | loopback + Bearer token. En claro (sin TLS), pero nunca sale del host. GhostDesk lo avisa en el log: `posture: cleartext_token` |
| noVNC `:6080` | loopback, **sin contraseña**: sin TLS, GhostDesk ignora `GHOSTDESK_VNC_PASSWORD` |
| `/wonder-proxy/ghostdesk/` | quien llegue a `:5273` (tailnet) ve y controla el escritorio. Esa persona ya tiene el token del bridge embebido en el JS, que da más poder que un escritorio en un contenedor |
| WebSocket por el proxy | solo se aceptan upgrades del **mismo origen** (`isSameOriginUpgrade`), porque websockify no valida `Origin`. Así ninguna página ajena abierta en tu navegador puede secuestrar el escritorio |
| iframe | necesita `allow-same-origin`: sin él, noVNC no carga sus módulos ES (CORS desde el origen `null`). Consecuencia: el JS de noVNC (archivos estáticos de la imagen) podría leer la página de RepoCiv. Confiás en la imagen que corrés; lo que se navega *dentro* del escritorio llega solo como píxeles |

Siguiente paso si hace falta más: el modo TLS de GhostDesk (cert montado → exige token y
contraseña VNC), con el proxy de Vite hablando `https` hacia `127.0.0.1` (`secure: false`).

## Registrar el MCP

**Claude Code** (hecho con scope `local`, solo este proyecto):

```bash
claude mcp add --transport http ghostdesk http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $(sed -n 's/^GHOSTDESK_AUTH__TOKEN=//p' ~/.config/ghostdesk/env)"
# para todos los proyectos: agregar -s user
```

**Hermes** (propuesta, sin aplicar): en `~/.hermes/config.yaml` → `mcp_servers:`, con el
mismo formato que las otras entradas HTTP:

```yaml
  ghostdesk:
    type: http
    url: http://127.0.0.1:3000/mcp
    headers:
      Authorization: Bearer <GHOSTDESK_AUTH__TOKEN de ~/.config/ghostdesk/env>
    connect_timeout: 60
    timeout: 120
```

Tools verificadas contra 8.1.0 (14): `screen_shot` (webp por defecto, `format: "png"`,
`region`, `quality`), `mouse_move`, `mouse_click`, `mouse_double_click`, `mouse_drag`,
`mouse_scroll`, `key_type`, `key_press`, `clipboard_get`, `clipboard_set`, `app_list`,
`app_running`, `app_launch`, `app_status`. La herramienta `app_lanzar` que menciona la
auditoría del lab **no existe**.

## Modelo

Usá Claude (nube) para tareas de GUI: GhostDesk lo soporta de fábrica, en coordenadas
nativas y sin el header `GhostDesk-Model-Space`. Los modelos locales que sugiere upstream
(Qwen 27B/35B vía Ollama) no caben en la RTX 4060 de 8 GB de este host, y Ollama no está
instalado. No los prometas.

## Verificación (2026-09-19)

- Por `http://omarchy-1:5273`: Palacio → GhostDesk → "Entrar" hizo que el launcher
  levantara el contenedor en ~18 s, y noVNC conectó por
  `ws://omarchy-1:5273/wonder-proxy/ghostdesk/websockify`.
- Un WebSocket abierto desde otro origen fue rechazado.
- `claude -p --model haiku` con el MCP: `app_list`, luego `app_launch mousepad` y
  `screen_shot`. El visor de RepoCiv mostró ese mismo Mousepad.

## Problemas conocidos

- **Canvas en negro con el mapa 3D en Chromium sin GPU.** En Chromium headless
  (swiftshader), el render WebGL del mapa acapara el hilo principal. El iframe, por ser del
  mismo origen, lo comparte, y noVNC recibe los frames pero no alcanza a pintarlos. En
  modo 2D, o con la misma URL en una página liviana, se ve bien. No lo pude probar en un
  navegador real con GPU. Si pasa ahí, el arreglo es pausar el loop 3D mientras haya una
  viñeta de maravilla abierta.
- Por `http://omarchy-1:5273` (sin TLS, host no-localhost) noVNC avisa "requires a secure
  context". Igual conecta y pinta.
- `/wonder-proxy/*` solo existe con el servidor de desarrollo de Vite (`npm start`), no en
  `vite preview` ni en un build estático.

## Apagar / desinstalar

```bash
curl -X POST -H "X-RepoCiv-Token: $REPOCIV_TOKEN" http://127.0.0.1:5274/api/wonders/ghostdesk/stop
# o: docker stop ghostdesk
claude mcp remove ghostdesk -s local
rm ~/.repociv/wonders/ghostdesk.json          # y quitar REPOCIV_WONDER_PROXIES del .env
docker volume rm ghostdesk-home; docker rmi ghcr.io/yv17labs/ghostdesk:8.1.0
```
