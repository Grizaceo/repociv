# Demo — 2026-10-05

- MP4: `repociv-demo-2026-10-05.mp4` — 40 s, 1280×720, H.264, 30 fps, sin audio, 1.1 MB.
- GIF: `repociv-demo-2026-10-05.gif` — 768×432, 8 fps, 2.8 MB.
- Portada: `repociv-demo-2026-10-05-preview.jpg`.
- Build mostrado: commit `af9da36853983a009d79a2ecbc7ba9aee5a6dabf`, capturado desde `feat/local-view-activity` antes de su integración a main.

La demo es un montaje de capturas reales de Chromium obtenidas con cua-driver, con rótulos y transiciones preparados con Pillow y FFmpeg. No es una grabación continua de las interacciones. Se descartaron las grabaciones de gpu-screen-recorder porque sus fotogramas estaban deformados; la prueba X11 produjo imagen negra. Las capturas nativas sí se verificaron visualmente.

Se usó una copia aislada del código y del workspace de ejemplo, con bridge y Vite en los puertos 5774/5775 y 5773. Las ciudades son Sentinel-Flask, Pipeline-Utils y Taskforge. No se modificó el workspace habitual.

La consulta a Codex fue real, enviada al bridge de la demo como comando de bajo riesgo. Se pidió leer `taskforge.py` y `test_taskforge.py`, explicar el fallo de `test_by_hero_case_insensitive` y sugerir una solución, sin editar archivos. El ledger registró inicio a las 07:01:00 y final a las 07:01:14, hora local. Respuesta:

> The test stores `"aria"` but calls `by_hero("Aria")`.
> It fails because `by_hero` compares names with case-sensitive equality.
> Fix it by comparing `t.hero.casefold()` with `hero.casefold()`, keeping the open-status filter.

Se verificaron los cinco capítulos visualmente y la decodificación completa del MP4 sin errores. La demo anterior se conserva. Durante la captura no se hizo commit, push ni publicación.
