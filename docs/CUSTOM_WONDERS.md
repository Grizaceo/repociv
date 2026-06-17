# RepoCiv — Custom Wonders (P3)

Cómo agregar tus propias Maravillas al launcher de RepoCiv.

> ⚠️ **Read [SECURITY.md](../SECURITY.md) first.** RepoCiv is single-operator;
> the bridge trusts the holder of `REPOCIV_TOKEN` with arbitrary command
> execution on the host. Custom wonders don't change that — the launcher
> just calls `subprocess.Popen` with the argv you put in the manifest.
> If you share your instance, your custom wonders can be triggered by
> anyone with the token.

**TL;DR.** Creás un archivo en `~/.repociv/wonders/<id>.json` con un
[WonderManifest](../WONDER_CONTRACT.md) + un campo opcional `launch`
que describe los comandos CLI a lanzar. Reiniciás el bridge y tu
maravilla aparece en `GET /api/wonders` con auto-start disponible.

---

## 1. Quick start (mínimo viable)

Supongamos que tenés una app en `~/code/mi-app/` con:

- un backend Python que arranca con `python -m backend.bridge`
- un frontend Vite que arranca con `npm run dev`
- el backend escucha en `http://127.0.0.1:9999/api/health`
- el frontend sirve en `http://127.0.0.1:9998`

Creás `~/.repociv/wonders/mi-maravilla.json`:

```json
{
  "id": "mi-maravilla",
  "title": "Mi Maravilla",
  "kind": "iframe",
  "category": "knowledge",
  "version": "0.1.0",
  "defaultEnabled": true,
  "automationLevel": "passive",
  "passiveMode": true,
  "agenticMode": false,
  "canSuggest": false,
  "canAct": false,
  "requiresConfirmation": true,
  "ui": {
    "url": "http://127.0.0.1:9998",
    "preferredWidth": "70vw",
    "preferredHeight": "75vh"
  },
  "health": {
    "url": "http://127.0.0.1:9999/api/health",
    "timeoutMs": 4000,
    "degradedAllowed": true
  },
  "permissions": {
    "readRepos": true,
    "writeRepos": false,
    "network": "loopback-only",
    "requiresApprovalForMutations": true
  },
  "optionalFeatures": [],
  "actions": [
    {"id": "open", "label": "Abrir", "risk": "safe", "requiresUserOptIn": false}
  ],
  "events": {"emits": ["wonder.ready"], "accepts": ["repociv.focus_city"]},
  "mcp": {"enabled": false, "server": null},
  "launch": {
    "repo_dir": "/home/TU_USUARIO/code/mi-app",
    "api_url": "http://127.0.0.1:9999",
    "api_health_path": "/api/health",
    "ui_url": "http://127.0.0.1:9998",
    "procs": [
      {
        "name": "bridge",
        "argv": ["python", "-m", "backend.bridge"],
        "log": "mi-maravilla-bridge.log",
        "env": {"MI_HOST": "0.0.0.0"}
      },
      {
        "name": "ui",
        "argv": ["npm", "run", "dev"],
        "cwd": "/home/TU_USUARIO/code/mi-app/frontend",
        "log": "mi-maravilla-ui.log"
      }
    ]
  }
}
```

Reiniciás el bridge (`Ctrl+C` en el proceso de `python3 -m server.bridge`
y volvé a arrancarlo). Ahora:

- `GET /api/wonders` lista `mi-maravilla` en el array.
- `GET /api/wonders/launchable` la incluye.
- `POST /api/wonders/mi-maravilla/launch` arranca sus dos procesos.
- `GET /api/wonders/mi-maravilla/launch-status` reporta el estado.

---

## 2. Cómo funciona el launcher (modelo mental)

El bridge de RepoCiv corre en loopback (`127.0.0.1`). El campo `launch`
de tu manifest le dice al launcher **qué procesos spawnear** y **cómo
saber cuándo están listos**. No hay un "agente" que lea tu manifest: es
un allowlist server-side de `argv` que el bridge ejecuta con
`subprocess.Popen(..., start_new_session=True)`.

Reglas duras:

1. **El cliente NUNCA puede pasar argv.** Solo el `id` en la URL. Los
   comandos vienen del JSON en disco, no de un request body.
2. **Cada proceso es un Popen independiente** con su propio PID, su
   propio log file en `~/.repociv/wonders/logs/<log>`, y un process
   group separado (señal `SIGTERM` mata al grupo completo al `stop`).
3. **El launcher hace health-checks** contra `api_url + api_health_path`
   y `ui_url + /` para reportar `ready` / `starting` / `degraded` /
   `error`. Sin un endpoint de health, la maravilla queda en
   `starting` indefinidamente.
4. **Modo remoto está deshabilitado.** Si `REPOCIV_REMOTE=true`, el
   launcher rechaza con 403; tenés que arrancar el server manualmente
   en el host.
5. **Adopción de servers externos.** Si tu `api_url` y `ui_url` ya
   responden cuando llamás a `/launch`, el launcher NO spawna — los
   "adopta" como si los hubieras arrancado a mano. Esto evita
   pisar instancias que ya están corriendo.

---

## 3. Referencia del campo `launch`

