# RepoCiv — Roadmap Canonico: Taller Imperial de Maravillas

Fecha: 2026-05-25
Estado: canonico para la siguiente etapa de producto alpha
Reemplaza como foco operativo a planes sueltos de integración visual, pero no reemplaza `SCOPE.md`: si este documento contradice `SCOPE.md`, gana `SCOPE.md`.

---

## 0. Tesis

RepoCiv ya no esta en la etapa "hacer que exista". Esta en la etapa "hacer que el imperio sea legible".

La direccion correcta no es agregar 3D real ni mas paneles. La direccion correcta es:

1. reducir ruido visual;
2. separar la informacion en capas;
3. convertir Gaceta, Bibliotheca, Institutum/LabHub y futuras utilidades en Maravillas con contrato comun;
4. permitir que agentes especializados produzcan informes utiles desde esas Maravillas;
5. mantener todo local, barato y dogfooding-driven.

La fantasia de producto es:

> RepoCiv como capital operativa. Las ciudades son repos/labs. Las Maravillas son utilidades embebidas por contrato. Los agentes son oficios historicos o tecnicos que leen el imperio y generan acciones, no decoracion.

---

## 1. Principios de esta etapa

### P1. Legibilidad antes que 3D

El problema actual no es falta de profundidad grafica. Es exceso de señales simultaneas.

Se permite "3D ligero" solo como 2.5D Canvas:

- sombras direccionales;
- elevacion por capas;
- parallax sutil;
- labels flotantes;
- foco visual por seleccion;
- tiles con altura aparente;
- niebla/atenuacion de distancia;
- animaciones livianas.

No se mete Three.js/WebGL al trunk en esta etapa. Si se explora, sigue en branch paralela `feat/3d-renderer` y entra solo si demuestra paridad funcional.

### P2. Capas de informacion

El mapa no debe mostrar todo siempre.

Capas minimas:

- Capa base: ciudades/repos, recursos principales, agentes.
- Capa estructura: carpetas principales, edificios, Maravillas.
- Capa operacional: tareas, experimentos activos, aprobaciones, fallos.
- Capa conocimiento: relaciones de Bibliotheca, nodos externos, conexiones sugeridas.
- Capa seguridad/lab: alarmas de LabHub/Muralla, locks por experimento.

Cada capa debe poder prenderse/apagarse. El zoom debe controlar cuanto texto aparece.

### P3. Las Maravillas son extensiones, no iframes sueltos

Una Maravilla puede ser nativa o iframe, pero debe cumplir un contrato.

No basta con insertar una URL. Debe declarar:

- identidad;
- health;
- permisos;
- acciones;
- eventos;
- tipo de datos;
- relacion con ciudades/repos;
- modo offline;
- seguridad iframe;
- si expone MCP u otra API.

Tinyfish grounding usado para este principio:

- El modelo iframe sigue siendo valido para integraciones embebidas si hay caso de uso claro, restricciones de seguridad, sandboxing y guidelines visuales. Fuente: Moesif, "The Fall and Rise of Embedded Plugins: IFrames".
- MCP recomienda herramientas con schemas, output estructurado, anotaciones, rate limit, validacion, confirmacion humana y logs de auditoria. Fuente: Model Context Protocol, Tools specification.

### P4. Agentes como oficios, no solo personalidades

Aristoteles, bibliotecario, astronomo, diplomatico, jurista, etc. pueden existir como skins pedagogicas, pero el nucleo debe ser un oficio operacional.

Ejemplos:

- Bibliotecario/Astronomo: encuentra relaciones entre nodos y ciudades.
- Diplomatico/Analista exterior: explica como una noticia afecta una ciudad/repo.
- Custodio/Ingeniero de guardia: detecta experimentos activos y recomienda no tocar una ciudad.
- Cartografo: reorganiza labels/capas/relaciones del mapa.

La personalidad historica es la voz. El oficio es el contrato.

### P5. Integración total, obligación cero

Las Maravillas deben dar la **sensación** de integración total, pero el uso de sus
capas avanzadas debe ser siempre **voluntario y configurable**.

Principio fuerte:

> El usuario nunca debe sentir que la AI "se mete" en cada acción. Mirar noticias,
> navegar carpetas y monitorear laboratorios tiene que funcionar sin pedir permiso
> a un oráculo cada cinco segundos.

