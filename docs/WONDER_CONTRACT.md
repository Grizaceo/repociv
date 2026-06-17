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

RepoCiv soporta dos modos de agregar Maravillas:

### 5.1 Built-in (contribuir al repo)

Para Maravillas que van a vivir en el código fuente de RepoCiv:

1. Crear o identificar la app externa (o componente nativo)
2. Declarar su `WonderManifest` en `src/wonders/manifest.ts`
3. Si es iframe, agregar URL en `src/wonderEnv.ts` con env var `VITE_WONDER_*_URL`
4. Si requiere auto-start, agregar `WonderSpec` + `ProcSpec` en
   `server/wonder_launcher.py: WONDER_LAUNCH_SPECS`
5. Actualizar `src/ui/capitalPanel.ts` si necesita tab propia
6. Documentar en este archivo

**NO agregar una nueva Maravilla antes de:**
- Tener el contrato estable con 2-3 ejemplos reales funcionando
- Verificar que `npm run check` + lint + tests pasen
- Documentar el flujo de opt-in

### 5.2 Custom (user-defined, sin tocar el repo)

Para Maravillas propias del usuario — apps personales, forks,
experimentos — que viven como manifests en `~/.repociv/wonders/`:

1. Crear `~/.repociv/wonders/<id>.json` con el `WonderManifest` +
   campo opcional `launch` (ver [`CUSTOM_WONDERS.md`](./CUSTOM_WONDERS.md))
2. Reiniciar el bridge
3. La Maravilla aparece en `GET /api/wonders` y queda disponible
   para `POST /api/wonders/<id>/launch`

**Limitación conocida:** el frontend usa `WONDER_MANIFESTS` hardcodeado
en `src/wonders/manifest.ts`, así que Maravillas custom NO aparecen
en el listado UI de la capital. Sí funcionan para auto-start y
health checks vía la API. Es una restricción intencional para
mantener el contrato del frontend estable; ver roadmap.

**Override de built-ins:** un manifest custom con `id: "bibliotheca"`
(o `"institutum"`) gana al built-in. El bridge loguea un warning.
Útil para forkear Maravillas built-in sin tocar el código.

---

## 6. Referencias

- `docs/CUSTOM_WONDERS.md` — guía user-facing para Maravillas custom
  (sin tocar el código de RepoCiv)
- `docs/ROADMAP_IMPERIAL_WORKSHOP.md` — canon de producto
- `src/wonders/types.ts` — tipos TypeScript del contrato
- `src/wonders/wonderConfig.ts` — manifests y defaults
- `src/wonders/manifest.ts` — registry runtime
