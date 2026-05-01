# Civilization V — UI Analysis para Repociv

> Estudio de la interfaz de usuario de Civ V para inspirado-by.
> Solo con propósito de análisis técnico. No se redistribuye código ni assets.

---

## 1. Top Panel (Barra Superior)

La barra superior de recursos es el elemento más reconocible de Civ V.
Se extiende en toda la amplitud de la pantalla con una textura de fondo
(`TopPanelBar.dds`).

### 1.1 Recursos — Colores exactos

| Recurso    | Icon Color (RGB 0-255)   | Hex       | Background Color     | Hex        |
|------------|--------------------------|-----------|----------------------|------------|
| Science    | (  0, 100, 255)          | `#0064FF` | (  0,  50, 130)      | `#003282`  |
| Culture    | (255,   0, 255)          | `#FF00FF` | (200,   0, 200)      | `#C800C8`  |
| Gold       | (255, 215,   0)          | `#FFD700` | (200, 160,   0)      | `#C8A000`  |
| Production | (255, 125,   0)          | `#FF7D00` | (200,  90,   0)      | `#C85A00`  |
| Food       | (  0, 255,   0)          | `#00FF00` | (  0, 180,   0)      | `#00B400`  |
| Happiness  | (255, 255,   0)          | `#FFFF00` | (200, 200,   0)      | `#C8C800`  |
| Faith      | (255, 255, 200)          | `#FFFFC8` | (white base)         | —          |
| Movement   | (  0, 175, 255)          | `#00AFFF` | (  0, 140, 200)      | `#008CC8`  |
| Defense    | (255,   0,   0)          | `#FF0000` | (200,   0,   0)      | `#C80000`  |

**Fuente:** Reddit `/r/civ` — Google Spreadsheet de `auandi` (2015).
Colores en formato RGBA 0-1 en XML original; convertidos a 0-255.
Los valores icon/background corresponden al mismo color en diferente
luminosidad (el juego renderiza gradientes).

### 1.2 Barra de progreso vertical

Cada recurso en el top panel tiene una barra vertical de 6px de ancho × 30px
de alto:

```
Size="6,30"
FGColor="Science,255"    ← color sólido
Direction="Up"            ← crece hacia arriba
Shadow: FGColor="Science,128"  ← 50% opacity para profundidad
```

La barra tiene un biselado simulado con dos líneas verticales:
- Izquierda: `Color="0,0,0,64"` (negro 25% opacity) — sombra izquierda
- Derecha: `Color="255,255,0,64"` (amarillo 25% opacity) — highlight derecho

**Patrón de bisel clásico:** shadow-color izquierda, highlight-color derecha.

### 1.3 Tipografía del Top Panel

```xml
Font="TwCenMT16"        ← Tw Cen MT, 16pt
FontStyle="Base"        ← estilo base
Color="Beige"           ← color por defecto
```

Para labels de turno (Turns restantes):
```xml
Font="TwCenMT14"
FontStyle="Shadow"      ← sombra sobre el texto
ForceNonIME="1"        ← sin输入法, texto latino puro
```

Para el botón de menú (derecha):
```xml
Font="TwCenMT20"       ← más grande para legibilidad
NormalState="Beige_Black"
MouseOver="White_Black"
ButtonDown="Beige_Black_Alpha"
```

**`TwCenMT`** = Tw Cen MT (Twentieth Century). Es una typeface de la familia
Century, muy usada en Juegos 4X por su legibilidad en UI pequeñas.
**Alternativa libre para repociv:** `Noto Sans`, `Roboto Condensed`, o
`Barlow Condensed`.

### 1.4 Tooltip del Top Panel

```xml
Size="555,12"           ← ancho fijo, alto mínimo
Padding="8,8"
Style="GridBlack8"       ← grid 8px de radio de esquina
Color="White,240"        ← fondo blanco semi-transparente (94% opacity)
WrapWidth="555"          ← wrap de texto
```

El tooltip usa un grid con bordes redondeados (`GridBlack8`).

---

## 2. Grid / Panel Background

### 2.1 Grid Styles (Highlights.xml)

```xml
<!-- Hexágono culture en mapa -->
<style name="Culture" type="HexContour" width=".2"
       texture="hex_contour2.dds" />

<!-- Tileworked -->
<style name="WorkedFill"    type="FilledHex"   color="0,255,0,50"   />  <!-- verde 20% -->
<style name="WorkedOutline" type="SplineBorder" width="7" texture="hex_contour1.dds"
       color="0,255,0,164" />  <!-- verde 64% opacity -->

<!-- Tilepropio -->
<style name="OwnedFill"     type="FilledHex"   color="255,140,0,64"  />  <!-- naranja 25% -->
<style name="OwnedOutline"  type="SplineBorder" width="7" texture="hex_contour1.dds"
       color="255,140,0,200" />  <!-- naranja 78% opacity -->

<!-- Pillar units -->
<style name="PillageFill"   type="FilledHex"   color="255,25,25,64"  />  <!-- rojo 25% -->
<style name="PillageOutline" type="SplineBorder" width="7"
       color="255,0,0,200" />

<!-- Comprazonciudad -->
<style name="CityOverlap"   type="FilledHex"   color="255,140,0,64"  />
```