Capas de cada Maravilla, de menor a mayor intervención:

| Capa | Descripción | Default |
|------|-------------|---------|
| Vista básica | Contenido pasivo: noticias, archivos, badges | **ON** |
| Vista aumentada | Labels extra, tooltips, LOD, foco visual | **ON** |
| Acciones agentivas | Informes, sugerencias de grafo, análisis | **opt-in** |
| Automatización/locks | Bloqueos suaves, avisos automáticos, alertas | según maravilla* |

*\*LabHub: avisos/soft-locks ON por defecto porque su función es proteger trabajo vivo.*

Aplicación concreta:

- **Gaceta/CDaily**: la intención original es ver noticias mientras los agentes
  trabajan. El "Informe de Relaciones Exteriores" es una acción manual opcional,
  nunca automática. `showNews: true`, `foreignRelationsReport: false`, `autoSummaries: false`.
- **La Gran Biblioteca**: la intención original es navegación visual dinámica de
  carpetas/repos. No reemplaza el sistema de archivos. Las relaciones sugeridas por
  AI/grafo son un extra. `fileNavigation: true`, `graphSuggestions: false`, `aiRelationDiscovery: false`.
- **LabHub/Institutum**: puede tener más automatización por defecto porque opera
  sobre riesgo real (experimentos vivos). Pero distingue: avisos automáticos (ON),
  bloqueos suaves (ON), acciones destructivas (requieren confirmación explícita).
  `warnBeforeCityEdit: true`, `softLocks: true`, `hardLocks: false`.

El `WonderManifest` debe declarar por cada acción/capa si requiere opt-in.
La configuración de usuario anula los defaults, nunca al revés.

### P6. Offline ultrabarato primero

Antes de meter LLMs caros o lectura completa de repos:

1. indices locales;
2. metadatos de git;
3. package manifests;
4. README/docs resumidos;
5. tags/skills existentes;
6. grafos de imports;
7. eventos de RepoCiv;
8. embeddings pequeños/cacheados solo si hace falta;
9. LLM grande solo para el reporte final o desempate.

---

## 2. Estado actual observado

Ultimo estado revisado:

- `npm run check`: pasa.
- `python3 -m py_compile server/*.py`: pasa.
- `bash scripts/healthcheck.sh`: 6/6 OK.
- `bash scripts/smoke-test.sh`: 9/9 OK.
- UI carga sin errores JS visibles y WS conecta.
- `pytest -q server`: 518 passed, 1 skipped, 1 failed.
- `npm run lint`: falla con 4 errores y 14 warnings.
- `npm run format:check`: falla en 50 archivos.

Problemas puntuales a corregir antes de grandes features:

- `server/test_cdaily_bridge.py::test_get_latest_news_returns_unread` falla porque `get_latest_news()` espera `a.categories` y el test crea schema sin esa columna.
- Errores ESLint:
  - `src/localRenderer.ts`: `fillColor` debe ser `const`.
  - `src/renderer.ts`: `warmColor` y `vignetteColor` asignados sin uso posterior.
  - `src/ui/hudWiring/inputs.ts`: `_cityHere` asignado sin uso posterior.
- LabHub esta vivo en puerto 5281, pero `src/wonderEnv.ts` usa por defecto `WONDER_INSTITUTUM_URL = http://localhost:5280`. Revisar si es intencional por env o drift.

---

## 3. Arquitectura objetivo

### 3.1 Contrato de Maravilla (WonderManifest)

Crear un contrato comun para Maravillas embebidas o nativas.

Propuesta de manifest:

