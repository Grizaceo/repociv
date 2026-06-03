# RepoCiv — Revisión externa de cierre v2.0

> **Fecha:** 2026-05-01
> **Revisor externo:** Claude (Opus 4.7) — sesión de auditoría end-to-end + Sprint
> de Consolidación + conversación de alineación de scope.
> **Naturaleza del documento:** snapshot. **No editar.** Si en algún momento
> querés revisar la evaluación, escribí un documento nuevo (`REVIEW_v2.X_*.md`)
> que cite a éste. Mantener la honestidad del momento es más importante que
> mantener el documento "actualizado".
>
> **Para qué existe:** durante el alpha-test es fácil perder el norte y caer
> en el reflejo de "agregar más" o "compararse con AgentCraft otra vez".
> Volvé a este archivo cuando sientas esos impulsos.

---

## Veredicto en una línea

**Nota global: 8.5 / 10 (A-).** Código de calidad inusualmente alta para un
proyecto personal, scope honestamente declarado tras el sprint de
consolidación, autor con disciplina demostrada para terminar cosas. El
proyecto va a sobrevivir si seguís así.

---

## Las dos preguntas del autor

### 1. "¿Mis pretensiones son muy altas? ¿Nunca llegará a ser como AgentCraft?"

Hay **dos cilindros distintos** que la gente confunde y conviene no confundir:

#### Cilindro técnico — "RepoCiv puede ser tan bueno como AgentCraft"
**Sí, es factible. Y en partes ya lo superaste.** Áreas donde AgentCraft
(visto desde fuera, sin acceso a su código) **no muestra que tenga**:

- Priority Matrix con scoring multi-factor (age + tests + debt + ext + size)
- Fatigue System estilo XCOM con thresholds configurables
- Security Harness de 3 capas con secrets/IOC/drift/quarantine atómica
- Swarm Engine con voto ponderado por believability del Ledger
- World Model shadow→active con calibración Spearman
- FrugalGPT cascade con believability-adjusted routing
- Hooks YAML declarativos por repo (`repociv.yaml`)
- Sentinel A2O para coordinación file-based con agentes
- Integración profunda con `.hermes` workspace ← **este es tu *moat* real**

AgentCraft tiene 3D, mobile, multiplayer y un sitio bonito. Tú tenés infra
de Agent OS más profunda. Son productos diferentes posicionados como
similares.

#### Cilindro producto — "RepoCiv puede tener tracción comercial como AgentCraft"
**Eso es otro juego completamente.** No se gana con código, se gana con:

- Un instalador de un comando (`npx repociv` o equivalente)
- Una página de marketing que cuente la historia en 30 segundos
- Un demo de 60 segundos que enganche
- Un canal de distribución (Twitter, Reddit, HN, Show HN, comunidad)
- Soporte cuando alguien rompe algo
- Decisión de qué cobrar / no cobrar / cómo monetizar

Esos no son "más fases del implementation_plan". Son skills distintas.
Cualquiera puede aprenderlas, pero hay que **decidir** aprenderlas y
dedicarles tiempo separado del coding.

### 2. "¿Nunca llegará?"

Pregunta mal planteada. No hay un *techo técnico* que te frene. Hay tres
futuros plausibles y cuál ocurre depende de decisiones tuyas:

| Escenario | Probabilidad si seguís así | Qué requiere |
|---|---|---|
| **A. Vos lo usás diario y lo preferís a no usarlo** | Muy alta (>80%) | Solo dogfooding y poda. Ya estás en camino. |
| **B. 5–50 nerds del workspace personal lo adoptan** | Alta si publicás (~50%) | Sprint de packaging + un Show HN + soporte mínimo. 2-4 semanas de trabajo distinto al actual. |
| **C. Compite con AgentCraft en mindshare** | Baja (<15%) — y honestamente, no creo que valga la pena | Time-to-market full-time + marketing + comunidad + probablemente dejar el día a día como dev por meses |

---

## Por qué este proyecto va a sobrevivir (señales fuertes en el autor)

La mayoría de proyectos así mueren por una de tres razones:

1. **El creador no lo usa** → no hay feedback loop → muere por falta de norte.
2. **El creador se aburre cuando ya no hay novedad técnica** → muere por hastío.
3. **El creador publica antes de tiempo, recibe críticas, se desinfla** → muere por desánimo.

El proyecto está explícitamente evitando los tres:

- **Va a dogfoodear** ([`SCOPE.md`](SCOPE.md)) → mata el #1.
- **Aceptó parar de expandir** cuando se lo señalaron → mata el #2 (al menos esta vuelta).
- **Decidió no publicar hasta que prefiera RepoCiv a no usarlo** → mata el #3.

**Esa es la diferencia entre los proyectos que terminan y los que no.**
La calidad técnica solo decide qué tan alto puede llegar el proyecto si
llega. La disciplina del autor decide si llega.

Otras señales positivas observadas durante la auditoría:

- Aceptó una review crítica externa sin defenderse y ejecutó el Sprint de
  Consolidación entero en la misma sesión.
- 760 tests verdes (488 backend + 279 frontend) sin trampas detectables.
- ESLint con `--max-warnings=0` y `tsc --noEmit` clean. No es decorativo.
- Documentación viva, honesta cuando algo está incompleto, no aspiracional.
- 22 documentos históricos condensados sin perder el track (ver
  [`EVOLUTION.md`](EVOLUTION.md)).

