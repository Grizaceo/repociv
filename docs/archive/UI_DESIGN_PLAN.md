# RepoCiv — Plan de Diseño Gráfico de UI

> **Audiencia:** Diseñador trabajando en Antigravity.  
> **Objetivo:** Rediseñar la UI de RepoCiv para que sea más clara, inmersiva y funcional manteniendo la estética Civ V dark-gold.  
> **No es un handoff de código** — es un plano de diseño. El código viene después.

---

## 1. Estado actual (referencia)

### Layout general (1920×1080)

```
┌─────────────────────────────────────────────────────────────┐
│  TOP BAR — recursos + era + GPU + bridge + screenshot        │
├──────────┬──────────────────────────────────────────────────┤
│ HERO BAR │                                                  │
│ slots    │                                                  │
│ 1-9      │         HEX MAP (canvas full bleed)             │
│ Q W E L O│                                                  │
├──────────┘                                 ┌────────────────┤
│                                            │  SIDE PANEL    │
│                                            │  Chat/Git/Files│
│                                            │  + chat input  │
├──────────────────┐                         │                │
│  UNIT PANEL      │                         └────────────────┤
│  sprite+stats    │   EVENT LOG (centro)    │  MINIMAP       │
│  acciones        │                         │  220×160       │
│  mission input   │                         │                │
└──────────────────┴─────────────────────────┴────────────────┘
```

### Tokens de diseño actuales

| Token | Valor |
|-------|-------|
| Background | `#0a0804` |
| Panel bg | `rgba(22, 16, 6, 0.94)` |
| Border | `#5a3e1e` |
| Gold | `#c8a84b` / `#f0c050` |
| Text | `#e8d5a0` / `#a89060` dim |
| Science | `#5b9bd5` |
| Production | `#d45b5b` |
| Font títulos | Cinzel (serif medieval) |
| Font cuerpo | Georgia |
| Font mono | Courier New |
| HEX_SIZE | 52px circumradius |

---

## 2. Problemas a resolver

### P1 — Hero Bar demasiado vertical
Actualmente ocupa una columna completa izquierda con slots + spawn buttons. Con 9 héroes + 5 botones (Q/W/E/L/O) crece hacia abajo y tapa el mapa. 

### P2 — Unit Panel y Side Panel compiten
Cuando ambos están abiertos el panel izquierdo (260px) y el derecho (380px) dejan ~700px de mapa visible en 1080p. Con el chat input ahora dentro del side panel el flujo mejoró pero la jerarquía visual no es clara.

### P3 — Ciudad sin ficha propia
Click en un tile-ciudad no tiene panel dedicado. Actualmente abre el side panel con Git/Files del agente seleccionado. Cristóbal quiere una **ficha de ciudad estilo Civ V** con datos reales del repo.

### P4 — Agentes sin identidad visual diferenciada
Los 5 agentes (DAVI/WORKER/SCOUT/LEXO/OPENCLAW) usan el mismo sprite circular con colores distintos pero no hay "tipo de unidad" visualmente distinto como en Civ V (héroe, trabajador, explorador, etc).

### P5 — Event Log plano
El log de 6 líneas en el centro inferior no diferencia bien tipos de eventos. No hay jerarquía visual: una misión completada y un ping GPU tienen el mismo peso.

### P6 — Quest Board es una modal genérica
El Quest Board (F9) funciona pero no tiene la energía de un tablón de misiones. Falta contexto visual de "urgencia" y no conecta visualmente con los agentes.

---

## 3. Propuesta de rediseño por componente

---

### 3.1 TOP BAR

**Ancho:** 100% × 48px alto (era 42px).

**Zonas izquierda → derecha:**

```
[⬡ Oro 1,234] [◈ Ciencia 89] [⚙ Prod 45]   |   Era I — RepoCiv   |   [GPU 4.2/8GB 62°] [⚡ hermes] [📷]
```

