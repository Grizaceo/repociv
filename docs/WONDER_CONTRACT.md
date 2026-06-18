# RepoCiv — Contrato de Maravilla (WONDER_CONTRACT)

Documento vivo. Si contradice `SCOPE.md` o `ROADMAP_IMPERIAL_WORKSHOP.md`, los roadmaps ganan.

---

## 1. ¿Qué es una Maravilla?

Una Maravilla es una utilidad integrada en RepoCiv. Puede ser:

- **Nativa**: construida dentro del mismo frontend (ej: La Gaceta)
- **iframe**: app externa embebedida (ej: La Gran Biblioteca, Institutum/LabHub)

Toda Maravilla, sin importar su tipo, declara un **WonderManifest** que describe:

- identidad y metadatos
- capacidades y límites
- nivel de automatización
- reglas de opcionalidad
- permisos y seguridad

---

## 2. WonderManifest — Referencia de campos

### 2.1 Identidad

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `id` | `string` | sí | Identificador único (ej: `bibliotheca`) |
| `title` | `string` | sí | Nombre visible en UI |
| `kind` | `"native" \| "iframe"` | sí | Tipo de integración |
| `category` | `"knowledge" \| "operations" \| "news" \| "lab"` | sí | Categoría funcional |
| `version` | `string` | sí | Semver |
| `defaultEnabled` | `bool` | sí | Si aparece habilitada por defecto |

### 2.2 Capability flags

| Campo | Tipo | Default | Descripción |
|-------|------|---------|-------------|
| `passiveMode` | `bool` | `true` | La experiencia base es pasiva (solo muestra información) |
| `agenticMode` | `bool` | `false` | Puede exponer acciones agentivas (sugerencias, análisis) |
| `canSuggest` | `bool` | `false` | Puede sugerir relaciones, reportes, acciones |
| `canAct` | `bool` | `false` | Puede ejecutar acciones propias (siempre mediadas por policy/approval) |
| `requiresConfirmation` | `bool` | `true` | Cualquier acción no pasiva requiere confirmación humana |

**Principio**: `canAct = false` para todas las Maravillas iniciales. Solo se habilita cuando la acción es segura y el usuario lo activa explícitamente.

### 2.3 Automatización

| Campo | Tipo | Opciones | Descripción |
|-------|------|----------|-------------|
| `automationLevel` | `"passive" \| "assist" \| "auto"` | `passive` | Nivel base de automatización |

**Niveles**:

- `passive`: solo muestra información. No sugiere ni actúa. Default para Gaceta y Bibliotheca.
- `assist`: sugiere pero no ejecuta. El usuario confirma. Default para LabHub warnings.
- `auto`: ejecuta acciones seguras automáticamente. Solo para acciones declaradas `risk: "safe"`. No se usa inicialmente.

### 2.4 Features opcionales

```ts
interface WonderOptionalFeature {
  id: string;
  label: string;
  description: string;
  defaultEnabled: false;        // SIEMPRE false inicialmente
  requiresUserOptIn: true;      // SIEMPRE true inicialmente
}
```

**Regla**: toda feature avanzada que sugiera, analice o automatice debe estar desactivada por defecto y requerir opt-in explícito.

### 2.5 Acciones

```ts
interface WonderAction {
  id: string;
  label: string;
  risk: "safe" | "approval" | "manual";
  requiresUserOptIn: boolean;
}
```

- `risk: "safe"` → no muta estado, no requiere approval del Command Bus
- `risk: "approval"` → pasa por approval gate antes de ejecutar
- `risk: "manual"` → el usuario debe ejecutar manualmente; la Maravilla solo informa

### 2.6 UI (para iframes)

```ts
ui?: {
  url?: string;
  preferredWidth?: string;    // default: "70vw"
  preferredHeight?: string;   // default: "75vh"
  sandbox?: string[];         // default: ["allow-scripts", "allow-same-origin", "allow-forms"]
}
```

### 2.7 Health check

```ts
health?: {
  url: string;
  timeoutMs: number;          // default: 4000
  degradedAllowed: boolean;   // default: true
}
```

Si `degradedAllowed = true`, la Maravilla se muestra con warning en vez de error cuando el health falla.

### 2.8 Permisos

```ts
permissions: {
  readRepos: boolean;
  writeRepos: boolean;
  network: "loopback-only" | "none";
  requiresApprovalForMutations: boolean;
}
```

### 2.9 MCP (futuro)