```ts
interface WonderLaunchSpec {
  // ABSOLUTO. Donde vive el repo. El launcher chequea existencia.
  repo_dir: string;

  // URL base del backend (sin trailing slash, con http:// o https://).
  api_url: string;

  // Path del endpoint de health (default "/health").
  api_health_path?: string;

  // URL base del frontend (default: igual a api_url).
  ui_url?: string;

  procs: ProcSpec[];  // al menos uno
}

interface ProcSpec {
  // Nombre corto (usado en logs, PIDs, errores).
  name: string;

  // Lista de strings no-vacíos. argv[0] puede ser "python"/"python3" —
  // el launcher lo resuelve al venv local (.venv/bin/python o
  // backend/venv/bin/python) si existe.
  argv: string[];

  // ABSOLUTO. Default: el repo_dir del spec.
  cwd?: string;

  // Nombre del log file. Logs van a ~/.repociv/wonders/logs/<log>.
  // Default: "<name>.log".
  log?: string;

  // Env vars adicionales. Se mergean con el env del bridge. Útil
  // para forzar bind a 0.0.0.0 cuando accedés desde Tailscale / WSL2
  // (ej: {"LGB_HOST": "0.0.0.0"}).
  env?: Record<string, string>;
}
```

---

## 4. Casos típicos

### 4.1 App con backend Python (venv local) + frontend Vite

```json
"launch": {
  "repo_dir": "/home/me/code/mi-app",
  "api_url": "http://127.0.0.1:9999",
  "ui_url": "http://127.0.0.1:9998",
  "procs": [
    {
      "name": "bridge",
      "argv": ["python", "-m", "backend.bridge"],
      "env": {"MI_HOST": "0.0.0.0"}
    },
    {"name": "ui", "argv": ["npm", "run", "dev"], "cwd": "/home/me/code/mi-app/frontend"}
  ]
}
```

El `python` se resuelve a `<repo>/.venv/bin/python` si existe, o
`<repo>/backend/venv/bin/python` como fallback. Si tu app usa un
venv en otra ruta, pasá el path absoluto: `argv: ["/home/me/.venvs/mi-app/bin/python", ...]`.

### 4.2 App con un solo proceso que sirve API + UI

```json
"launch": {
  "repo_dir": "/home/me/code/mi-app",
  "api_url": "http://127.0.0.1:9999",
  "ui_url": "http://127.0.0.1:9999",
  "api_health_path": "/health",
  "procs": [
    {"name": "server", "argv": ["go", "run", "."]}
  ]
}
```

### 4.3 App que necesita variables de entorno secretas

**NO** pongas secrets en el JSON. El archivo está en `~/.repociv/`
que no es seguro. En su lugar:

```json
"env": {"DATABASE_URL": "${HOME}/.config/mi-app/db.sqlite"}
```

O exportá la variable en tu shell antes de arrancar el bridge. El
launcher hereda el `os.environ` del proceso bridge y le agrega tu
`env` encima (custom gana).

### 4.4 Display-only (sin auto-start)

Si querés que tu maravilla aparezca en `GET /api/wonders` y en el
listado del frontend pero **no** se auto-arme, simplemente **omití
el campo `launch`**. El launcher la ignora. El registry la lista
igual. Útil para maravillas que el usuario inicia a mano
(playwright servers, jupyter notebooks, etc.).

---

## 5. Verificación

Después de reiniciar el bridge, en una terminal:

```bash
# ¿Aparece en el listado?
curl -s http://127.0.0.1:8642/api/wonders | jq '.[] | {id,title}'

# ¿Está en launchable?
curl -s http://127.0.0.1:8642/api/wonders/launchable

# Lanzarla
curl -X POST -H "X-RepoCiv-Token: $REPOCIV_TOKEN" \
  http://127.0.0.1:8642/api/wonders/mi-maravilla/launch

# Estado
curl -s http://127.0.0.1:8642/api/wonders/mi-maravilla/launch-status
```

Logs en `~/.repociv/wonders/logs/<tu-log>`.

---

## 6. Troubleshooting

| Síntoma | Causa probable | Fix |
|---------|----------------|-----|
| `unknown_wonder` 404 | El id del manifest no coincide con el `id` en el archivo | Asegurate que el campo `id` del JSON sea el mismo que el nombre del archivo (sin `.json`) |
| `repo_not_found` 412 | `launch.repo_dir` no existe | El path debe ser absoluto y la carpeta debe existir |
| `proc_cwd_not_found` 412 | `procs[i].cwd` no existe | Mismo — absoluto, debe existir |
| `spawn_failed` 500 | El binario en `argv[0]` no está en `$PATH` | Usá un path absoluto, o asegurate que el venv está activado |
| Estado `error` después de 20s | Todos los procesos murieron y no responden los health-checks | Revisá `~/.repociv/wonders/logs/<log>` |
| Estado `degraded` | Solo uno de api/ui responde | El Vite puede tardar en compilar; esperá. Si persiste, revisá que `ui_url` sea correcto |
| Tu maravilla no aparece en el frontend | El `WONDER_MANIFESTS` del frontend está hardcodeado | Limitación conocida — el backend la ve y la puede lanzar, pero el UI list usa el manifest estático. Próxima iteración del frontend va a fetchear `/api/wonders` |

---

## 7. Override de maravillas built-in

Si ponés un manifest con `id: "bibliotheca"` (o `"institutum"`),
**gana tu versión**. El bridge loguea un warning a stderr:

```
[wonder_launcher] custom spec for 'bibliotheca' overrides the built-in
```

Útil si querés apuntar la maravilla built-in a un fork propio sin
tocar el código de RepoCiv. Para volver al default, borrá el archivo
y reiniciá el bridge.

---

## 8. Referencias

- [`WONDER_CONTRACT.md`](../WONDER_CONTRACT.md) — schema del manifest
- [`server/wonder_launcher.py`](../../server/wonder_launcher.py) — implementación
- [`server/wonder_registry.py`](../../server/wonder_registry.py) — registry
- `server/tests/test_wonder_launcher.py` — tests con custom specs (9 nuevos)
- `GET /api/wonders` y `GET /api/wonders/launchable` — runtime introspection

---

*Contrato mantenido por el equipo RepoCiv. Cambios incompatibles pasan
por `WONDER_CONTRACT.md` con aviso previo.*