**Cambios propuestos:**
- Separador visual entre recursos y era (línea vertical sutil `#5a3e1e`)
- Bridge status: en vez de "⚡ offline" en rojo plano → indicador tipo LED con animación de pulso
  - 🟢 verde `#5b9b5b` = hermes online
  - 🟡 amarillo = openclaw online (con pequeño logo O)
  - 🔴 rojo = offline
  - 💫 azul pulsando = DEMO mode
- GPU bar: mostrar como barra mini tipo health bar (no solo texto) cuando hay GPU, hidden cuando no
- Era display: centrado absoluto, fuente Cinzel bold, badge de vuelta (`Era I`)

---

### 3.2 HERO BAR → "COMMAND BAR"

**Nuevo concepto:** Barra horizontal en la parte baja del mapa (encima del unit panel y el event log), no columna lateral. Libera el mapa completamente.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  [D] DAVI idle  [W] WORKER working  [S] SCOUT idle  [L] LEXO sleeping     │
│  ──────────────────────────────────────────────────────────────────────── │
│  Spawn: [Q DAVI] [W WORKER] [E SCOUT] [L LEXO] [O OPENCLAW]               │
└────────────────────────────────────────────────────────────────────────────┘
```

**Detalles de cada slot de héroe:**
- 52×52px card
- Color de fondo degradado radial desde color del agente al oscuro (`${color}22`)
- Letra inicial grande al centro (estilo Civ V unit circle)
- Badge de número `1`–`9` arriba-izquierda (circle dorado pequeño)
- Indicador de estado abajo-derecha:
  - `idle` → punto gris `#888`
  - `working` → punto azul pulsando `#5b9bd5`
  - `moving` → punto ámbar `#c8a84b`
  - `sleeping` → punto oscuro con ZZZ tiny
- Si está seleccionado: borde dorado brillante `#f0c050` con glow sutil `box-shadow: 0 0 8px #f0c05066`
- Nombre en tooltip al hover

**Botones spawn:** Row secundaria debajo de los slots, más pequeños (28×22px). El hotkey key visible adentro.

**Posición:** `bottom: 90px; left: 0; right: 0;` — encima del event log.

---

### 3.3 UNIT PANEL → "HERO CARD"

**Cuando no hay unidad seleccionada:** oculto completamente (no placeholder vacío).

**Cuando hay selección:** aparece bottom-left, rediseñado en dos columnas:

```
┌─────────────────────────────────────────────┐
│ ┌──────┐  DAVI              idle  ●          │
│ │  D   │  hero · mimo técnico                │
│ │      │  "Investigando tamagotchi"           │
│ └──────┘  ▓░░░░ 4/4 mov                     │
│─────────────────────────────────────────────│
│ [Mover M]  [Construir B]  [Dormir S]         │
│─────────────────────────────────────────────│
│ > Escribe misión o pregunta...        Enviar │
└─────────────────────────────────────────────┘
```

**Cambios vs actual:**
- Sprite circular más grande (56px), con borde animado si está working (ring rotando)
- Barra de movimiento como health bar visual (no solo texto)
- Mission input con placeholder contextual: `> Habla con ${unitName}...`
- Hint de hotkey Enter para abrir chat lateral, menos prominente (italic, dim)
- Ancho: 280px (era 260)

**Variantes por tipo de agente:**
| Agente | Color borde sprite | Label modelo |
|--------|-------------------|--------------|
| DAVI | `#c8a84b` dorado | `mimo · técnico` |
| WORKER | `#5b9b5b` verde | `hermes · conciso` |
| SCOUT | `#5b9bd5` azul | `hermes · explorador` |
| LEXO | `#b86ce8` púrpura | `lexo-α · analítico` |
| OPENCLAW | `#7bd6c8` cian | `openclaw · local` |

---

### 3.4 SIDE PANEL — Chat / Git / Files

**Tamaño:** 400px ancho (era 380), full height desde top-bar hasta bottom de command bar.

**Header:** nombre del agente + state badge + botón X. Añadir pequeño ícono de tipo (🗡 hero, ⚒ worker, 🔍 scout, 📚 lexo, 🔌 openclaw).

