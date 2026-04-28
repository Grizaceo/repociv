# RepoCiv — Plan de Diseño Gráfico "Civilization V-like"

> Documento para agente de diseño / implementación estética.
> No implementar lógica de negocio nueva — solo apariencia, animaciones y UX visual.
> Archivos principales a editar: `src/styles/`, `src/hexRenderer.ts`, `src/unitRenderer.ts`, `index.html`.

---

## 1. Referencia visual: ¿qué hace que Civ V se vea como Civ V?

| Elemento         | Civ V                                              | RepoCiv actual                          |
|------------------|----------------------------------------------------|-----------------------------------------|
| Tiles            | Degradados ricos, sombra interior, bordes suaves   | Relleno plano con color sólido          |
| Ciudades         | Banner flotante con nombre + pop + producción      | Label con rect oscuro simple            |
| Unidades         | Token circular con emblema, sombra larga           | Círculo con iniciales                   |
| Territorio       | Borde orgánico que rodea el área (sin repetir)     | Contorno por tile individual            |
| Fog of war       | Gradiente oscuro hacia las orillas del mapa        | Overlay azulado uniforme                |
| HUD chrome       | Marco ornamental dorado, textura parchment         | Rect sin decoración                     |
| Notificaciones   | Banner pop que aparece en top-center               | Log de texto abajo                      |
| Minimap          | Mapa real con colores vivos y marco ornamental     | Rectangulitos de 1px sin marco          |
| Recursos en tile | Icono flotante sobre el hex                        | Nada                                    |
| Selección        | Anillo animado con glow dorado                     | Arco estático                           |

---

## 2. Paleta de colores objetivo

```
Fondo de mapa:       #0a0804  (negro pizarra — ya correcto)
Parchment claro:     #e8d5a0
Parchment medio:     #c8a84b  (oro — ya correcto)
Parchment oscuro:    #5a3e1e
Panel bg:            rgba(15, 10, 4, 0.92)
Sombra hex:          rgba(0,0,0,0.55)
Glow selección:      #f0d060 con blur 8px
Borde HUD:           #6b4f2a → #c8a84b (gradiente)
Fog edge:            rgba(10,8,4,0.88)
```

Terrenos — reemplazar los colores planos actuales por degradados cálidos/fríos:
```
plains:   #b8a060 → #8a7040 (trigo dorado)
forest:   #2d5a27 → #1a3d15 (verde oscuro)
mountain: #706050 → #4a3a2a (roca con nieve: blanco en pico)
desert:   #c8b060 → #a09040 (arena cálida)
ocean:    #1a4a6a → #0d2a4a (azul profundo)
ice:      #c0d0e0 → #8090a0 (glacial)
```

---

## 3. Mejoras por componente (con instrucciones precisas)

### 3.1 Tiles hex — `src/hexRenderer.ts :: drawTile()`

**Objetivo:** cada hex tiene profundidad visual, no es plano.

**Pasos:**
1. En `fillHex()`, aplicar radial gradient desde el centro (20% más claro) hacia los bordes (color base). Ya existe la lógica en `drawTile()` pero solo se usa si `colors.gradient` existe — extender para todos los terrenos.
2. Añadir "sombra interior": después de rellenar el hex, dibujar 6 arcos delgados (1.5px) en los bordes internos con color semi-transparente más oscuro (`rgba(0,0,0,0.35)`).
3. Cambiar `size * 0.92` → `size * 0.96` para reducir el gap visible entre hexes.

**TERRAIN_COLOR updates** (en `src/map.ts`):
```typescript
plains:   { fill: '#8a7040', gradient: ['#c8b060', '#7a6030'] }
forest:   { fill: '#2d5a27', gradient: ['#3d7a35', '#1a3d15'] }
mountain: { fill: '#5a4a3a', gradient: ['#706050', '#3a2a1a'] }
desert:   { fill: '#a09040', gradient: ['#c8b060', '#807030'] }
ocean:    { fill: '#1a4a6a', gradient: ['#2a6090', '#0d2a4a'] }
ice:      { fill: '#90a0b0', gradient: ['#c0d0e0', '#607080'] }
```

### 3.2 Decoraciones de terreno — `src/hexRenderer.ts :: drawTerrainDecor()`

**Objetivo:** iconos más ricos, que ocupen más del tile.

