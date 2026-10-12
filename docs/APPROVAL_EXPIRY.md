# Contrato de expiración de aprobaciones

## Invariante

Una aprobación con `expires_at <= now` no puede autorizar ni encolar su comando.
El chequeo del plazo y el consumo single-use comparten el lock del store dentro
**de un único proceso bridge**. Aprobar válidamente antes del plazo consume la
aprobación; no se cancela luego un comando ya autorizado porque haya transcurrido
su antiguo TTL.

## Operación

- `REPOCIV_APPROVAL_TTL_S` conserva su default de 86400 segundos (24 horas).
  Valores no enteros o no positivos usan ese default y emiten un warning.
- `get_approvals`, `pop_approval`, `resolve_approval` y el cascade de misión
  comprueban vencimientos; no dependen de reiniciar el bridge.
- El worker existente hace un barrido cada vuelta (normalmente cada 2 segundos),
  sin necesidad de navegador conectado ni de un daemon adicional.
- El vencimiento registra `CommandRejected` con `data.reason = "approval expired"`
  en el Event Store y elimina el pendiente de `approvals.json` (modo 0600).
- Plazos nulos, no numéricos, booleanos, NaN o infinitos se rechazan con
  `"invalid approval deadline"`.
- Si el audit o la persistencia fallan, no se autoriza el pendiente caducado;
  se registra el fallo en logging y se reintenta en la siguiente operación/barrido.
  El listado oculta vencidos aunque no pueda retirarlos del disco y el worker
  sigue despachando otros comandos. Cada entrada se procesa independientemente.
  Un rechazo ya auditado se recuerda dentro del proceso para no duplicarlo al
  reintentar persistencia. JSONL y el JSON del store no comparten transacción:
  un reinicio entre ambas escrituras todavía puede repetir el evento terminal.

## Compatibilidad legacy

Los pendientes antiguos sin `expires_at` no conservan permiso indefinido:
se les asigna una sola vez un plazo persistido basado en `created_at + TTL`,
limitando created_at al momento de carga. Si falta created_at se usa carga + TTL;
si created_at es inválido se vence inmediatamente. Reiniciar no renueva el plazo.

## Respuestas y UI

- HTTP y WS comparten `resolve_approval`.
- Si una respuesta llega al pendiente justo cuando este se vence, la API devuelve
  `ok: false`, `status: "expired"`, `error: "approval expired"`.
- Si ya se retiró en otro barrido o petición, responde `approval not found`; no
  se reabre ni se vuelve a ejecutar.
- `approval_expired` via SSE/WS cierra la tarjeta de chat, elimina sus acciones y
  muestra `Vencida — no ejecutada`. El panel elimina pendientes usando su polling
  existente. Tras un evento perdido/reconexión, ese mismo poll reconcilia tarjetas
  ausentes como `Ya no pendiente / no confirmado`, sin inventar aprobación.
- El chat muestra `Aprobado`/`Rechazado` solo después de una respuesta `ok: true`.

## Verificación

```sh
.venv/bin/python -m pytest server/test_approval_expiry.py server/test_approval_expiry_transport.py server/test_approval_store.py -q
npx --no-install vitest run src/ui/approvalCards.test.ts
npx --no-install playwright test e2e/approval-expiry.spec.ts --workers=1
bash scripts/check.sh
```

Las pruebas usan estado aislado, reloj controlado, carreras con barrera de threads,
HTTP real en un puerto efímero y Event Store JSONL temporal. El E2E usa Chromium
con módulos reales del frontend y respuestas HTTP interceptadas: nunca aprueba ni
rechaza pendientes reales. Los cambios Python requieren reiniciar el bridge para
que el proceso vivo cargue esta implementación.

## Límite previo separado del vencimiento

El camino de autorización válida ya consumía la aprobación antes de persistir la
cola del scheduler. Un fallo de enqueue puede perder un comando autorizado;
resolver esa atomicidad entre store, audit y scheduler exige otro contrato de
recuperación. Este cambio no promete entrega transaccional de comandos válidos
ni intenta corregirla moviendo ingenuamente enqueue antes del consumo (eso
abriría otra ventana de reejecución tras reinicio).
