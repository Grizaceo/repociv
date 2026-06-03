# Phase 3 — WS + Remote Integration & Hardening (Pendiente)

Items pendientes para completar después de las pruebas de Fase 1+2.

## 1. WS Rate Limiting (60 req/min per connection)

Ya implementado en `server/websocket_handler.py` (`_rate_check`). 
Pendiente:
- Test de integración (actualmente marcado `@pytest.mark.skip` por timing-sensitive)
- Verificar comportamiento en producción

## 2. systemd unit para remote mode

Crear `deploy/repociv-remote.service`:
- Ejecuta `scripts/remote-start.sh`
- Variables de entorno: `REPOCIV_TOKEN`, `REPOCIV_REMOTE=true`
- Dependencia: `tailscaled.service` (After + Wants)
- Restart: on-failure
- Hardening: PrivateTmp, ProtectHome, etc.

```ini
[Unit]
Description=RepoCiv Remote Dashboard
After=network-online.target tailscaled.service
Wants=tailscaled.service

[Service]
Type=simple
Environment=REPOCIV_REMOTE=true
EnvironmentFile=%h/.repociv/env
ExecStart=%h/.hermes/workspace/repos/repociv/scripts/remote-start.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

## 3. Remote healthcheck script

Crear `scripts/remote-healthcheck.sh`:
- Verifica bridge HTTP + WS desde localhost
- Verifica reachabilidad via Tailscale IP
- Exit code 0 = healthy, 1+ = degraded
- Integrable con systemd HealthCheck

## 4. Enhanced logging en remote mode

En `server/bridge.py`:
- Log todas las conexiones entrantes (IP, User-Agent, timestamp)
- Log intentos de conexión WS fallidos
- Log intentos de auth fallidos
- Nivel INFO en remote mode, DEBUG en local

## 5. Test WS + Remote juntos

Prueba de integración:
1. Levantar bridge en remote mode (localhost test)
2. Conectar WS client desde script externo
3. Verificar broadcast reachable
4. Verificar auth requerido
5. Verificar rate limiting

## Prioridad sugerida

1. systemd unit (operación persistente)
2. Remote healthcheck (monitoreo)
3. Enhanced logging (debugging remoto)
4. Test WS+Remote (validación final)
5. Rate limit test (bajo prioridad)