**Forest:** en lugar de triángulos planos, 3 círculos apilados simulando árboles con sombra:
```typescript
// círculo oscuro base (sombra)
ctx.fillStyle = 'rgba(0,0,0,0.3)';
ctx.beginPath(); ctx.ellipse(tx, ty + HEX_SIZE*0.15, HEX_SIZE*0.12, HEX_SIZE*0.04, 0,0,Math.PI*2); ctx.fill();
// copa del árbol
ctx.fillStyle = '#2a5a20'; // ... repite 3 veces con offset X
```

**Mountain:** mantener la forma actual (triángulo + nieve) pero añadir una segunda montaña más pequeña detrás (más gris, opacity 0.6) para dar profundidad.

**Ocean:** las 2 curvas de olas actuales — aumentar de 2 a 3, animarlas suavemente con `sin(animTime + offsetX)` pasando `animTime` como parámetro.

**Desert:** añadir 3 puntos pequeños (dunas) con `fillRect` redondeado.

**Ice:** mantener ❄ pero añadir segundo ❄ pequeño y rotado 45°, ligeramente offset.

### 3.3 City banner — `src/hexRenderer.ts :: drawCityLabel()`

**Objetivo:** ciudad visible como en Civ V — banner persistente con nombre + pop + barra de producción.

**Diseño actual:** rect oscuro con texto centrado debajo del hex.

**Diseño nuevo:**
```
┌─────────────────────────┐
│ ★  TENANCINGO LAB  [12] │  ← nombre + población (files count)
│ ████░░░░░░░░░░░░░░  45% │  ← barra de proyecto actual (si hay)
└─────────────────────────┘
```

