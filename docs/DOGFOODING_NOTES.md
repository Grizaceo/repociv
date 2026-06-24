# RepoCiv — Dogfooding Notes

> Registro vivo de uso real de RepoCiv. Cada entrada es una sesión de uso, no un plan.
> Aprende más de lo que no funciona que de lo que sí.

---

## 2026-05-28

- Flujo probado: sesión de evaluación de roadmap + corrida del loop de sanidad (check / lint / format / pytest / healthcheck / smoke-test) contra el sistema vivo en systemd.
- Qué sí aportó valor: el loop de scripts (`healthcheck.sh`, `smoke-test.sh`) detectó fricción real que la suite de tests no veía.
- Causa raíz común encontrada: `.env` ganó `REPOCIV_TOKEN` (commit `15533c2`), pero el endurecimiento de auth solo eximió `/health` y `/ready`. Todo lo demás quedó token-gated, y el tooling local que pega a endpoints gated no fue actualizado. Tres síntomas del mismo origen:
  1. `test_bridge_integration.py::test_events_endpoint_*` → 401 (los tests no mandaban token; `bridge.py` carga `.env` al importarse). **Arreglado**: helper `_auth_headers()` que manda token si existe. Local-only — CI no tiene `.env` (gitignored).
  2. `healthcheck.sh` → "/metrics no responde" (curl sin token → 401, reportaba DEGRADED falso). **Arreglado**: el script ahora manda `X-RepoCiv-Token` cuando hay token.
  3. `/metrics` quedó gated mientras `/health` y `/ready` no — inconsistencia: `/metrics` es el endpoint de monitoreo por excelencia. **Decidido (2026-06-23): mantener gated** (expone más info en modo remoto) + el monitor manda el token, que es lo que `healthcheck.sh` ya hace tras R2. Sin cambio de código.
- Bug `health: critical` falso por `errorRate: 1.0` — **Arreglado (2026-06-23):** `_compute_error_rate` (ventana por conteo de 50) ahora aplica un **piso de muestra** (`min_sample=5`): con menos de 5 comandos terminales devuelve `0.0` en vez de escalar sobre ruido. El caso original (2 fallas externas viejas — Codex token expirado, OpenRouter 401 — y sistema idle) ya no "cría lobos". Se descartaron la ventana temporal y el filtro de auth-externa como over-engineering para alpha single-user; quedan como opción si reaparece el síntoma con tráfico real.
- Estado de gates hoy: `npm run check` 407✓ + build OK · `npm run lint` 0/0 · `pytest` 621✓/1 skip (tras fix) · `npm run format:check` **falla en 64 archivos** → **CI de `main` está rojo** (paso `format:check` en `ci.yml:28`). Deuda "Fase 0 — decidir Prettier" nunca cerrada. Acción: un commit mecánico `npm run format` (delegable).
- Follow-up: (a) commit de Prettier para desbloquear CI; (b) decidir windowing de métricas; (c) actualizar §2 "Estado actual observado" del ROADMAP_IMPERIAL_WORKSHOP.md, que está desfasado (dice lint rojo 4 errores — ya está verde).

## 2026-05-07

- Flujo probado: sesión de alineación de docs post-auditoría
- Paneles usados: ninguno (trabajo en docs/tests)
- Qué sí aportó valor: el plan maestro corregido (docs/plans/) da dirección clara sin sobredocumentar
- Qué no aportó valor: el execplan tenía Outcomes duplicados y Progress desactualizado — confunde más que guía
- Fricción encontrada: el execplan quedó con contenido duplicado después de patches incrementales. Lección: reemplazar secciones completas, no parchear alrededor.
- Error o bug observado: HERMES_MODEL default inválido (minimax-m2.6 → hermes-agent)
- Decisión tomada: Milestones 2-5 del execplan quedan deferred hasta completar Lotes 1-8 del plan corregido
- Follow-up: continuar con Lote 3 (Validation Contract MVP)
