# RepoCiv — Recomendaciones de Auditoría End-to-End

Este documento detalla las recomendaciones accionables derivadas de la auditoría end-to-end (Nota global: 7.5/10). Para ver el desglose completo del análisis, revisa el artefacto generado.

## 1. 🔴 Prioridad Crítica

### 1.1 Desacoplar \ridge.pyEl archivo \server/bridge.py\ ha crecido hasta convertirse en un God Object de 2220 líneas.
**Acción:** 
- Extraer el parseo del tracker a \server/pending_tracker.py\.
- Extraer el registro de proveedores/harness a \server/provider_registry.py\.
- Extraer la lógica del servidor SSE a \server/sse_server.py\.
- Dejar \ridge.py\ exclusivamente como enrutador HTTP y controlador principal.

### 1.2 Limpiar la acumulación de \__pycache__Existen compilados de 3 versiones diferentes de Python (3.11, 3.12, 3.13) en \server/__pycache__/\.
**Acción:** 
- Ejecutar \ind . -type d -name __pycache__ -exec rm -r {} +\ para limpiar el espacio.

## 2. 🟡 Prioridad Alta

### 2.1 Eliminar dependencias de CDN en \index.htmlActualmente se cargan \lucide\, \popper\, \	ippy\ y \uto-animate\ vía unpkg.com, lo que rompe el modo offline y expone el proyecto a problemas de supply-chain.
**Acción:**
- Añadir estas dependencias a \package.json\ e importarlas en \main.ts\.

### 2.2 Refactorizar \main.tsLa función \wireHUD()\ tiene más de 300 líneas gestionando eventos y atajos de teclado.
**Acción:**
- Mover la lógica de atajos de teclado a un nuevo archivo \src/keybindings.ts\.
- Mover el setup del HUD a \src/hudWiring.ts\.

### 2.3 Solucionar errores silenciosos
- **Doble asignación de F6:** F6 está asignado a \	oggleHarnessPanel\ (línea 383) y a \	oggleLedger\ (línea 563).
- **Referencia indefinida:** \efreshCityList()\ es llamada en la línea 161 pero no está definida en ningún lugar del archivo.

### 2.4 Consolidar el registro de proveedores (Provider Registry)
El esquema de \harness/provider/model\ está hardcodeado en Python (líneas 1008-1104 de \ridge.py\) y duplicado en \shared/harness-registry.json\.
**Acción:**
- Hacer que el backend de Python lea \shared/harness-registry.json\ como fuente única de verdad.

## 3. 🔵 Sugerencias de Arquitectura y UX

- **Poda de UI:** Como lo establece \SCOPE.md\, los 21+ paneles actuales son demasiados. Usar telemetría local para identificar y eliminar los que no se usan tras 4 semanas (Replay, Observability, etc.).
- **Optimización de A*:** En mapas pequeños el \open.sort()\ por iteración funciona, pero si el tamaño del mapa crece, cambiar la implementación de \pathfinding.ts\ para usar un Min-Heap (Priority Queue) estándar en lugar de arrays.
- **Rutas y Entornos:** Evitar mantener un directorio literal \~/\ en el workspace. Asegurar que \REPOCIV_TOKEN\ no tenga fallback a vacío por defecto sin mostrar una advertencia explícita en consola.
