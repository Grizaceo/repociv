# Systemd User Services for RepoCiv

Estado real (2026-10-15): la única unit instalada en esta máquina es
`repociv.service` (supervisor); su plantilla y un drop-in de ejemplo están
versionados en este directorio. Los templates "split" (`repociv-bridge`,
`repociv-frontend`, `repociv.target`) quedaron **legacy** y `repociv-backup.*`
es opcional y **no está instalado**. Detalle abajo.

## Recomendado — `repociv-prod.service` (build de producción, checkout dedicado)

`repociv.service` corre el servidor de **desarrollo** de Vite desde el checkout
donde trabajás: correr `scripts/check.sh` reescribe `dist/`/`coverage/` y recarga
las pestañas abiertas, y el bridge sigue con el código que importó al arrancar.
La variante de producción separa ambas cosas:

```bash
scripts/deploy-local.sh                   # worktree en ~/.local/share/repociv/deploy @ origin/main,
                                          # npm ci + requirements.lock + vite build
cp deploy/systemd/repociv-prod.service ~/.config/systemd/user/
mkdir -p ~/.config/systemd/user/repociv-prod.service.d
printf '[Service]\nEnvironmentFile=%%h/.hermes/workspace/ACTIVE/repociv/.env\n' \
  > ~/.config/systemd/user/repociv-prod.service.d/env.conf   # o copiá el .env
cp deploy/systemd/repociv.service.d/tailscale.conf.example \
   ~/.config/systemd/user/repociv-prod.service.d/tailscale.conf  # si usás Tailscale Serve
systemctl --user daemon-reload
systemctl --user disable --now repociv.service     # mismo puerto: una u otra
systemctl --user enable --now repociv-prod.service
```

- `REPOCIV_MODE=production`: `scripts/dev-start.sh` sirve `dist/` con `vite preview`
  (mismas rutas `/api`, gate de acceso, CSP y proxies; sin HMR ni watcher).
- Actualizar: `scripts/deploy-local.sh --restart` (o `--ref <tag|commit>`).
- Volver al modo anterior: `disable --now repociv-prod`, `enable --now repociv`.
- Ambas plantillas aceptan `SuccessExitStatus=143`: un stop normal ya no queda
  registrado como `Failed`.

## Canonical — `repociv.service` (supervisor)

- Archivo: `~/.config/systemd/user/repociv.service` (enabled; `WantedBy=default.target`,
  con `linger=yes` para el usuario: arranca al login y sobrevive al logout).
- Qué corre: `/usr/bin/bash scripts/dev-start.sh` como **supervisor** — escribe el
  lockfile (`~/.repociv/repociv.lock`), lanza bridge (5274) + Vite (5273), espera el
  healthcheck, corre el smoke test y monitorea a los hijos.
- `KillMode=control-group` garantiza que el stop también mata a los hijos;
  `Restart=on-failure` con `RestartSec=5` y `StartLimitIntervalSec=120/Burst=5`
  dan margen al arranque del bridge antes de contar CrashLoop.
- Logs: `~/.repociv/logs/systemd-stdout.log` / `systemd-stderr.log` (append),
  más `bridge.log` y `vite.log` del supervisor, y `journalctl --user -u repociv`.
- Drop-in: `~/.config/systemd/user/repociv.service.d/tailscale.conf` agrega
  `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` para acceso vía Tailscale. Plantilla
  del drop-in: [`repociv.service.d/tailscale.conf.example`](repociv.service.d/tailscale.conf.example).

> La **copia instalada** vive en `~/.config/systemd/user/` y no se versiona:
> puede divergir de la plantilla. La plantilla versionada es
> [`repociv.service`](repociv.service) en este directorio. Para inspeccionar o
> recuperar el contenido exacto de la copia viva:
> `systemctl --user cat repociv`.

### Instalar (recrear la unit desde el repo)

