# RepoCiv — Dogfooding Notes

> Registro vivo de uso real de RepoCiv. Cada entrada es una sesión de uso, no un plan.
> Aprende más de lo que no funciona que de lo que sí.

---

## 2026-09-13

- Flujo probado: pasada de dogfooding/QA (Fase 4 del audit) sobre la app viva
  (bridge+vite en systemd, `127.0.0.1:5273`), post Fase 0-3, enfocada **solo** en
  las 4 cosas que el owner definió como core value. Manejada con Playwright real
  (eventos de teclado, no synthetic).
- **Qué funciona (las 4 cosas core están sanas):**
  1. **Barra de agentes:** `Ctrl+Q/E/Shift+W` spawnean MAIN/SCOUT/WORKER → aparecen
     como chips en el hero bar (0→3 verificado); no page errors.
  2. **Repos-como-ciudades:** 49 ciudades legibles con nombre (CARCOSA, CAPITAL,
     AGENTIC-LAB, docs, engme…).
  3. **Affordances espaciales:** el badge de conteo por ciudad funciona (se ve un
     "2" sobre el CAPITAL); `Space` cicla entre héroes idle (breadcrumb cambió
     WORKER→Main); el breadcrumb de selección refleja el contexto ("⬡ MAIN·idle·
     En espera de misión") → recall OK.
  4. **Chat Hermes end-to-end:** seleccionar unidad (click chip) → `Enter` abre el
     side-panel con `#chat-input` → mandar mensaje → `POST /bridge/commands`. El
     event store confirma el round-trip completo: `execute_agent` → `AgentOutputChunk`
     → `CommandCompleted result="hola"`. La UI muestra mi mensaje, la burbuja de
     MAIN, y un ticker "MAIN trabajando…".
- **Fricción encontrada (para uso diario):**
  - **[media-alta] Latencia del chat de MAIN ~55s** para responder "hola".
    `CommandStarted`→`CommandCompleted` = 55s: cada mensaje **cold-bootea una sesión
    de agente completa** (los AgentOutputChunk muestran preámbulo de identidad/misión
    + cwd + session_id antes del "hola"). Mitigado por el ticker "trabajando…", pero
    doloroso para chats rápidos. Es arquitectural (MAIN = agente pesado), no un bug.
    *Recomendación:* para quick-chats, un perfil/modelo más liviano (el selector
    Hermes/provider ya existe en el header del chat), o sesiones warm reusables.
  - **[baja] Naming de chips:** todo agente spawneado se rotula "Agente Principal N"
    sin importar el tipo (un SCOUT dice "SCOUT Agente Principal 2") — identidad confusa.
  - **[baja] Discoverability del chat:** hay que **seleccionar** una unidad (click en
    el chip) y *luego* `Enter`; durante la carga el hero bar muestra un placeholder
    "Desplegando el mapa…" que se puede cliquear por error. Una vez abierto, el empty
    state ("SILENCIO EN LA SALA DEL TRONO — escribe un decreto…") guía bien.
- Veredicto: **las 4 cosas core funcionan** tras Fase 0-3; la app está en condiciones
  de uso diario. La fricción #1 es la latencia del chat de MAIN (arquitectural). Nada
  bloqueante; ningún error de página en toda la pasada.

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

## Update 2026-09-21 (auditoría de pendientes)

- Re-chequeo de las fricciones [baja]: el naming "Agente Principal N" sigue presente
  (`src/ui/panel.ts:29`, hero 'Agente Principal'); discoverability del chat y latencia
  MAIN sin cambios (arquitectural). Sin acción tomada — prioridad baja; quedan
  registradas aquí hasta que se decida el pruning de paneles (UX_IMPROVEMENT_PLAN /
  Task C2 del plan Nebius).