**Tab Chat:**
- Mensajes con burbujas más diferenciadas:
  - Usuario: borde izquierdo azul `#5b9bd5`, fondo `rgba(91,155,213,0.08)`, alineado derecha
  - Agente: borde izquierdo color del agente, fondo neutro, alineado izquierda
- Meta info (`DAVI · 03:14 · openclaw`) en una línea separada, font mono 9px
- Etiquetas de transport `[transport: hermes]` en estilo badge pill discreto en vez de línea de texto, color según transporte
- Input siempre visible al fondo del tab (ya existe, pulir estilos)
- Operation ticker: cuando working, mostrar animación de escritura punteada (···) + nombre de misión

**Tab Git:** Sin cambios funcionales. Añadir ícono de rama `⎇` ya existe, está bien.

**Tab Files:** Añadir iconos de extensión por tipo de archivo:
- `.ts/.tsx` → `TS` badge azul
- `.py` → `PY` badge amarillo
- `.md` → `MD` badge gris
- otros → extensión raw

---

### 3.5 FICHA DE CIUDAD ★ (NUEVO — prioridad Cristóbal)

**Trigger:** Click en tile que tiene ciudad Y no hay unidad en ese tile, O click derecho en tile-ciudad.

**Posición:** Modal centrada, 600×420px. Estilo Civ V city screen simplificado.

```
┌────────────────────────────────────────────────────────────────┐
│  ★ TAMAGOTCHI                              [repo: tamagotchi]  │
│  Capital · Python ML · 847 archivos         git: main ● clean  │
│──────────────────────────────────────────────────────────────│
│  TERRENO: 🌲 Bosque (70% .py / .ipynb)                        │
│  SESIÓN: 🔆 Bright — actividad últimos 3 días                  │
│  SKILL: ⚡ OK — skill actualizado hace 2 días                  │
│──────────────────────────────────────────────────────────────│
│  RECURSOS                  ÚLTIMAS MISIONES                    │
│  ⬡ Oro       1,234  ▓▓▓▓░   ◉ Analizar dataset   2h ago       │
│  ◈ Ciencia     89   ▓▓░░░   ◉ Fix training loop  1d ago        │
│  ⚙ Producción  45   ▓░░░░   ○ Revisar README     pending       │
│──────────────────────────────────────────────────────────────│
│  GIT                       ARCHIVOS RECIENTES                  │
│  ⎇ main · a3f9b2c           train.py         modified 2h       │
│  3 files changed            config.yaml      modified 1d       │
│  +142 / -23                 requirements.txt clean             │
│──────────────────────────────────────────────────────────────│
│  [Enviar misión a esta ciudad]    [Ver en explorador]   [✕]    │
└────────────────────────────────────────────────────────────────┘
```

**Datos reales que ya existen:**
- nombre repo, terreno, población (file count) → `/api/repos`
- git branch, último commit, cambios → `/api/git/:name`
- archivos → `/api/files/:name`
- skillHealth → `/api/skill-health/:name`
- sessionTint → `/api/session-tint/:name`

**Acción "Enviar misión a esta ciudad":** abre el mission input con el agente seleccionado activo y el `city` pre-rellenado con este repo.

---

### 3.6 EVENT LOG

**Posición actual:** centro inferior, 420px ancho, 80px alto. Mantener posición.

**Rediseño de entradas:**

Actualmente todas las entradas son texto plano igual. Propuesta con iconos y colores diferenciados:

| Tipo | Ícono | Color |
|------|-------|-------|
| Misión iniciada | `▶` | `#c8a84b` gold |
| Misión completa | `✓` | `#5b9b5b` verde |
| Misión fallida | `✗` | `#d45b5b` rojo |
| Building start | `◆` | `#5b9bd5` azul |
| Building complete | `◈` | `#7bd6c8` cian |
| Evento genérico | `·` | `#a89060` dim |
| Alerta | `⚠` | `#d4a44b` naranja |
| Bridge offline | `⚡` | `#d45b5b` pulsando |

