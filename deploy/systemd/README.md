# Systemd User Services for RepoCiv

Servicios systemd para ejecutar RepoCiv de forma permanente en WSL.

## Arquitectura

- `repociv-bridge.service`: Backend API (Python, puerto 5274)
- `repociv-frontend.service`: Vite dev server (Node, puerto 5273)
- `repociv.target`: Target combinado para gestionar ambos servicios juntos
- `repociv-backup.service` + `repociv-backup.timer`: snapshot verificable cada 6h de state, config y selección de repos

## Instalación

```bash
# Copiar servicios a ~/.config/systemd/user/
cp deploy/systemd/*.service ~/.config/systemd/user/
cp deploy/systemd/*.timer ~/.config/systemd/user/
cp deploy/systemd/*.target ~/.config/systemd/user/

# Recargar systemd
systemctl --user daemon-reload

# Habilitar para startup automático
systemctl --user enable repociv.target
systemctl --user enable --now repociv-backup.timer

# Iniciar
systemctl --user start repociv.target
```

## Comandos útiles

```bash
# Estado general
systemctl --user status repociv.target

# Estado individual
systemctl --user status repociv-bridge.service
systemctl --user status repociv-frontend.service
systemctl --user status repociv-backup.timer
systemctl --user list-timers 'repociv*'

# Detener
systemctl --user stop repociv.target

# Reiniciar
systemctl --user restart repociv.target

# Ver logs
journalctl --user -u repociv-bridge.service -f
journalctl --user -u repociv-frontend.service -f
journalctl --user -u repociv-backup.service -n 50 --no-pager

# Deshabilitar startup automático
systemctl --user disable repociv.target
```

## Troubleshooting

### Puerto ya en uso

Si el servicio falla con "Address already in use":

```bash
# Bridge (5274)
lsof -i :5274
kill -9 <PID>

# Frontend (5273)
lsof -i :5273
kill -9 <PID>

# Reiniciar servicio
systemctl --user restart repociv.target
```

### Permisos de escritura

Si hay errores de "Read-only file system" en los directorios configurados por `REPOCIV_STATE_DIR`, `REPOCIV_CONFIG_DIR` o `REPOCIV_BACKUP_DIR`:

1. Verificar las rutas efectivas en `.env`.
2. Verificar que el usuario del servicio tenga lectura/escritura.
3. Ejecutar `systemctl --user start repociv-backup.service` y revisar `ExecMainStatus=0`.

### Logs completos

```bash
journalctl --user -u repociv.target --no-pager -n 50
```

## Persistencia

Los servicios están configurados con:
- `Restart=on-failure`: Reinicio automático en caso de fallo
- `RestartSec=5`: Espera 5 segundos entre reintentos
- Habilitados en el user session: sobreviven a reboot de WSL
- `repociv-backup.timer`: respalda el state root completo relevante (events, missions, approvals, scheduler, sessions, run-state, ledger), config (`profiles.json`) y el registro Vite de roots/repos. Cada snapshot incluye `SHA256SUMS`, se publica atómicamente y rota a 30 días.

## Healthcheck

Verificar que ambos servicios estén activos:

```bash
curl http://localhost:5274/health  # Backend
curl -I http://localhost:5273/     # Frontend
```