```ts
mcp: {
  enabled: boolean;
  server: string | null;
}
```

MCP se habilita solo cuando el contrato madure. Fase inicial usa HTTP + postMessage.

---

## 3. Reglas de opcionalidad

### 3.1 Principio: integración total, obligación cero

La Maravilla debe **sentirse** integrada, pero su uso avanzado debe ser **siempre voluntario y configurable**.

### 3.2 Capas

| Capa | Descripción | Default |
|------|-------------|---------|
| Vista básica | Contenido pasivo: noticias, archivos, badges | **ON** |
| Vista aumentada | Labels extra, tooltips, LOD | **ON** |
| Acciones agentivas | Informes, sugerencias, análisis | **opt-in (OFF)** |
| Automatización | Bloqueos suaves, alertas automáticas | según Maravilla |

### 3.3 Defaults por Maravilla

| Maravilla | `automationLevel` | `passiveMode` | Features agentivas |
|-----------|-------------------|---------------|-------------------|
| Gaceta/CDaily | `passive` | `true` | Todo OFF |
| Bibliotheca | `passive` | `true` | Todo OFF |
| LabHub/Institutum | `assist` | `true` | Warnings ON, soft-locks ON, hard-locks OFF |

---

## 4. Seguridad

### 4.1 Iframe

- Siempre usar `sandbox` attribute.
- Validar `origin` en mensajes `postMessage`.
- No permitir mutaciones directas desde iframe.
- Toda acción riesgosa pasa por Command Bus/approval.

### 4.2 postMessage API

Eventos host → Maravilla:
```
repociv.context    — ciudad seleccionada, tema
repociv.focus      — focalizar ciudad/modo
repociv.layer      — capa activada/desactivada
```

Eventos Maravilla → host:
```
wonder.ready       — Maravilla lista
wonder.focus_city  — pedir foco en ciudad
wonder.report      — reporte creado
wonder.notification — notificación (info/warn/critical)
```

---

## 5. Cómo agregar una nueva Maravilla

> **Modelo (desde 2026-06-17):** solo **La Gaceta** (nativa) viene activa.
> Bibliotheca y LabHub ya **no** son built-ins: son **ejemplos conectables**
> (`src/wonders/exampleTemplates.ts`). Cualquier servicio iframe se conecta del
> mismo modo — escribiendo un manifest a `~/.repociv/wonders/<id>.json`. El
> frontend hidrata el registry vía `GET /api/wonders` en el arranque, así que
> las Maravillas conectadas aparecen en la UI sin tocar el código.

### 5.1 Conectar (recomendado — el usuario, sin tocar el repo)

Desde la UI: **Palacio → pestaña "Maravillas"**. Hay tarjetas de ejemplo
(Bibliotheca, LabHub) con su repo público y un botón **Conectar**; o conectás
un servicio propio con su `WonderManifest`. Bajo el capó:

- `POST /api/wonders/connect` con el `WonderManifest` (+ `launch` opcional) en
  el body → valida, sanitiza el `id` (`[a-z0-9_-]`), expande `~`/`$ENV` en
  `launch.repo_dir`/`procs[].cwd`, y escribe `~/.repociv/wonders/<id>.json`.
  Recarga el launcher en caliente (sin reiniciar el bridge).
- `POST /api/wonders/<id>/disconnect` → borra ese JSON (solo del dir del
  usuario; los built-in en código no se tocan).
- Loopback-only + token-gated (igual que `launch`).

A mano (sin UI): creá `~/.repociv/wonders/<id>.json` y reiniciá el bridge — ver
[`CUSTOM_WONDERS.md`](./CUSTOM_WONDERS.md). Aparece en `GET /api/wonders` y queda
disponible para `POST /api/wonders/<id>/launch`.

### 5.2 Built-in / ejemplo (contribuir al repo)

Para Maravillas que viven en el código fuente:

- **Nativa** (como Gaceta): declarar el `WonderManifest` en
  `src/wonders/manifest.ts` (`WONDER_MANIFESTS`) y en
  `server/wonder_registry.py` (`_STATIC_WONDER_MANIFESTS`).
- **Ejemplo conectable** (como Bibliotheca/LabHub): añadir a
  `src/wonders/exampleTemplates.ts` (`WONDER_EXAMPLES`) con su `repoUrl` +
  descripción; si requiere auto-start, añadir `WonderSpec` en
  `server/wonder_launcher.py: WONDER_LAUNCH_SPECS`. NO se registra estático: el
  usuario lo conecta desde la guía.

