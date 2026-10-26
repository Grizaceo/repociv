# Demo — 2026-10-25

- **MP4:** `repociv-demo-2026-10-25.mp4` — 41.1 s, 1280×720, H.264 (`yuv420p`, `+faststart`), 30 fps nativos con `requestAnimationFrame` bloqueado a paso constante (`dt` determinista sobre GPU NVIDIA RTX 4060 via ANGLE/EGL), sin audio, 11.63 MB.
- **GIF:** `repociv-demo-2026-10-25.gif` — 640×360, 6 fps (paleta adaptativa `palettegen`/`paletteuse`), 12.22 MB.
- **Portada:** `repociv-demo-2026-10-25-preview.jpg` — 1280×720.
- **Build mostrado:** rama `main` tras integrar la familia visual 2K PBR (*ciudad del conocimiento vivo*), la órbita de cámara 3D (`Q`/`E` + arrastrar botón central), la tarjeta de unidad acoplada en el panel lateral (`#62`) y `RoundTablet` Bot Mode (`#61` / `#62`).

## Contenido por capítulos (6 escenas)

1. **`01 / 06 · 3D HEX WORLD` (0.0 s – 8.0 s):** Mapa hexagonal 3D WebGL con biomas biselados, ríos borde a borde con puentes, espuma costera y órbita de cámara fluida estilo Civilization V (`Q`/`E` y botón central del ratón) mientras las unidades caminan sobre los hexágonos.
2. **`02 / 06 · 2K PBR FAMILY` (8.0 s – 15.5 s):** Recorrido en primer plano por la nueva identidad arquitectónica 2K PBR (piedra caliza cálida, pizarra oscura, cobre envejecido y acentos ámbar/turquesa): Ciudadela y Plaza Cívica en la Capital, murallas modulares, figurillas de agentes por rol y las maravillas de servicios (`Memory Archive`, `Observatory · Grafana`, `Coordination Court · Airflow`, `Connection Gateway · GhostDesk`, `Artifact Vault · DuckDB`, `Research Lab · ML`, `Execution Workshop · Docker`).
3. **`03 / 06 · DOCKED UNIT HUD & LIVE AGENT CHAT` (15.5 s – 23.5 s):** Selección de unidad y apertura del panel lateral con la ficha de unidad acoplada dentro de la pestaña **Unidad** (sin ventanas flotantes superpuestas), seguida de la pestaña **Crónicas** con el diagnóstico del bug de paginación en `sentinel-flask/app.py`.
4. **`04 / 06 · ROUNDTABLET` (23.5 s – 32.0 s):** Ventana HUD nativa de **RoundTablet (Bot Mode)** abierta desde la barra del minimapa, sentando en la misma mesa perfiles de Hermes (`Worker`, `QA`) y harnesses CLI (`Claude Code`, `Codex`) para deliberar por turnos vía SSE sobre `sentinel-flask/app.py`.
5. **`05 / 06 · LOCAL 2.5D VIEW` (32.0 s – 38.5 s):** Vista local isométrica 2.5D dentro de `sentinel-flask`, donde las carpetas son salas (`RECEPTION`, `OPEN SPACE`, etc.), los archivos son workbenches con etiquetas activas y el agente camina hacia el archivo que inspecciona.
6. **`06 / 06 · CLOSING CARD` (38.5 s – 41.3 s):** Tarjeta de cierre sobre el panorama 3D con resumen de capacidades y enlace a `github.com/Grizaceo/repociv`.

## Procedencia y aislamiento

- Las capturas se obtuvieron con Chromium + Playwright sobre un workspace público de demostración (`repociv`, `sentinel-flask`, `taskforge`, `pipeline-utils`, `knowledge-hub`, `ml-eval-suite`, `edge-gateway`, `legacy-archive`), sin exponer nombres ni rutas de repositorios privados.
- La deliberación de `RoundTablet` (`roundId: facc4882`, duración 51.55 s) se ejecutó contra una instancia aislada del bridge (`BRIDGE_PORT=5774`, `REPOCIV_CONFIG_DIR=/tmp/repociv-demo-state-20261025`) sobre `demo-workspace/sentinel-flask/app.py`:
  - **Turno 1 (`WORKER` / `hermes:worker`):** `The _paginate function incorrectly uses per_page as the exclusive end index instead of a slice length — for page 2 with per_page=20, start=20 and rows[20:20] returns an empty list. The fix is rows[start:start + per_page].`
  - **Turno 2 (`QA` / `hermes:qa`):** `Bug confirmed and replicated: rows[start:per_page] for page=2,per_page=20 yields rows[20:20] -> empty, whereas rows[start:start+per_page] correctly returns 20 items (the Worker's diagnosis is accurate; the slice end must be an offset, not a length).`
- La demo anterior (`repociv-demo-2026-10-05.*`) se conserva intacta.

## Propuestas de texto para X (≤ 280 caracteres con hashtags, sin X Premium)

### Opción 1 (Inglés — 278 caracteres brutos / 266 en X)

```text
New RepoCiv update — Civ V-style local dashboard for AI agents, built with Meshy AI + Hermes Agent:

• 2K PBR buildings & units (Meshy)
• RoundTablet multi-agent rounds (Hermes + Claude/Codex)
• 3D Q/E orbit & docked HUD

https://github.com/Grizaceo/repociv
#AIAgents #MeshyAI #OpenSource
```

### Opción 2 (Español — 279 caracteres brutos / 267 en X)

```text
Nuevo update de RepoCiv — dashboard local estilo Civ V para agentes IA con Meshy AI + Hermes Agent:

• Edificios y unidades 2K PBR (Meshy)
• RoundTablet multi-agente (Hermes + Claude/Codex)
• Órbita 3D Q/E y HUD acoplado

https://github.com/Grizaceo/repociv
#AIAgents #MeshyAI #OpenSource
```
