# Fase 1 — Legibilidad del Mapa: Acta de Cierre

Fecha: 2026-05-25
Versión del código: posterior a la Fase 1 del ROADMAP_IMPERIAL_WORKSHOP.md
Estado: **COMPLETADA** — se difiere subfase 2.5D a fase separada.

---

## ✅ Qué se completó

### 1. Taxonomía de capas expandida (7 capas en lugar de 5)

| Capa | ID | Default | Efecto visible |
|------|----|---------|----------------|
| Base | `base` | ON | Terreno, ciudades, agentes — siempre visible |
| Estructura | `structure` | ON | Territorio de ciudades, edificios, sprites de Maravillas |
| Ops | `ops` | OFF | Badges de unidad, trails, indicadores de actividad |
| Conocimiento | `knowledge` | OFF | Ícono 📖 pulsante en ciudades Bibliotheca + líneas punteadas de conexión entre nodos de conocimiento |
| Laboratorios | `labs` | OFF | Ícono 🔬 pulsante en ciudades Institutum + anillo verde en ciudades con experimentos activos |
| Seguridad | `security` | OFF | Ícono 🛡 pulsante + contorno rojo tenue en ciudades protegidas |
| Etiquetas | `labels` | ON | Control de densidad de texto: nombres de ciudades, distritos, carpetas |

- `operational` renombrado → `ops` (naming drift corregido)
- Migración automática desde localStorage: si existía `operational`, se migra a `ops`

### 2. Efectos reales por capa (no placebos)

- **knowledge**: dibuja conexiones entre ciudades con Maravilla Bibliotheca (líneas punteadas azules tenues con animación sinusoidal). Ícono 📖 pulsante.
- **labs**: detecta ciudades con Maravilla Institutum o edificios en estado `building`. Muestra 🔬 pulsante. Si hay experimento activo, anillo verde pulsante.
- **security**: detecta ciudades con Maravillas. Muestra 🛡 pulsante + contorno hex rojo tenue.
- **labels**: todas las etiquetas de texto (ciudad, distrito, skill health) se renderizan solo si esta capa está ON. La capa de etiquetas es independiente de structure.

### 3. LOD refinado (3 escalones perceptibles)

| Zoom | Nivel | Qué se ve |
|------|-------|-----------|
| < 0.5 | Bajo | Solo nombre de capital (si labels ON). Nada más: sin decor, sin badges, sin distritos. |
| 0.5 – 1.2 | Medio | Nombres de ciudades + distritos + skill health. SIN terrain decor, SIN resource icons. |
| ≥ 1.2 | Alto | Textura completa: terrain decor, resource icons, badges, trails (sujeto a clean mode). |

Cada nivel tiene un salto visual claro: bajo = vista general, medio = gestión de ciudades, alto = inspección detallada.

### 4. LOD + Clean Mode en localRenderer.ts

- `LocalRenderer.calcLod()`: low (<0.4 zoom), medium (0.4-1.0), high (>1.0)
- Low LOD: suprime room labels y partículas
- Clean mode: suprime partículas (sparks/zzz)
- `setCleanMode` en LocalRenderer, wireado desde el panel de capas → macro renderer → local renderer

### 5. Fase 0 (baseline) pre-requisitos

- `npm run lint` → 0 errores, 0 warnings (las variables `warmColor`/`vignetteColor` y `fillColor` ya estaban correctas o fixeadas)
- `npm run check` → 401 tests pasados, build exitoso
- `python3 -m py_compile server/*.py` → OK
- `bash scripts/healthcheck.sh` → 6/6 OK
- `bash scripts/smoke-test.sh` → 9/9 OK

---

## ❌ Qué se difiere a subfase 2.5D

Estos items quedan fuera del alcance de Fase 1 y serán abordados en una fase posterior (2.5D liviana):

1. **Sombras direccionales consistentes** — se necesita modificar `renderer.ts` para calcular sombras por tile según neighbor heights. Afecta a FPS.
2. **Elevación aparente en Maravillas** — dibujar sprites con sombra de profundidad y pedestal visual.
3. **Parallax mínimo en labels flotantes** — separar el movimiento de labels del scroll del canvas.
4. **Niebla/atenuación de distancia** — tiles lejanos con opacidad reducida según distancia al centro de cámara.
5. **Transiciones animadas** entre LOD levels — fade-in de labels al hacer zoom.
6. **Highlight de tile bajo cursor con elevación** — el hover actual (hex outline) podría tener efecto de "levantamiento".

Nada de WebGL/Three.js. La subfase 2.5D se hace en Canvas 2D puro.

---

## 📊 Métricas de cierre

| Métrica | Antes | Después | Delta |
|---------|-------|---------|-------|
| Capas definidas | 5 (`operational`) | 7 (`ops`) | +2 |
| Capas con efecto visual real | 2 (structure, ops) | 7 (todas) | +5 |
| LOD escalones perceptibles | 2 (bajo, otro) | 3 (bajo/medio/alto) | +1 |
| localRenderer LOD/clean | 0 | calcLod() + cleanMode | +2 features |
| Bundle size (main) | 972.59 KB | 975.33 KB | +2.7 KB |
| Tests | 401 | 401 | 0 regresiones |
| ESLint | 0 | 0 | sin cambios |

---

## 📝 Nota de antes/después: qué ruido desapareció

**Antes**: el mapa cargaba siempre con TODA la información visual al mismo tiempo — badges, decor, etiquetas, icons, trails. Apagar la capa `operational` solo removía badges y trails; el resto del ruido (knowledge, labs, security, labels) no tenía toggle.

**Después**: 
- **knowledge, labs, security, labels** son capas independientes y funcionales. Sin datos de Bibliotheca/Institutum, estas capas no muestran nada — cero ruido adicional.
- **LOD medio** (zoom normal, ~1.0x): ahora muestra solo nombres + distritos sin terrain decor. El mapa se ve MUCHO más limpio por defecto.
- **Capa labels OFF**: elimina TODO el texto del mapa. Solo queda terreno + hexágonos. Útil para screenshots o vista paisaje.
- **Clean mode + Low LOD**: queda solo el nombre de la capital. Máxima reducción de ruido.

---

*Documento generado por DAVI como parte del cierre formal de Fase 1 del Taller Imperial.*