```bash
systemd-analyze --user verify deploy/systemd/repociv.service   # opcional
mkdir -p ~/.config/systemd/user/repociv.service.d ~/.repociv/logs
cp deploy/systemd/repociv.service ~/.config/systemd/user/

# Drop-in opcional (acceso vía Tailscale): reemplazá <tu-host> por tu hostname
cp deploy/systemd/repociv.service.d/tailscale.conf.example \
   ~/.config/systemd/user/repociv.service.d/tailscale.conf

systemctl --user daemon-reload
systemctl --user enable --now repociv
```

- `~/.repociv/logs/` debe existir antes del primer arranque: systemd abre los
  archivos de `StandardOutput=`/`StandardError=` antes de ejecutar
  `dev-start.sh` (que también los crea).
- La plantilla usa `%h` (systemd lo expande al home del usuario en units de
  usuario). Si tu checkout vive en otra ruta, ajustá `WorkingDirectory`,
  `ExecStart` y `Documentation`, o usá rutas absolutas. La copia viva de esta
  máquina usa rutas absolutas y `Documentation=` apunta a
  `docs/ESTADO-2026-09-30.html` (snapshot histórico); la plantilla apunta al
  README de este directorio, como los units legacy.
- Arranque en login y supervivencia al logout: `loginctl enable-linger $USER`.

### Operar

```bash
systemctl --user status repociv      # estado + árbol de procesos hijos
systemctl --user restart repociv     # restart correcto con la unit viva
systemctl --user stop repociv        # detiene supervisor + hijos (control-group)
journalctl --user -u repociv -f      # logs del supervisor
```

⚠ Con la unit activa **no** uses `scripts/dev-stop.sh`: mata los hijos por
lockfile/puertos y systemd lo lee como fallo (ver el warning en el script).

### Healthcheck

```bash
curl -sf http://localhost:5274/health   # Bridge
curl -I  http://localhost:5273/         # Frontend
```

## Backup (opcional — no instalado)

`repociv-backup.service` + `repociv-backup.timer` respaldan cada 6h
(`Persistent=true`) `events.jsonl`, `missions.json`, `scheduler-queue.json`,
`directive_records.jsonl` y `directive_templates.json` en `~/.repociv/backups/`,
con rotación de 30 días (`scripts/repociv-backup.sh`).

Estado actual: el timer **no está instalado** y `~/.repociv/backups/` no existe
→ no hay backups corriendo.

```bash
# Instalar (opcional)
cp deploy/systemd/repociv-backup.service deploy/systemd/repociv-backup.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now repociv-backup.timer
systemctl --user list-timers 'repociv*'
```

## Legacy — split bridge/frontend/target (no instalar)

`repociv-bridge.service`, `repociv-frontend.service` y `repociv.target` son de
la era WSL y están **superados** por el supervisor `repociv.service`:

- apuntan a `%h/.hermes/workspace/repos/repociv` (path que ya no existe — el repo
  vive en `.../workspace/ACTIVE/repociv`);
- corren el bridge con el python del sistema (`/usr/bin/python3`, sin `.venv` y
  sin `fastapi` instalado);
- separan bridge y frontend en units independientes, arquitectura que el
  supervisor reemplazó (lockfile + port cleanup + monitoreo).

Se conservan solo como referencia histórica. No copiar ni instalar: chocarían
con la unit viva por puertos y lockfile.

## Troubleshooting

### Puerto ya en uso

Con la unit viva no hace falta matar PIDs a mano: `dev-start.sh` limpia el
lockfile anterior y libera 5273/5274/5275 al arrancar. El restart correcto es:

```bash
systemctl --user restart repociv
```

Si querés ver quién tiene el puerto:

```bash
lsof -i :5274   # bridge
lsof -i :5273   # vite
```

### Logs completos

```bash
journalctl --user -u repociv -n 100 --no-pager
tail -f ~/.repociv/logs/systemd-stdout.log ~/.repociv/logs/systemd-stderr.log
tail -f ~/.repociv/logs/bridge.log ~/.repociv/logs/vite.log
```
