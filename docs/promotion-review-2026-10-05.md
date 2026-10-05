# Revisión para promoción — 2026-10-05

RepoCiv tiene una base funcional para presentarlo como alpha local. Antes de dirigir nuevos usuarios al repositorio, conviene alinear lo que muestra la nueva demo con el código público y comprobar el arranque Docker.

## Local y remoto

- Rama local revisada: `feat/local-view-activity`, HEAD `af9da36853983a009d79a2ecbc7ba9aee5a6dabf`.
- Árbol limpio al iniciar la revisión; 12 commits por delante de main, ninguno por detrás. Cambios: 34 archivos, +3577/-36 líneas. La rama no estaba publicada.
- Remoto público: `Grizaceo/repociv`, main `1b85f8804410a63fd0db9942f95d8b5dbd13c687`. Último push registrado: 2026-09-27.
- Sin releases ni issues/PRs abiertos. Workflows disponibles, pero la consulta a GitHub no devolvió ejecuciones ni check runs para respaldar el estado del HEAD. No equivale a CI verde.

## Verificación

Se ejecutaron los checks con estado y datos aislados; main se comprobó desde un archivo Git separado.

| Código | Frontend | Backend |
| --- | --- | --- |
| main público | 1029 tests; TypeScript y build pasan | 1205 pasan, 2 omitidos |
| rama local | 1096 tests; TypeScript y build pasan | 1212 pasan, 2 omitidos |

Lint, formato y Ruff pasan en la rama local. La UI habitual cargó el mapa de 113 repositorios sin errores de página en la comprobación. Esto no verifica todas las integraciones de agentes.

Una prueba E2E dirigida de main falló al esperar `#hero-bar-slots .hero-chip`, aunque el mapa y HUD sí cargaron. No se completó una suite E2E verde en esta revisión; hace falta distinguir expectativas antiguas de fallos actuales antes de anunciar estabilidad.

## Pendientes antes de promocionar

1. Integrar/publicar la rama que muestra la nueva demo, o presentar expresamente el vídeo como avance de una rama en desarrollo.
2. Comprobar Docker: `docker/entrypoint.sh` exporta `BRIDGE_HOST=0.0.0.0`, pero `server/bridge.py` calcula el host únicamente desde `REPOCIV_REMOTE`, vacío en Compose. Por lectura del código, el bridge queda en loopback dentro del contenedor y los puertos HTTP/WS publicados no son accesibles desde el host. Es un hallazgo estático, sin validación completa de un contenedor nuevo en esta revisión.
3. Obtener una señal de CI comprobable y actualizar las expectativas E2E que fallen.
4. Actualizar la presentación: el README describe assets como no versionados aunque varios están en Git; el roadmap conserva una fecha antigua. La demo GIF anterior tampoco estaba enlazada en el README.

## Nueva demo

Se preparó `docs/design/screenshots/repociv-demo-2026-10-05.mp4`, con GIF y portada. Muestra capturas nativas del mapa, panel de archivos, vista local y una respuesta real de Codex registrada en el ledger. Es un montaje de capturas verificadas, con workspace de ejemplo y rótulos en inglés. Su procedencia y limitaciones están documentadas junto al archivo.

El mensaje del enlace de X invita a compartir una URL y explicar lo que se está construyendo. RepoCiv encaja como alpha de un dashboard local; conviene evitar presentarlo como producto estable o demo web alojada. No se publicó ningún mensaje ni se modificó el remoto.
