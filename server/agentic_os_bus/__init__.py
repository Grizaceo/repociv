"""Agentic OS event-bus adapter — DORMANT plugin.

Estado: DORMANT. El código está listo y testeado, pero NO está enganchado
al bridge (sin ruta HTTP, sin tool MCP, sin UI). Este paquete no se importa
desde ningún otro módulo del servidor: vive solo.

Activar (cuándo aplica, ver docs/AGENTIC_OS_INTEGRATION.md):
  RepoCiv corriendo como servicio systemd + contrato de integración aprobado.

Diseño: fail-open, mismo patrón que `server/hermes_status.py`.
Si el bus no existe o no responde, las llamadas devuelven
{"available": False, ...} — nunca crashean.

Rol en el OS (A.3 de LABS/agentic-os/PLAN_INTEGRAL.md):
  RepoCiv consume el event stream del bus agentic-os y refleja estado
  simple. Schema canónico: agentic-os.event.v1 (EVENT_SCHEMA.json del bus).
"""

from server.agentic_os_bus.client import (
    AGENTIC_OS_ROOT,
    BusStatus,
    poll_bus,
    bus_status,
)
from server.agentic_os_bus.adapter import to_repociv_event

__all__ = [
    "AGENTIC_OS_ROOT",
    "BusStatus",
    "poll_bus",
    "bus_status",
    "to_repociv_event",
]