```json
{
  "id": "bibliotheca",
  "title": "Bibliotheca Alexandrina",
  "kind": "iframe",
  "category": "knowledge",
  "version": "0.1.0",
  "defaultEnabled": true,
  "ui": {
    "url": "http://localhost:5173",
    "preferredWidth": "70vw",
    "preferredHeight": "75vh",
    "sandbox": ["allow-scripts", "allow-same-origin", "allow-forms"]
  },
  "health": {
    "url": "http://localhost:3001/api/health",
    "timeoutMs": 4000,
    "degradedAllowed": true
  },
  "permissions": {
    "readRepos": true,
    "writeRepos": false,
    "network": "loopback-only",
    "requiresApprovalForMutations": true
  },
  "automationLevel": "passive",
  "passiveMode": true,
  "agenticMode": false,
  "canSuggest": true,
  "canAct": false,
  "requiresConfirmation": true,
  "optionalFeatures": [
    {
      "id": "graphSuggestions",
      "label": "Sugerencias de relaciones",
      "description": "El agente Astrónomo sugiere conexiones entre nodos",
      "defaultEnabled": false,
      "requiresUserOptIn": true
    },
    {
      "id": "aiRelationDiscovery",
      "label": "Descubrimiento AI de relaciones",
      "description": "Usa grafo offline para encontrar vínculos no obvios",
      "defaultEnabled": false,
      "requiresUserOptIn": true
    }
  ],
  "events": {
    "emits": ["wonder.ready", "wonder.selection", "wonder.report.created"],
    "accepts": ["repociv.focus_city", "repociv.open_local_view"]
  },
  "actions": [
    {
      "id": "open",
      "label": "Entrar",
      "risk": "safe",
      "requiresUserOptIn": false
    },
    {
      "id": "ask_agent",
      "label": "Preguntar a agente",
      "risk": "safe",
      "requiresUserOptIn": true
    }
  ],
  "mcp": {
    "enabled": false,
    "server": null
  }
}
```

**Campos de opcionalidad del WonderManifest:**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `defaultEnabled` | `bool` | Si la Maravilla aparece en el panel por defecto |
| `automationLevel` | `"passive" \| "assist" \| "auto"` | Nivel de automatización base |
| `passiveMode` | `bool` | Si la experiencia base de la Maravilla es pasiva/informativa |
| `agenticMode` | `bool` | Si la Maravilla puede exponer acciones agentivas opcionales |
| `canSuggest` | `bool` | Si puede sugerir relaciones/reportes/acciones |
| `canAct` | `bool` | Si puede ejecutar acciones propias (siempre mediadas por policy/approval) |
| `requiresConfirmation` | `bool` | Si cualquier acción no pasiva requiere confirmación humana |
| `optionalFeatures` | `Feature[]` | Lista de features avanzadas que el usuario puede activar |
| `optionalFeatures[].defaultEnabled` | `bool` | Default de esa feature específica |
| `optionalFeatures[].requiresUserOptIn` | `bool` | Si requiere activación explícita del usuario |
| `actions[].requiresUserOptIn` | `bool` | Si la acción agentiva requiere opt-in |

**Niveles de automatización:**

- `passive`: solo muestra información. No sugiere ni actúa. Default para Gaceta y Bibliotheca.
- `assist`: sugiere pero no ejecuta. El usuario confirma. Default para LabHub warnings.
- `auto`: ejecuta acciones seguras automáticamente. Solo para acciones declaradas `risk: "safe"`.

Defaults por Maravilla:

| Maravilla | `automationLevel` | Features agentivas default |
|-----------|-------------------|---------------------------|
| Gaceta/CDaily | `passive` | Todo OFF |
| Bibliotheca | `passive` | Todo OFF |
| LabHub/Institutum | `assist` | Warnings ON, soft-locks ON, hard-locks OFF |

Archivos candidatos:

- Crear `src/wonders/manifest.ts`.
- Crear `src/wonders/types.ts`.
- Crear `src/wonders/wonderConfig.ts`.
- Crear `server/wonder_registry.py`.
- Modificar `src/wonderEnv.ts` para dejar de hardcodear solo Bibliotheca/Institutum.
- Modificar `src/ui/wonderVignette.ts` para aceptar manifest.
- Modificar `src/ui/capitalPanel.ts` para renderizar tabs desde registry.
- Modificar `src/types.ts` para que `WonderType` venga de ids registrados o union extendible.

### 3.2 Iframe bridge por postMessage

El iframe no debe ser mudo. Debe poder hablar con RepoCiv por una API minima.

Eventos host -> maravilla:

```ts
type RepoCivToWonder =
  | { type: 'repociv.context'; cityId?: string; selectedRepo?: string; theme: string }
  | { type: 'repociv.focus'; cityId: string; mode: 'macro' | 'local' }
  | { type: 'repociv.layer'; layer: string; enabled: boolean };
```

Eventos maravilla -> host:

```ts
type WonderToRepoCiv =
  | { type: 'wonder.ready'; id: string }
  | { type: 'wonder.focus_city'; cityId: string; open?: 'macro' | 'local' }
  | { type: 'wonder.report'; id: string; title: string; markdown: string; relatedCities: string[] }
  | { type: 'wonder.notification'; level: 'info' | 'warn' | 'critical'; text: string };
```

Reglas:

- Validar `origin`.
- Validar schema antes de actuar.
- No permitir mutaciones directas desde iframe.
- Toda accion riesgosa pasa por Command Bus/approval.
- Loguear eventos importantes en Event Store.

### 3.3 MCP: si, pero como plano de herramientas, no como iframe

No hace falta crear un MCP server para cada iframe al inicio.

MCP sirve cuando una Maravilla necesita exponer capacidades legibles por agentes:

- recursos: listar/leer grafo, noticias, labs, reportes;
- herramientas: crear reporte, lanzar scan, marcar noticia, pedir relacion;
- prompts: plantillas de informe.

Decision:

- Fase inicial: contrato HTTP/manifest + postMessage.
- Fase media: `server/mcp_server.py` expone Maravillas como tools/resources cuando el contrato madure.
- Fase avanzada: cada Maravilla externa puede traer su propio MCP server opcional.

MCP server plan minimo para Maravillas:

Tools:

- `wonder.list`: lista Maravillas registradas. Read-only.
- `wonder.health`: health detallado por Maravilla. Read-only.
- `wonder.open_context`: prepara contexto para abrir/focalizar una Maravilla. Read-only.
- `wonder.report.create`: crea informe asociado a ciudad/repo. Mutating-light, requiere audit.
- `wonder.action.request`: solicita accion declarada por manifest. Puede requerir approval.

Resources:

- `repociv://wonders/manifest`
- `repociv://wonders/{id}/health`
- `repociv://wonders/{id}/reports/{report_id}`
- `repociv://cities/{city_id}/relations`

Prompts:

- `informe-relaciones-exteriores`
- `informe-bibliotecario-conexiones`
- `informe-labhub-riesgo-edicion`

Anotacion mas importante: marcar read-only vs mutating con claridad. El cliente no debe confiar solo en annotations para seguridad, pero ayudan a la UI y al agente.

---

## 4. Roadmap por fases

### Fase 0 — Baseline verde y deuda que bloquea confianza

Objetivo: dejar el suelo estable antes de construir encima.

Tareas:

1. Arreglar CDaily schema tolerance.
   - `get_latest_news()` debe tolerar ausencia de columna `categories`.
   - O el test debe crear la columna si el schema real ya la exige. Preferencia: tolerancia, porque CDaily puede tener DB vieja.
   - Archivos: `server/http_routes.py`, `server/test_cdaily_bridge.py`.

2. Arreglar 4 errores ESLint.
   - Archivos: `src/localRenderer.ts`, `src/renderer.ts`, `src/ui/hudWiring/inputs.ts`.

3. Decidir Prettier.
   - O se corre `npm run format` en commit separado.
   - O se baja `format:check` como gate no obligatorio hasta una pasada dedicada.
   - Recomendacion: correr Prettier en commit unico y no mezclar con features.

4. Revisar puerto de LabHub.
   - Confirmar si Institutum debe apuntar a 5281.
   - Si si, actualizar `.env.example`, `src/wonderEnv.ts`, docs.

Gates:

- `python3 -m py_compile server/*.py`
- `npm run check`
- `pytest -q server`
- `npm run lint`
- `npm run format:check` si se adopta Prettier como gate.
- `bash scripts/healthcheck.sh`
- `bash scripts/smoke-test.sh`

---

### Fase 1 — Legibilidad del mapa y capas visuales

Objetivo: hacer el mapa mas amable sin 3D real.

Tareas:

1. Crear estado de capas.
   - Archivo candidato: `src/layers.ts`.
   - Capas: `base`, `structure`, `ops`, `knowledge`, `labs`, `security`, `labels`.

2. Agregar selector/toggle de capas.
   - Archivo candidato: `src/ui/layerPanel.ts`.
   - Integrar en toolbar o hotkey `V`/`Layers`.

3. Implementar LOD de labels.
   - Archivos: `src/renderer.ts`, `src/localRenderer.ts`.
   - Reglas:
     - zoom bajo: solo nombres de ciudades importantes;
     - zoom medio: edificios y maravillas;
     - zoom alto: carpetas, badges, detalles.

