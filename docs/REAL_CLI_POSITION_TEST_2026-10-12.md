# Prueba real de posición de CLI — 2026-10-12

## Veredicto

**Claude Code aprobado. Codex aprobado tras una reparación:** su primera corrida, registrada abajo, falló el cambio de repo con Code Mode. Ver «Repetición de Codex tras la reparación».

Se ejecutaron modelos reales mediante sus CLI nativas, con comandos de solo lectura (`pwd` y `git status --short`) en `formal-math-lab` y `financial-lab`. No se emitieron hints sintéticos ni se fabricaron identidades para estas pruebas.

| CLI | Sesión fuente | Unidad | Ciudad inicial | Ciudad tras trabajar en financial-lab | Resultado |
|---|---|---|---|---|---|
| Claude Code | `claude-a588defe-4b53-4fc3-bc55-35fcc94bda7a` | `ext-claude-code-a588defe` | formal-math-lab | financial-lab | Aprobado |
| Codex, primera corrida | `codex-01a13045-8b60-7d20-b303-a3adf5fa892a` | `ext-openai-codex-01a13045` | formal-math-lab | formal-math-lab (incorrecto) | Falló ubicación |
| Codex, tras la reparación | la misma | la misma | formal-math-lab | financial-lab | Aprobado |

## Claude Code

- La primera operación real observó el cwd de formal-math-lab.
- Dos intentos de cambiar a financial-lab fueron denegados por `dontAsk`; **no se cuentan como trabajo ejecutado**.
- Se retomó la misma sesión nativa con `--resume`, sin `--fork-session`, en modo manual. Se aprobó únicamente el comando de lectura mostrado por el diálogo nativo, sin cambiar a modo auto ni desactivar permisos.
- El resultado real de Bash observó financial-lab.
- API y mapa conservaron la misma unidad y sesión Suvadu. Coordenadas del mapa: **(0,1) → (2,3)**.
- La ubicación se mantuvo después de esperar 35 segundos y volver a observar el backend y el mapa.
- Suvadu terminó registrando **2 comandos**; eventos y tokens continuaron acumulándose, sin reiniciar identidad.

## Codex, primera corrida

- Codex v0.162.1 ejecutó ambas operaciones reales en sandbox `read-only`. Se aceptó la confianza nativa del repo; no se utilizó bypass de sandbox ni de aprobación.
- El rollout nativo confirma salidas con código **0** y cwd de cada repo.
- Suvadu registró **2 comandos**, conservando la misma sesión, unidad y métricas.
- Sin embargo, API y mapa dejaron la unidad en formal-math-lab: **(0,1) → (0,1)**.
- El panel nativo `/hooks` mostró PostToolUse con dos grupos/comandos; esto incluye los hooks propios y Suvadu, no constituye por sí mismo duplicación.
- El rollout muestra la herramienta externa `exec`, que contiene `tools.exec_command(...)` y su `workdir` dentro de JavaScript. El adaptador actual acepta argumentos estructurados/JSON, pero deliberadamente no analiza cuerpos de código. Una reproducción offline con esa entrada conserva el cwd de lanzamiento.
- **Diagnóstico fuerte, no captura exacta del stdin del hook:** no se interceptó el payload nativo. No se presenta la reconstrucción offline como evidencia de transporte real ni como una reparación.

## Repetición de Codex tras la reparación

Registrada el mismo día a las 11:02, sobre la misma sesión nativa y la misma unidad.

- **Reparación:** el cliente del hook ya no depende del workdir del payload. Lo toma del `CommandExecution` completado en el rollout nativo de esa sesión, emparejado por IDs exactos de sesión, turno y herramienta. Sigue sin analizar cuerpos de código.
- **Resultado:** API y mapa movieron la unidad de formal-math-lab a financial-lab, **(0,1) → (2,3)**, y la dejaron allí en la observación posterior.
- Code Mode siguió activo. No se emitieron pistas sintéticas. Hubo exactamente una unidad en cada etapa observada.
- El rollout nativo registra dos ejecuciones completadas con código 0, una en cada repo.
- **Pruebas:** 3 fallaban antes de la reparación (25 pasaban). Después: 83 dirigidas, 1383 Python con 2 omitidas, 1126 de frontend, gate integral con exit 0.
- Limpieza: sonda retirada, CLI cerrado, estado Git de ambos repos sin cambios.

Límites de esta repetición:

- La evidencia declara su revisión como «pending independent review».
- `server/agent_hook_client.py` se modificó a las 11:10, después de esta repetición. Las pruebas dirigidas pasan sobre la versión final, pero la corrida real no se repitió sobre ella.

## Invariantes y límites

Lo que sigue describe la primera corrida.

- En los snapshots de las fases A/B, cada identidad de prueba corresponde a exactamente una fila de sesión, una unidad API y una unidad del mapa. No se detectó duplicación en esas observaciones; no se promete cobertura continua de todos los instantes.
- Las identidades acreditadas provienen de Suvadu, no de los hints de posición.
- El estado Git de ambos repos coincide con el baseline previo. Se conservaron sus cambios preexistentes.
- Los procesos de prueba y la sesión tmux fueron cerrados y su ausencia se verificó. El bridge permaneció saludable; no se reinició.
- No se modificó código funcional de RepoCiv, el núcleo Hermes ni los hooks instalados durante esta validación. Las decisiones de confianza nativa de los CLI son estado esperado del lanzamiento.
- No se ejecutó una nueva suite completa: este trabajo prueba el flujo vivo de CLI/API/mapa, no cambia la implementación.
- La compatibilidad de ubicación con Code Mode de Codex quedó pendiente en esta corrida. Se reparó y se repitió después: ver la sección anterior.

## Evidencia

`evidence/real-cli-position-2026-10-12.json` contiene los snapshots sanitizados de las identidades de prueba, coordenadas, contadores, resultados de herramientas y verificación de limpieza. No incluye credenciales, prompts, transcripciones completas ni sesiones ajenas.

`evidence/codex-code-mode-fixed-2026-10-12.json` contiene lo mismo para la repetición de Codex, más los conteos de pruebas antes y después de la reparación.
