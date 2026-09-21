# WORKER fix — resuelto 2026-05-30

## Decisión aplicada

Se mantuvo el aislamiento del perfil `~/.hermes/profiles/worker/` y se descartó mover WORKER al gateway principal de DAVI.

Configuración efectiva verificada:

- provider: `ollama-cloud`
- model: `deepseek-v4-pro`
- endpoint: `https://ollama.com/v1`
- toolset: `hermes-cli`
- memoria/checkpoints/streaming: desactivados para mantener al WORKER stateless

## Causa raíz confirmada

Las fallas anteriores de WORKER venían de una configuración de proveedor/modelo incompatible o endpoint incorrecto en el perfil aislado del worker:

1. Provider/modelo anterior no era usable con el flujo Hermes CLI + tools.
2. `https://api.ollama.com/v1` devuelve HTTP 301 hacia `https://ollama.com/v1`, y Hermes CLI no sigue ese redirect en este flujo; por eso debe usarse `https://ollama.com/v1` directamente.

## Verificación directa

Comando ejecutado:

```bash
HERMES_HOME=~/.hermes/profiles/worker \
  hermes chat -q 'Responde exactamente WORKER_OK y nada mas.' -Q --source tool
```

Resultado:

```text
WORKER_OK
```

## Verificación vía RepoCiv bridge

Se envió una misión real desde el bridge a la unidad `WORKER` en la ciudad `repociv`:

```text
Responde exactamente REPOCIV_WORKER_OK y nada mas.
```

Eventos observados en `~/.repociv/events.jsonl`:

```text
CommandCreated   166e7350-d6f
CommandQueued    166e7350-d6f
CommandStarted   166e7350-d6f
AgentOutputChunk WORKER 166e7350-d6f REPOCIV_WORKER_OK
CommandCompleted 166e7350-d6f
```

## Estado

WORKER responde correctamente usando su perfil aislado. El warning de `tirith security scanner enabled but not available` no apareció en la prueba final y, cuando aparece, es no fatal según la skill `repociv-permanent-console`.