**Animación:** cada entrada entra con `slideUp 0.2s`. Las últimas 6 son visibles; al overflow la más antigua sale con `fadeOut`.

---

### 3.7 QUEST BOARD (F9)

**Rediseño conceptual: tablón de pergamino**

```
╔══════════════════════════════════════════════════════════════╗
║    ★  QUEST BOARD — Imperio de Cristóbal  ★                 ║
╠══════════════════════════════════════════════════════════════╣
║  [ Todas ]  [ En curso · 2 ]  [ Completas · 8 ]  [ Fallidas ]║
╠══════════════════════════════════════════════════════════════╣
║  ●  Analizar dataset SAIR                    DAVI · 2h · ... ║
║  ●  Fix training loop proteína               WORKER · 45m    ║
║  ─────────────────────────────────────────────────────────── ║
║  ✓  Revisar README tamagotchi                SCOUT · 1d      ║
║  ✓  Setup bridge.py endpoints                DAVI · 2d       ║
╚══════════════════════════════════════════════════════════════╝
```

**Mejoras:**
- Header con título de "Imperio" (nombre del user)
- Tabs con contadores en badge
- Filas de misión en curso con barra de progreso thin debajo del nombre
- Color de fila según agente (subtle tint)
- Click en misión → expand para ver transcript resumido
- Botón `+ Nueva misión` abajo que abre el mission input

---

### 3.8 MINIMAP

**Posición:** bottom-right, sin cambios.

**Mejoras:**
- Borde con label "MAPA" en Cinzel 8px arriba del canvas
- Ciudades: punto dorado con anillo si tiene actividad reciente (sessionTint=bright)
- Unidades: puntos del color del agente, con trail de movimiento (últimas 3 posiciones en opacidad decreciente)
- Viewport box: ya existe, hacerlo un poco más visible (`#c8a84b` al 60% en vez de 53%)
- Hover sobre minimap: tooltip con nombre de la ciudad más cercana al cursor

---

## 4. Flujos de interacción clave

### Flujo A: Enviar misión a un agente

```
1. Presionar Q (spawn DAVI o seleccionar si idle)
   → Hero Card aparece bottom-left con DAVI seleccionado
   → Slot 1 en Command Bar se ilumina con borde dorado

2. Escribir en mission input del Hero Card (o en chat tab del Side Panel)
   → Enter o click Enviar

3. Event Log muestra: ▶ "Misión nombre"
   → Slot de DAVI en Command Bar: dot working (azul pulsando)
   → Side Panel (si abierto): ticker ··· + nombre misión
   → Hero Card: ring animado alrededor del sprite

4. Al completar:
   → Event Log: ✓ "Misión nombre"
   → Dot vuelve a idle
   → Sonido de fanfarria
```

### Flujo B: Inspeccionar una ciudad

```
1. Click en tile con ciudad (sin unidad encima)
   → Ficha de Ciudad aparece centrada

2. Ficha carga en paralelo: git status + archivos + skill health

3. Click "Enviar misión a esta ciudad"
   → Cierra ficha
   → Foco en mission input del Hero Card
   → City pre-seleccionada internamente
```

### Flujo C: Multi-spawn agentes paralelos

```
1. Q → spawn DAVI (seleccionado, slot 1)
2. Q → spawn DAVI-2 (slot 2 creado)
3. W → spawn WORKER (slot 3)

   Command Bar: [D]DAVI  [D]DAVI-2  [W]WORKER
   
4. Click slot DAVI → Hero Card muestra DAVI
5. Click slot DAVI-2 → Hero Card cambia a DAVI-2 (contexto diferente)
6. Cada uno mantiene su chat buffer independiente en Side Panel
```

---

## 5. Paleta completa propuesta