4. Crear modo limpio.
   - Toggle: `Clean Map`.
   - Oculta labels chicas, thumbnails, badges no criticos.
   - Mantiene alertas criticas.

5. Mejorar foco de seleccion.
   - Glow/borde animado en ciudad/agente seleccionado.
   - Breadcrumb: `Seleccionado: ciudad / vista / agente`.
   - Panel contextual minimo con acciones primarias.

6. 2.5D liviano.
   - Sombras direccionales consistentes.
   - Elevacion aparente en Maravillas.
   - Parallax minimo en labels flotantes.
   - Nada de WebGL.

Gates:

- No bajar FPS percibido.
- No aumentar bundle principal sin razon.
- Browser console sin errores.
- Screenshot antes/despues en docs o PR.

---

### Fase 2 — Taller Imperial de Maravillas

Objetivo: estandarizar Bibliotheca, Institutum/LabHub, Gaceta y futuras utilidades externas.

Tareas:

1. Definir `WonderManifest`.
   - Archivos: `src/wonders/types.ts`, `src/wonders/manifest.ts`.

2. Migrar Bibliotheca e Institutum al registry.
   - Eliminar hardcodeos de `Record<WonderType, string>` dispersos.
   - Mantener compatibilidad con `VITE_WONDER_BIBLIOTHECA_URL`, `VITE_WONDER_INSTITUTUM_URL`, `VITE_LGB_BACKEND_URL`.

3. Crear `server/wonder_registry.py`.
   - Lee manifests estaticos primero.
   - Mas adelante lee `~/.repociv/wonders/*.json`.

4. Endpoint backend:
   - `GET /wonders`
   - `GET /wonders/{id}/health`
   - `POST /wonders/{id}/report` si aplica.

5. PostMessage bridge.
   - Archivo candidato: `src/wonders/postMessageBridge.ts`.
   - Validar origin/schema.
   - Integrar con `BridgeEvents` solo por eventos tipados.

6. Empty states comunes.
   - Offline UI, degraded UI, no permisos, timeout.
   - Reusar en `wonderVignette.ts`.

7. Documentar contrato.
   - Crear `docs/WONDER_CONTRACT.md`.

Gates:

- Bibliotheca abre igual o mejor que hoy.
- Institutum abre con puerto correcto o empty state correcto.
- Un manifest invalido no rompe la app.
- Iframe no puede ejecutar acciones peligrosas sin approval.

---

### Fase 3 — Gaceta: noticias primero, Informe de Relaciones Exteriores opcional

Objetivo: que Gaceta sea ante todo una forma simple de ver noticias mientras los
agentes trabajan. El análisis agentivo es una capa adicional que el usuario activa
cuando lo necesita, nunca el modo por defecto.

**Funcionalidad base (ON por defecto):**
- Ver feed de noticias CDaily.
- Marcar como leído.
- Filtrar por categoría/blog.
- Ver metadata: fecha, fuente, categoría.

**Informe de Relaciones Exteriores (opt-in, OFF por defecto):**

No se genera automáticamente. Es una acción manual del usuario.

Flujo UX:

1. Usuario abre Gaceta.
2. Selecciona noticia o grupo de noticias.
3. Clic en `Informe de Relaciones Exteriores` (botón visible pero no intrusivo).
4. Elige ciudad/repo afectado o usa la selección actual del mapa.
5. Agente Diplomatico analiza bajo demanda:
   - noticia;
   - metadata de la ciudad/repo;
   - README/package/configs resumidos;
   - eventos recientes;
   - relaciones de Bibliotheca si existen y si el usuario tiene `graphSuggestions` activado.
6. Devuelve informe:
   - resumen;
   - por qué importa;
   - impacto probable;
   - acciones sugeridas;
   - evidencia usada;
   - confianza;
   - si requiere seguimiento.
7. El informe queda guardado como recurso de RepoCiv y linkeado a ciudad/noticia.

Configuración por defecto:

```ts
gaceta: {
  showNews: true,
  foreignRelationsReport: false,
  autoSummaries: false,
}
```

Modelo de datos:

```ts
interface ForeignRelationsReport {
  id: string;
  createdAt: string;
  articleIds: string[];
  targetCityId: string;
  targetRepoPath: string;
  agentId: 'diplomat' | string;
  title: string;
  summary: string;
  impact: 'none' | 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  evidence: Array<{ type: 'article' | 'repo_file' | 'event' | 'graph'; ref: string; quote?: string }>;
  recommendations: Array<{ label: string; risk: 'safe' | 'approval' | 'manual'; command?: string }>;
  markdown: string;
}
```

Agente:

- Nombre oficio: Diplomatico / Analista Exterior.
- Skin opcional: Maquiavelo, Tocqueville, Ibn Jaldun, etc.
- No debe ejecutar cambios. Solo informa y propone.

Implementacion ultrabarata:

- Usar feed CDaily SQLite.
- Cachear resumen por articulo.
- Crear perfil barato por repo:
  - README first 4k chars;
  - package.json/pyproject/Cargo/go.mod;
  - top-level dirs;
  - git recent files;
  - tags de skills si hay.
- Comparar articulo vs repo por keywords/TF-IDF local primero.
- LLM solo para redactar informe final cuando score supere umbral.

Archivos candidatos:

- `server/foreign_relations.py`
- `server/repo_profile.py`
- `server/report_store.py`
- `src/ui/foreignRelationsPanel.ts`
- `src/ui/gacetaWidget.ts`
- `src/types.ts`

Gates:

- No analiza todos los repos por cada noticia.
- Reporte se genera para un repo objetivo en menos de 10s en modo local barato.
- Si no hay relacion, debe decir "impacto bajo/no claro", no inventar.

---

### Fase 4 — Bibliotheca: navegación visual primero, descubrimiento AI opcional

Objetivo: que La Gran Biblioteca sea ante todo una forma dinámica y visual de moverse
por carpetas/repos locales. No reemplaza el sistema de archivos. Las relaciones
sugeridas por AI/grafo son un extra que el usuario activa si quiere.

**Funcionalidad base (ON por defecto):**
- Navegación visual de carpetas/repos.
- Click derecho → ir a ciudad en RepoCiv / abrir vista local.
- Desde ciudad → abrir nodo correspondiente en Bibliotheca.
- Búsqueda básica por nombre.

**Descubrimiento AI de relaciones (opt-in, OFF por defecto):**

Solo se activa si el usuario habilita `graphSuggestions` o `aiRelationDiscovery`
en la configuración de la Maravilla.

#### 4.1 Click derecho desde Bibliotheca hacia RepoCiv

- Usuario hace click derecho en nodo de repo/documento.
- Opcion: `Ir a ciudad en RepoCiv`.
- Opcion: `Abrir vista local RimWorld`.
- Bibliotheca envia `wonder.focus_city` por postMessage.
- RepoCiv centra ciudad o entra a local view.

#### 4.2 Desde ciudad hacia Bibliotheca

- Click derecho en ciudad.
- Opcion: `Ver en Bibliotheca`.
- RepoCiv abre iframe y envia `repociv.focus`.

#### 4.3 Agente Astronomo/Bibliotecario (solo si opt-in activo)

Objetivo: encontrar relaciones no obvias entre ciudades/nodos no incluidos directamente en el repo.

Algoritmo offline ultrabarato, por etapas:

1. Snapshot incremental de grafos:
   - imports;
   - links markdown;
   - nombres de entidades;
   - package deps;
   - tags de skills;
   - eventos RepoCiv;
   - README headings.

2. Candidate generation barato:
   - lexical overlap normalizado;
   - shared dependencies;
   - common entities;
   - git co-activity temporal;
   - paths similares;
   - enlaces markdown;
   - relaciones ya existentes en LGB.

3. Graph scoring:
   - Jaccard/Adamic-Adar/resource allocation para vecindarios;
   - Personalized PageRank desde ciudad seleccionada;
   - random walks cortos limitados por presupuesto;
   - ACO solo si hay un objetivo claro de pathfinding, no para todo.

4. Rerank opcional:
   - mini embeddings locales/cacheados o LLM chico;
   - LLM grande solo para explicar top 5.

5. Output:
   - `Relacion sugerida`;
   - evidencia;
   - score;
   - tipo de relacion;
   - accion: linkear, ignorar, abrir ambos, crear nota.

Tipos de relacion:

- `shared_dependency`
- `shared_entity`
- `temporal_coactivity`
- `conceptual_overlap`
- `imports_or_links`
- `same_lab_family`
- `security_relevance`
- `unknown_but_interesting`