**Implementación en `drawCityLabel(city, pos)`:**
1. Banner ancho: `bw = Math.max(120, metrics.width + 20)`, alto fijo `bh = city.currentProject ? 36 : 22`.
2. Fondo: `rgba(10,6,2,0.88)` con borde dorado de 1px.
3. Esquinas redondeadas: usar `ctx.roundRect(bx, by, bw, bh, 3)` (necesita polyfill para canvas — usar path manual con arc en esquinas).
4. Fila 1: ★ (si capital, #f0c050) + nombre en Cinzel bold 12px + `[${city.population}]` en monospace 10px dim.
5. Fila 2 (solo si `city.currentProject`): barra de progreso 80% ancho, 4px alto, color verde (#5b9b5b) o dorado (wonder).
6. Posición: `pos.y + HEX_SIZE * 0.6` (más abajo que ahora para no tapar el hex).

### 3.4 Unidades (tokens) — `src/unitRenderer.ts :: drawUnit()`

**Objetivo:** token estilo Civ V — base hexagonal, emblema, sombra larga.

**Cambios:**
1. **Sombra larga**: en lugar de elipse debajo, dibujar una sombra desplazada en diagonal:
   ```typescript
   ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = '#000';
   ctx.beginPath(); ctx.ellipse(HEX_SIZE*0.2, HEX_SIZE*0.4, HEX_SIZE*0.28, HEX_SIZE*0.07, 0.3, 0, Math.PI*2);
   ctx.fill(); ctx.restore();
   ```
2. **Token base**: forma hexagonal (6 lados) en lugar de círculo, relleno con color del agente + rim dorado.
   ```typescript
   // hex de 6 lados: radio HEX_SIZE*0.35
   for (let i=0; i<6; i++) { ... }
   ctx.fillStyle = unit.color + '33'; // tint semitransparente
   ctx.fill();
   ctx.strokeStyle = unit.color; ctx.lineWidth = 2.5; ctx.stroke();
   ```
3. **Iniciales**: mantener pero usar font más grande y con `ctx.shadowColor = unit.color; ctx.shadowBlur = 6` para glow.
4. **Anillo de selección**: en lugar de `arc` estático, animar con `animTime`:
   ```typescript
   // dos arcos que rotan en sentidos contrarios
   ctx.strokeStyle = '#f0d060'; ctx.lineWidth = 2;
   ctx.beginPath(); ctx.arc(0,0, HEX_SIZE*0.48, animTime*0.8, animTime*0.8 + Math.PI*1.5); ctx.stroke();
   ctx.beginPath(); ctx.arc(0,0, HEX_SIZE*0.52, -animTime*0.6, -animTime*0.6 + Math.PI); ctx.stroke();
   ```
5. **Estado "working"**: barra circular animada → cambiar a puntos pulsantes en los extremos del token (3 puntos que aparecen/desaparecen en secuencia).

### 3.5 Territorio de ciudades — `src/hexRenderer.ts :: drawCityTerritory()`

**Objetivo:** borde orgánico tipo Civ V, no contorno por tile.

**Problema actual:** dibuja el contorno completo de CADA hex en el territorio → se ve como una cuadrícula.

**Solución:** solo dibujar los bordes de los hexes que colindan con hexes FUERA del territorio. Para cada hex del territorio, para cada uno de sus 6 lados, verificar si el hex vecino en esa dirección NO está en el territorio — si no está, dibujar ese lado.

**Vecinos en hex axial para cada lado (flat-top):**
```typescript
const HEX_NEIGHBORS = [
  {dq:+1,dr: 0}, {dq:+1,dr:-1}, {dq: 0,dr:-1},
  {dq:-1,dr: 0}, {dq:-1,dr:+1}, {dq: 0,dr:+1},
];
```

Para cada tile en `city.territory`:
- Calcular los 6 vecinos
- Si un vecino NO está en el territorio (usar un Set<string> para O(1)), dibujar el segmento correspondiente

Resultado: border continuo que rodea el territorio sin líneas internas.

**Estilo del borde:**
- Capital: 3px, color `#c8a84b` con `shadowBlur=4, shadowColor='#f0d060'`
- Ciudad normal: 2px, color `#8a6030`, `setLineDash([])` (línea sólida, no discontinua)

### 3.6 HUD chrome — `src/styles/panels.css` + `src/styles/hud.css`

**Objetivo:** marcos ornamentales tipo medieval para todos los paneles.

**Técnica principal: CSS border + pseudo-elementos**

Para `#unit-panel`, `#side-panel`, `#quest-board`, `#city-panel`:
```css
.panel-civ {
  border: 2px solid transparent;
  background:
    linear-gradient(var(--ui-panel-bg), var(--ui-panel-bg)) padding-box,
    linear-gradient(135deg, #c8a84b, #5a3e1e 40%, #c8a84b) border-box;
  box-shadow:
    0 0 0 1px rgba(200,168,75,0.15),
    0 8px 32px rgba(0,0,0,0.85),
    inset 0 1px 0 rgba(200,168,75,0.1);
}
```

**Top bar (`#top-bar`):** añadir un borde inferior ornamental:
```css
#top-bar::after {
  content: '';
  position: absolute; bottom: -3px; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, transparent, #c8a84b 20%, #f0d060 50%, #c8a84b 80%, transparent);
}
```

**Resource pills**: en lugar de texto plano, encapsular cada recurso en un "medallón":
```css
.resource {
  background: radial-gradient(ellipse at 50% 30%, #3a2a0a, #1a0e04);
  border: 1px solid #6b4f2a;
  border-radius: 4px;
  padding: 4px 10px;
  box-shadow: inset 0 1px 0 rgba(200,168,75,0.2);
}
```

### 3.7 Fog of War — `src/hexRenderer.ts :: drawTile()` + `src/minimapRenderer.ts`

**Objetivo:** fog con gradiente hacia los bordes, no overlay plano.

**Cambio en `drawTile()`:**
En lugar de `globalAlpha = 0.35` para tiles en fog, aplicar un overlay radial:
```typescript
if (tile.inFog && fogEnabled) {
  ctx.save();
  const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, HEX_SIZE * 1.2);
  grad.addColorStop(0, 'rgba(10,8,4,0.60)');
  grad.addColorStop(1, 'rgba(10,8,4,0.85)');
  ctx.fillStyle = grad;
  fillHex(pos.x, pos.y, HEX_SIZE);
  ctx.fill();
  ctx.restore();
}
```

Tiles `revealed` pero no `inFog`: mostrar al 100% de opacidad (ya correcto).
Tiles nunca reveladas: `globalAlpha = 0` (ocultas completamente).

### 3.8 Notificaciones / Event Log — `src/styles/panels.css` + `src/ui/hud.ts`

**Objetivo:** mensajes tipo Civ V que aparecen en top-center y desaparecen.

**Cambio estructural en `index.html`:** añadir `#notifications` encima del event log:
```html
<div id="notifications"></div>
```

**CSS:**
```css
#notifications {
  position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center;
  gap: 6px; z-index: 30; pointer-events: none;
}
.notif-banner {
  background: linear-gradient(135deg, rgba(15,10,4,0.95), rgba(30,20,8,0.95));
  border: 1px solid #c8a84b;
  border-radius: 4px;
  padding: 6px 16px;
  font-family: 'Cinzel', serif;
  font-size: 13px;
  color: #e8d5a0;
  box-shadow: 0 4px 16px rgba(0,0,0,0.8);
  animation: notifIn 0.3s ease, notifOut 0.4s ease 3s forwards;
  white-space: nowrap;
}
@keyframes notifIn  { from { opacity:0; transform:translateY(-12px) } to { opacity:1; transform:translateY(0) } }
@keyframes notifOut { from { opacity:1 } to { opacity:0; transform:translateY(-8px) } }
```

**Función `showNotification(msg, icon?)`** en un nuevo `src/ui/notifications.ts`:
```typescript
export function showNotification(msg: string, icon = '⚡') {
  const el = document.createElement('div');
  el.className = 'notif-banner';
  el.textContent = `${icon}  ${msg}`;
  document.getElementById('notifications')?.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}
```

Llamar a `showNotification` desde `bridge.ts` en eventos `mission_complete`, `building_complete`, `city_founder`.

### 3.9 Minimap — `src/minimapRenderer.ts`

**Objetivo:** más parecido al minimap de Civ V.

**Cambios:**
1. **Marco ornamental**: dibujar un borde de 2px dorado + 1px interior oscuro alrededor del canvas minimap.
2. **Terreno más vivo**: usar los mismos colores del mapa principal (no `TERRAIN_COLOR.fill` plano, sino un color más saturado).
3. **Ciudades como diamantes**: en lugar de rectángulo, dibujar un diamante (rotado 45°) de 5×5px.
4. **Unidades como puntos con halo**: punto de 3px con sombra difuminada del color del agente.
5. **Viewport indicator**: rectangle con esquinas más marcadas y línea de 1.5px dorado semitransparente.

En `index.html`, añadir al `#minimap-container`:
```css
#minimap-container {
  border: 2px solid #6b4f2a;
  border-image: linear-gradient(135deg, #c8a84b, #5a3e1e, #c8a84b) 1;
  background: #0a0804;
  padding: 3px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.9), inset 0 0 0 1px rgba(200,168,75,0.1);
}
```

---

## 4. Tipografía

| Uso                    | Font             | Size  | Weight | Color          |
|------------------------|------------------|-------|--------|----------------|
| Nombres de ciudades    | Cinzel           | 13px  | 700    | #e8d5a0        |
| HUD labels             | Cinzel           | 11px  | 400    | #c8a84b        |
| Stats/números          | monospace        | 12px  | 400    | #b8a060        |
| Chat                   | monospace        | 12px  | 400    | #c8c0a8        |
| Notificaciones         | Cinzel           | 13px  | 400    | #e8d5a0        |
| Atajos de teclado kbd  | monospace        | 10px  | 400    | #c8a84b        |

Cinzel ya se carga via CSS var `--font-ui`. Verificar que el `@import` de Google Fonts esté en `src/styles/tokens.css`.

---

## 5. Animaciones clave

| Elemento              | Animación                         | Duración |
|-----------------------|-----------------------------------|----------|
| Selección de unidad   | Doble arco rotando opuesto        | continua |
| Unidad "working"      | 3 puntos en secuencia (dot-dot-dot) | 0.8s loop |
| Fog reveal            | Fade-out del overlay fog 0.4→0    | 0.5s     |
| Notificación aparece  | Slide-down + fade-in              | 0.3s     |
| Notificación desapar. | Fade-out + slide-up               | 0.4s     |
| Olas en ocean         | Offset Y con sin(animTime)        | continua |
| City banner aparece   | Scale 0.8→1 + fade in             | 0.25s    |
| Barra de progreso     | Transición CSS `width 0.3s ease`  | 0.3s     |

---

## 6. Orden de implementación (prioridad decreciente)

1. **Terrenos con degradado** (3.1) — impacto visual más alto, 30 min  
2. **City banner rediseñado** (3.3) — segunda prioridad visual  
3. **HUD chrome con gradiente border** (3.6) — da el feel "medieval" al instante  
4. **Borde de territorio orgánico** (3.5) — requiere lógica de vecinos hex  
5. **Notificaciones Civ V-style** (3.8) — QoL + visual  
6. **Selección animada de unidad** (3.4, paso 4) — pequeño pero muy "Civ"  
7. **Fog con gradiente radial** (3.7) — mejora sutil pero consistente  
8. **Minimap ornamental** (3.9) — último porque el impacto es menor  

---

## 7. Archivos a no tocar

- `src/game.ts` — lógica de juego, sin cambios visuales
- `src/pathfinding.ts` — A*, sin cambios
- `server/bridge.py` — backend, fuera de scope
- `src/bridge.ts` — excepto para llamar `showNotification` desde eventos bridge
- `src/types.ts` — solo si se necesita añadir campo `animOffset` a Unit para animación