```
BACKGROUNDS
  app-bg:        #0a0804   (negro marrón)
  panel-bg:      rgba(22, 16, 6, 0.95)
  panel-border:  #5a3e1e   (marrón dorado)
  panel-hover:   rgba(90, 62, 30, 0.4)

GOLDS
  gold-dim:      #8a6a3e
  gold-mid:      #c8a84b   ← principal
  gold-bright:   #f0c050
  gold-glow:     rgba(240, 192, 80, 0.35)

TEXT
  text-primary:  #e8d5a0
  text-dim:      #a89060
  text-faint:    #6a5040

AGENTES
  davi:          #c8a84b   (gold, hero)
  worker:        #5b9b5b   (verde, trabajador)
  scout:         #5b9bd5   (azul, explorador)
  lexo:          #b86ce8   (púrpura, analítico)
  openclaw:      #7bd6c8   (cian, local)

TERRENOS (para referencia UI)
  plains:        #7ba05b
  forest:        #2d5a27
  mountain:      #6b6b6b
  desert:        #d4a574
  ocean:         #2b6da5
  ice:           #e0e0e0

ESTADOS
  success:       #5b9b5b
  warn:          #d4a44b
  error:         #d45b5b
  working-blue:  #5b9bd5
  info:          #a89060

TRANSPORTS (badges en chat)
  hermes:        #5b9bd5   azul
  openclaw:      #7bd6c8   cian
  demo:          #c8a84b   gold pulsando
  offline:       #d45b5b   rojo
```

---

## 6. Tipografía

| Uso | Font | Peso | Tamaño |
|-----|------|------|--------|
| Títulos paneles | Cinzel | 700 | 14–18px |
| Labels HUD | Cinzel | 400 | 10–13px |
| Cuerpo / misiones | Georgia | 400 | 11–13px |
| Chat / código | Courier New | 400 | 11–12px |
| Números recursos | Cinzel | 600 | 13px |
| Badges / hotkeys | Courier New | 700 | 9–11px |

---

## 7. Animaciones clave

| Elemento | Animación | Duración | Easing |
|----------|-----------|----------|--------|
| Panel open | slide-in desde borde + fade | 250ms | ease-out |
| Panel close | slide-out + fade | 200ms | ease-in |
| Working dot | pulse opacity 1↔0.3 | 1.5s | infinite |
| Selection halo | pulse scale 1↔1.05 | 2s | infinite |
| Log entry | slideUp 8px + fade-in | 300ms | ease |
| Hero Card spawn | scale 0.85→1 + fade | 200ms | spring |
| City modal | scale 0.9→1 + fade | 250ms | ease-out |
| Building ring | rotate 360° | 2s | linear infinite |
| Transport badge | fade-in | 150ms | ease |

---

## 8. Prioridad de implementación

**Sprint de diseño sugerido:**

1. `Command Bar` (barra horizontal agentes) — libera el mapa, cambio más visible
2. `Hero Card` mejorada — mejora interacción diaria
3. `Event Log` con iconos y colores — bajo costo, alto impacto visual
4. `Ficha de Ciudad` — feature nuevo que Cristóbal pidió, el más complejo
5. `Side Panel` mejoras (bubbles, badges transport) — polish
6. `Quest Board` rediseño visual — cosmético
7. `Minimap` mejoras — polish final

---

## 9. Notas para el diseñador

- **El canvas del mapa** (hex grid) es 100% full bleed. Todos los paneles son overlays absolutos sobre él. Los paneles tienen `background: rgba(22, 16, 6, 0.94)` — nunca opacos, siempre semi-transparentes para sentir el mapa debajo.
- **Font Cinzel** requiere Google Fonts import — ya existe en el CSS. En Antigravity/mockup herramienta, usar Georgia bold como sustituto visual.
- **El HEX_SIZE es 52px** — en maqueta a 1:1 scale los hexes miden aprox 90px de punta a punta (52 × √3 ≈ 90px alto).
- La cámara del mapa tiene zoom 0.15× a 4×. En pantallas chicas (<1366px) el side panel pasa a full-width.
- Los **colores de agente** son los únicos que varían. Todo lo demás es dorado o dim — la paleta Civ V es intencionalmente austera.
- No hay imágenes ni ilustraciones — todo es geometry + typography + Canvas 2D. Mantener esa restricción.