**Nota importante:** Los colores de tiles usan alpha bajo (64/255 = 25%)
para que el mapa se vea a través de ellos.

---

## 3. Hex Grid (Sistema de Coordenadas)

El sistema hexagonal de Civ V es **flat-top hex** (hexágonos achatados
arriba-abajo). Cada hex tiene un ID y coordenadas basadas en `q,r` axial.

### 3.1 Estilos de borde de hex

```xml
<!-- Borde estándar de hex seleccionado -->
<style name="" type="HexContour" width=".2" texture="hex_contour2.dds"/>

<!-- Borde naranja de ciudad (apropiación de tile) -->
<style name="CityOverlap" type="FilledHex" width="1" color="255,140,0,64"/>

<!-- Borde de tile trabajado (verde) -->
<style name="WorkedOutline" type="SplineBorder" width="7"
       texture="hex_contour1.dds" color="0,255,0,164"/>
```

El `width="7"` en SplineBorder es el grosor del spline en pixels del juego.

### 3.2 Contorno de selection/hover

```xml
<!-- Borde grupal (naranja, usado para selección múltiple) -->
<style name="GroupBorder" type="SplineBorder" width="6"
       texture="spline_border_contour2.dds" color="255,128,0,200"/>

<!-- Borde de rango de movimiento (azul claro) -->
<style name="MovementRangeBorder" type="SplineBorder" width="6"
       texture="spline_border_contour2.dds" color="100,185,245,200"/>

<!-- Borde de rango de fuego (rojo) -->
<style name="FireRangeBorder" type="SplineBorder" width="6"
       texture="spline_border_contour2.dds" color="255,0,0,200"/>
```

---

## 4. City Banner (Banner de Ciudad)

Ubicado encima de cada ciudad en el mapa. Extraido de `citybanners/`.

El banner de ciudad muestra:
- Nombre de la ciudad
- Población (pop)
- Producción actual
- Indicadores de crecimiento comida
- Sellos de edificios/wonders

**Estructura típica:**
```
[CityBanner]
  [Background: textura con color de fondo según población]
  [CityName: Label con Font/Typography del sistema]
  [Population: número grande]
  [ProductionIcon + texto]
  [GrowthIndicator: barra o icono]
```

---

## 5. Unit Panel (Panel de Unidad)

Panel derecho que aparece cuando se selecciona una unidad.

### 5.1 Atributos de unidad

```
Strength (fuerza):        número entero, sin color especial
Movement (movimiento):     icono + puntos restantes (e.g., 2/3)
Experience:                barra de XP + nivel
Health:                    barra verde/amarilla/roja
```

### 5.2 Barras de estado

Las barras de estado (salud, experiencia, etc.) usan el mismo patrón
que las barras de recursos del top panel:

```xml
<Bar Anchor="C,B" Offset="0,0" Size="4,30"
     FGColor="Health,255" Direction="Up"/>
```

---

## 6. Tipografía Completa

### 6.1 Font stack de Civ V

| Uso              | Font          | Size | Style      |
|------------------|---------------|------|------------|
| Top panel labels | TwCenMT      | 16pt | Base       |
| Turn counters    | TwCenMT      | 14pt | Shadow     |
| Menu buttons     | TwCenMT      | 20pt | Shadow     |
| Tooltips         | — (heredado) | —    | —          |
| City name        | TwCenMT      | 16pt | Base       |
| Unit stats       | TwCenMT      | 14pt | Base       |

### 6.2 Estilos de texto (FontStyle)

- `Base`: texto plano sin efectos
- `Shadow`: sombra negra 1px abajo-derecha
- `Stroke`: borde de 1px negro alrededor (para texto sobre imágenes)
- `SoftShadow`: sombra difusa

El `Stroke` es crítico para repociv: permite que las etiquetas se lean
sobre cualquier fondo (mapa, barras de recursos, etc.)

### 6.3 Alternativas libres recomendadas

| Civ V (proprietary) | Alternativa libre        | Notas                    |
|---------------------|--------------------------|--------------------------|
| TwCenMT             | Barlow Condensed, Noto Sans Condensed | Muy similar en proporción |
| (heredado)          | Liberation Sans Narrow   | Buena legibilidad en UI  |

---

## 7. Sistema de Color - Análisis Técnico

### 7.1 Estructura de ColorSets

Los colores como `Science`, `Culture`, `Gold` no son valores hex hardcodeados.
Son referencias a un `ColorSet` que define valores RGBA (0-1):

```xml
<!-- En Civ5Colors.xml (Assets\Gameplay\XML\Interface) -->
<!-- SCIENCE -->
<Color>
  <Type>COLOR_SCIENCE</Type>
  <Red>0</Red>
  <Green>0.392</Green>    <!-- 100/255 -->
  <Blue>1</Blue>
  <Alpha>1</Alpha>
</Color>
```

### 7.2 Paleta funcional de repociv

Para repociv, definimos la siguiente paleta basada en los valores de Civ V:

```css
:root {
  /* Resources */
  --civ-science:     #0064FF;
  --civ-culture:     #FF00FF;
  --civ-gold:        #FFD700;
  --civ-production:  #FF7D00;
  --civ-food:        #00FF00;
  --civ-happiness:   #FFFF00;
  --civ-faith:       #FFFFC8;
  --civ-movement:    #00AFFF;
  --civ-defense:     #FF0000;

  /* Map overlays */
  --civ-worked-tile:    rgba(0, 255, 0, 0.20);
  --civ-worked-border:  rgba(0, 255, 0, 0.64);
  --civ-owned-tile:     rgba(255, 140, 0, 0.25);
  --civ-owned-border:    rgba(255, 140, 0, 0.78);
  --civ-city-overlap:   rgba(255, 140, 0, 0.25);
  --civ-pillage:        rgba(255, 25, 25, 0.25);
  --civ-enemy:          rgba(255, 0, 0, 0.25);

  /* UI Chrome */
  --civ-panel-bg:        rgba(0, 0, 0, 0.75);
  --civ-panel-border:    rgba(0, 0, 0, 0.64);
  --civ-text-primary:    #F5F5DC;   /* Beige */
  --civ-text-shadow:     rgba(0, 0, 0, 0.5);
  --civ-highlight:       rgba(255, 255, 0, 0.25);
}
```

---

## 8. Spacing y Dimensiones

### 8.1 Dimensiones de UI clave

| Elemento              | Tamaño          | Notas                        |
|-----------------------|-----------------|------------------------------|
| Top panel height      | 32px            | Fixed, anchored top          |
| Top panel bar segment | 512×32 px       | Textura repetible horizontal |
| Resource bar (bar)    | 4×30 px         | Narrow vertical bar          |
| Resource container    | 6×30 px         | Incluye borde visual         |
| Tooltip width         | 555px           | Max width, wraps text        |
| Tooltip padding       | 8px             | Cuadrado                     |
| Icon size (default)   | 45.45×45.45 px  | Almost square                |
| Icon size (small)     | 20×20 px        | Indicadores de warning       |
| Grid corner radius    | 8px             | GridBlack8 style             |
| Hex contour width     | 0.2–0.3 game units | Borde de selección       |
| Spline border width   | 6–7 px          | Borde de tiles              |

### 8.2 Offset y anchors típicos

```xml
<!-- Stack de resources: crece a la derecha -->
<Stack Anchor="L,T" Padding="0" Offset="4,6" StackGrowth="Right">

<!-- Space entre resources -->
<Container Size="10,1" />     ← 10px horizontal, 1px vertical (gap)

<!-- Science label: alineado izquierda -->
<TextButton ID="SciencePerTurn" Anchor="L,T" Offset="0,0" .../>
```

---

## 9. Fuentes de Datos y Referencias

| Fuente                              | URL                                        | Contenido                       |
|-------------------------------------|--------------------------------------------|---------------------------------|
| Reddit color thread                 | `/r/civ/comments/2uus4d/`                   | Tabla completa RGBA (0-1)       |
| Google Spreadsheet (backup)         | docs.google.com/spreadsheets/...            | Mismos valores, formato legible |
| EUI GitHub repo (Enhanced UI)       | github.com/vans163/ui_bc1                  | XML de UI del mod EUI          |
| CivFanatics ColorType reference     | modiki.civfanatics.com                     | API de ColorType en Lua        |
| Well-of-Souls Civ analyst           | well-of-souls.com/civ/                     | Screenshots + game data         |
| Official manual (2K Games PDF)      | downloads.2kgames.com/...Civ_V_Manual...   | Secciones 1-4 (Interface p.20) |

---

## 10. Implementación Sugerida para Repociv

### 10.1 Componente ResourceBar

```typescript
interface ResourceBar {
  resource: 'science' | 'culture' | 'gold' | 'production' | 'food' | 'happiness';
  current: number;
  yieldPerTurn: number;
  icon: string;        // SVG path o nombre de icono
  color: string;       // hex del ColorSet
  barHeight: number;   // px, típicamente 30
  barWidth: number;    // px, típicamente 4
}
```

### 10.2 Componente TopPanel

- Stack horizontal con `StackGrowth="Right"`
- Cada item: `ResourceBar` + `Label` con `FontStyle="Shadow"`
- Contenedores de `Size="10,1"` entre items
- Anchored top-left para el stack de resources
- Anchored top-right para los controles (menu, help, turn counter)

### 10.3 Approximación de TwCenMT

Si usas CSS only, esta combinación se acerca:

```css
font-family: 'Barlow Condensed', 'Noto Sans Condensed', sans-serif;
font-weight: 500;  /* Medium */
letter-spacing: 0.02em;
```

Para los labels numéricos, usa monospace alignment con `tabular-nums`:

```css
font-variant-numeric: tabular-nums;
```

---

*Documento generado: 2026-04-28*
*Fuentes: EUI XML source (vans163/ui_bc1), Reddit `/r/civ` color spreadsheet, 2K Games official manual*