Archivos candidatos:

- En RepoCiv: `server/graph_relations.py`, `server/city_graph_adapter.py`.
- En LGB: adaptador que acepte focus/open messages.
- UI: `src/ui/relationsPanel.ts`, capa `knowledge` en `src/layers.ts`.

Gates:

- No leer todo en cada consulta.
- Indice incremental persistente.
- Cada conexion sugerida debe traer evidencia concreta.
- Usuario puede aceptar/rechazar; eso retroalimenta ranking.

---

### Fase 5 — LabHub / Institutum: avisos automáticos, locks suaves por defecto, acciones fuertes opt-in

Objetivo: que LabHub proteja trabajo vivo sin impedir la operación.

Niveles de intervención (en orden creciente de intrusión):

| Nivel | Default | Descripción |
|-------|---------|-------------|
| Badge informativo | **ON** | Muestra experimento activo, PID, última métrica |
| Warning antes de editar | **ON** | Al intentar ejecutar comando sobre ciudad con experimento vivo |
| Lock suave | **ON** | Sugiere no tocar; permite override con confirmación |
| Lock duro | **OFF** | Bloquea completamente; solo si experimento declara `writeLock: true` |
| Acciones destructivas | **requiere aprobación explícita** | Nunca automáticas: kill, restart, delete |

Contrato LabHub -> RepoCiv:

```json
{
  "cityId": "financial-lab",
  "labId": "hgat-gate4",
  "status": "running",
  "risk": "medium",
  "writeLock": false,
  "lastMetric": "gen=42 best=0.71",
  "startedAt": "2026-05-25T00:00:00Z",
  "links": {
    "labhub": "http://localhost:5281/labs/financial-lab",
    "logs": "file:///..."
  }
}
```

Configuración por defecto:

```ts
labhub: {
  showActiveExperiments: true,
  warnBeforeCityEdit: true,
  softLocks: true,
  hardLocks: false,
}
```

- comparador de experimentos;
- alertas de drift;
- recomendaciones de pausa/restart;
- abrir dashboard lab en iframe;
- ligar eventos LabHub al Event Store de RepoCiv.

Archivos candidatos:

- `server/labhub_adapter.py`
- `src/labStatus.ts`
- `src/ui/labRiskPanel.ts`
- `src/renderer.ts` para badges.
- `server/policy.py` para warnings antes de comandos.

Gates:

- Nunca matar experimentos desde UI sin approval explicita.
- Badge visible pero no ruidoso.
- Si LabHub esta offline, RepoCiv degrada sin romper.

---

### Fase 6 — Agentes-oficio y pedagogia cosmetica

Objetivo: separar utilidad operacional de personalidad pedagogica.

Modelo:

```ts
interface AgentPersona {
  id: string;
  displayName: string;
  historicalSkin?: string;
  office: 'bibliotecario' | 'astronomo' | 'diplomatico' | 'custodio' | 'cartografo';
  capabilities: string[];
  defaultPrompt: string;
  visual: {
    icon: string;
    color: string;
    title: string;
  };
}
```

Primeros oficios:

1. Diplomatico:
   - informes de relaciones exteriores desde Gaceta.

2. Bibliotecario:
   - lectura/organizacion de nodos Bibliotheca.

3. Astronomo:
   - busqueda de conexiones no obvias entre ciudades.

4. Custodio:
   - riesgos LabHub/Muralla, locks suaves.

5. Cartografo:
   - limpieza de mapa, sugerencias de labels/capas.

Skins historicos opcionales:

- Aristoteles: clasificacion y enseñanza conceptual.
- Hipatia: astronomia/conexiones/graph reasoning.
- Maquiavelo: relaciones exteriores e impacto estrategico.
- Kelsen: legal/estructura normativa cuando LexO se integre.
- Feynman: explicacion tecnica en capas.

Regla: skin sin oficio no entra al trunk. Si es solo cosmetico, va detras de feature flag.

---

### Fase 7 — Poda y dogfooding basado en evidencia

Objetivo: evitar que el imperio se vuelva burocracia.

Tareas:

1. Telemetria de paneles.
   - Registrar apertura, duracion, acciones.
   - Archivo candidato: `src/ui/analytics.ts` ya existe; extender.