**NO agregar una nueva Maravilla antes de:** contrato estable con ejemplos
reales funcionando · `npm run check` + lint + tests verdes · flujo de opt-in
documentado.

**Override de built-ins:** un manifest custom con `id: "bibliotheca"`
(o `"institutum"`) gana sobre el launch spec built-in. El bridge loguea un
warning. Útil para apuntar un ejemplo a un fork propio sin tocar el código.

---

## 6. Referencias

- `docs/CUSTOM_WONDERS.md` — guía user-facing para Maravillas custom
  (sin tocar el código de RepoCiv)
- `docs/ROADMAP_IMPERIAL_WORKSHOP.md` — canon de producto
- `src/wonders/types.ts` — tipos TypeScript del contrato
- `src/wonders/wonderConfig.ts` — manifests y defaults
- `src/wonders/manifest.ts` — registry runtime

---

## 7. Lifecycle / Auto-arranque (F1–F5, 2026-06-16 → 2026-06-17)

RepoCiv ahora levanta por sí mismo los procesos de las Maravillas iframe
(`bibliotheca`/`institutum`) en lugar de requerir terminales manuales. El
ciclo de vida tiene tres fases:

### 7.1 Boot
- `main.ts::bootstrap()` corre `ensureWondersUp(['bibliotheca','institutum'])` en background tras `bridge.start()`.
- `ensureWondersUp` llama `POST /api/wonders/<id>/launch` (no-bloqueante) y arranca `pollWonderUntilReady` en paralelo.
- El render del mapa **no espera** a las Maravillas — el boot sigue fluido.

### 7.2 Health-check waiting
- `pollWonderUntilReady(id, { timeoutMs=60000, intervalMs=1500 })` sondea
  `GET /api/wonders/<id>/launch-status` hasta que `ready.api` **y**
  `ready.ui` respondan OK.
- Bibliotheca: API `:3001/api/health` + UI `:5173/`.
- Institutum: API `:5281/health` + UI `:5280/` (split UI/API resuelto en F1, commit `e64c7dd`).
- Mientras tanto, la viñeta muestra "⚙️ Levantando la maravilla…".

### 7.3 Mount
- Cuando `ready === true`, `openWonderVignette` monta el iframe con la URL UI resuelta (no la API).
- Si timeout o error, cae al `_showEmptyState` con botón "Levantar de nuevo" + instrucciones.

### 7.4 Stop (opcional)
- `POST /api/wonders/<id>/stop` mata el process-group registrado. No expuesto en UI por defecto.

### 7.5 Restricciones de seguridad
- **Loopback only:** `REPOCIV_REMOTE=true` rechaza `POST /launch` con 4xx.
- **Token-gated:** todos los POST requieren `REPOCIV_TOKEN` (ya en `do_POST`).
- **Allowlist:** solo ids en `WONDER_LAUNCH_SPECS` + argv fijo del lado servidor.
- **cwd configurables:** `REPOCIV_WONDER_BIBLIOTHECA_DIR` y `REPOCIV_WONDER_INSTITUTUM_DIR` (defaults a `~/.hermes/workspace/repos/la-gran-biblioteca` y `~/.hermes/workspace/repos/labhub`).

### 7.6 Representación 3D en el mapa (F5, 2026-06-17)

`src/three/WonderProps3D.ts` renderiza cada Maravilla como una estructura
3D distintiva en lugar del decor genérico `sacred tile`:

| Maravilla | Geometría procedural (sin GLB) |
|-----------|----------------------------------|
| `bibliotheca` (q=-1) | Templo: 3 dais escalonados + 6 columnas en hex ring + frontón + gema emisiva en el ápice |
| `institutum` (q=+1)  | Laboratorium: dais plano + 4 obeliscos en las esquinas + domo + núcleo emisivo |

- Layer gating: `bibliotheca` bajo `knowledge`, `institutum` bajo `labs`
  (espejo del 2D en `renderer.ts:1190-1225`).
- Etiquetas CSS2D: `BIBLIOTHECA` y `LABHUB` sobre cada Maravilla.
- Click 3D → `openWonderVignette(wonderType)` (mismo handler que el 2D).
- `e2e/golden/08-wonders-closeup.png` es el golden dedicado.
- Plan para F7 (futuro): swap a GLBs vía `repociv-3d-asset-forge`.