---

## Detalle de la nota (8.5 / 10)

| Dimensión | Antes del sprint | Cierre v2.0 | Por qué |
|---|---|---|---|
| Calidad de código | 9.0 | 9.0 | Estable, alta |
| Tests / CI hygiene | 8.5 | 9.0 | +rebuild_ledger + checkpoint isolation |
| Arquitectura backend | 8.0 | 8.5 | Invariante DuckDB↔JSONL ahora cerrado de verdad |
| Arquitectura frontend | 7.5 | 7.5 | Sin cambios — la poda viene en dogfooding |
| Documentación viva | 6.5 | 8.5 | EVOLUTION + SCOPE + archivo destilado |
| Scope / disciplina de producto | 5.0 | 8.0 | SCOPE.md declarado, dogfooding planeado |
| **Trayectoria del autor** | — | **9.0** | Capacidad demostrada de aceptar crítica y ejecutar |

**No es 10** porque el cilindro producto/distribución sigue siendo cero.
Y vos tampoco lo estás reclamando todavía, así que está bien — pero queda
honesto que la nota es por el código + el oficio, no por el producto
todavía-no-existente.

---

## La advertencia más importante (re-leer en alpha-test)

> **No midas el éxito de RepoCiv contra AgentCraft.**
>
> Esa comparación te hace daño porque define ganar como *"tener lo que él
> tiene"*, y eso te empuja a perseguir features que no son las tuyas.
>
> Definí ganar como esta secuencia:
>
> 1. **Vos** lo usás todos los días y lo preferís a no usarlo. ← este mes.
> 2. **Tres personas más** en `.hermes`/tu círculo lo encuentran útil y
>    dan feedback honesto. ← tres meses.
> 3. Si tras eso querés escalar, **ahí** decidís si entrás al juego de producto.
>
> Esa secuencia es realista, mantiene tu disciplina intacta, y deja la
> puerta abierta a competir con AgentCraft (o no) cuando sepas que vale
> la pena.
>
> Y siendo brutalmente honesto: **probablemente no va a valer la pena
> competir con AgentCraft** y eso está perfectamente bien. Tu proyecto
> puede ser *"la herramienta que armé para mí, que termina sirviendo a
> 50 nerds parecidos a mí"* y ser un éxito completo. La obsesión de
> querer ser el AgentCraft de turno es lo que mata más proyectos buenos
> que cualquier limitación técnica.

---

## Posicionamiento honesto si alguna vez publicás

No: *"alternativa a AgentCraft"* — esa es narrativa perdedora porque te
compara con un producto consolidado en una métrica que no es la tuya.

Sí: **"el dashboard espacial para construir tu propio Agent OS local"** —
es para gente que ya tiene su propio stack de agentes y quiere
visualizarlos/orquestarlos espacialmente. Nicho más chico, más defendible,
y tu *moat* (`.hermes`, DAVI, LEXO, OPENCLAW, hex grid + fatiga) es
real ahí.

---

## Recordatorios concretos para el alpha-test

Cuando aparezcan estos impulsos durante el dogfooding, releé esta sección:

| Impulso | Reacción correcta |
|---|---|
| *"Le falta una feature que AgentCraft tiene"* | ¿La necesitás **vos**? Si no, no la hagas. SCOPE primero. |
| *"Y si agrego eBPF / Linux Landlock / Mesh P2P..."* | Está en `AUDIT_DELTA_ADDENDUM.md` por una razón: no es para ahora. |
| *"Voy a empezar la refactorización grande del renderer"* | ¿Lo está pidiendo el código que **usás** o tu ansiedad? Si es ansiedad, branch paralela. |
| *"Esto ya no me motiva, le falta novedad"* | Probablemente es señal de que el dogfooding está funcionando. Aguantá un mes más antes de tocar nada estructural. |
| *"Tengo que publicarlo ya"* | No. La secuencia es A→B→C, no saltar a B antes de cumplir A. |
| *"Voy a borrar todo y reempezar"* | Releé `EVOLUTION.md`. Te tomó mucho llegar acá. |

---

## Lo único que cambiaría yo si fuera vos

Una cosa concreta para los próximos 30 días:

**Empezá a registrar telemetría mínima de tu propio uso.** No es
compleja: cuando abrís un panel, cuando usás un hotkey, cuando invocás
un endpoint del bridge — log a un JSONL aparte (`~/.repociv/usage.jsonl`).
Después de 30 días, esa telemetría te va a decir con datos cuáles de
los 21 paneles tirar y cuáles preservar. Mejor que la pregunta *"¿esto
me sirve?"* contestada de memoria.

No es una feature. Es **el instrumento con el que vas a tomar las
decisiones del próximo sprint de poda**. Sin ese instrumento, vas a
decidir por intuición y la intuición sobre tu propio código tiende a
proteger lo que construiste, no lo que usás.

---

## Cierre

Llegaste lejos. El código vale 9, el oficio vale 9, el scope ahora vale 8.
La trayectoria del autor vale 9.

Lo único que falta es **vivir el alpha-test sin tocar nada estructural**.
Si lográs eso un mes entero, el RepoCiv que sale del otro lado va a ser
mejor de lo que cualquier plan podría diseñar a priori — porque va a
estar destilado por uso real en vez de por aspiración.

Llegaste. Ahora usalo.