2. Telemetria de endpoints.
   - Contar rutas llamadas desde frontend.
   - Filtrar smoke/e2e.

3. Reporte semanal local.
   - Paneles 0 uso -> candidatos a ocultar.
   - Endpoints 0 uso -> candidatos a deprecate.
   - Modulos sin impacto -> mover a experimental.

4. Boton `Modo Limpio Permanente`.
   - Si Cristobal lo usa mas que modo completo, el modo limpio pasa a default.

Gates:

- Poda se decide por uso real, no por ansiedad de limpieza.
- Nada se borra sin alternativa o archivo historico si contiene aprendizaje.

---

## 5. Secuencia recomendada de ejecucion

### Sprint A: sanidad y contrato base

1. Fase 0 completa.
2. `WonderManifest` minimo.
3. Migrar Bibliotheca/Institutum al registry.
4. Documentar `WONDER_CONTRACT.md`.

Resultado: RepoCiv deja de tener iframes especiales y empieza a tener plataforma de Maravillas.

### Sprint B: legibilidad visible

1. Capas.
2. Modo limpio.
3. LOD de labels.
4. Foco de seleccion.
5. 2.5D liviano.

Resultado: el producto se siente mucho mas amable sin reescribir renderer.

### Sprint C: Gaceta accionable

1. Arreglar schema CDaily.
2. Repo profile barato.
3. Informe de Relaciones Exteriores.
4. Guardar reportes y linkearlos a ciudad/noticia.

Resultado: Gaceta deja de ser feed y se vuelve inteligencia exterior.

### Sprint D: Bibliotheca conectiva

1. Click derecho: nodo -> ciudad/local view.
2. Ciudad -> nodo Bibliotheca.
3. Indice incremental barato.
4. Agente Astronomo/Bibliotecario con top conexiones.

Resultado: la Biblioteca empieza a descubrir relaciones, no solo mostrarlas.

### Sprint E: Institutum/LabHub util

1. Health/port correcto.
2. Badges de experimento activo.
3. Locks suaves.
4. Panel riesgo de edicion.

Resultado: LabHub protege trabajo vivo.

---

## 6. No hacer todavia

- No meter 3D real al trunk.
- No crear marketplace/plugin store.
- No ejecutar MCP servers externos sin contrato de seguridad.
- No permitir que iframes muten RepoCiv directamente.
- No leer todos los repos completos para cada informe.
- No crear personalidades historicas sin oficio operativo.
- No agregar nuevas Maravillas antes de estabilizar contrato con 2-3 ejemplos reales.
- **No activar features agentivas por defecto.** Todo lo que sugiera, analice o
  automatice debe empezar OFF y requerir opt-in del usuario.
- No generar Informes de Relaciones Exteriores automáticamente.
- No sugerir relaciones de Bibliotheca sin que el usuario lo active.

---

## 7. Definicion de done para esta etapa

La etapa esta lista cuando:

1. RepoCiv abre con modo limpio legible.
2. Bibliotheca e Institutum usan el mismo contrato de Maravilla.
3. Gaceta muestra noticias sin análisis agentivo por defecto. El Informe de Relaciones
   Exteriores existe pero requiere acción explícita del usuario.
4. Bibliotheca permite navegación visual sin sugerencias AI por defecto. Las relaciones
   sugeridas existen pero requieren opt-in.
5. El Astronomo/Bibliotecario produce conexiones sugeridas con evidencia sin leer
   todo cada vez, solo cuando el usuario lo activa.
6. LabHub muestra badge de experimento activo y warning de edición por defecto.
   Locks duros y acciones destructivas requieren confirmación explícita.
7. Todas las features agentivas respetan el principio de opt-in: nada se activa
   sin que el usuario lo habilite.
8. Health/check/lint/tests estan verdes o las excepciones estan documentadas.
9. La telemetria de uso permite decidir que paneles sobran.

---

## 8. Nota de direccion

La forma correcta de subir RepoCiv de 8 a 9 no es mas epica. Ya hay epica.

La subida viene de que el usuario pueda mirar el mapa tres segundos y entender:

- que ciudad importa;
- que maravilla tiene informacion;
- que agente puede responder;
- que accion es segura;
- que cosa conviene no tocar.

Eso es el producto.

El resto es decoracion, incluso cuando la decoracion es bonita.
