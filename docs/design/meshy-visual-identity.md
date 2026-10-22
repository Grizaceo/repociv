# RepoCiv: identidad visual propia mediante Meshy

## Encargo y frontera

Objetivo autorizado: desarrollar una identidad visual propia para RepoCiv mediante assets 3D ad hoc. Rama: `feat/meshy-visual-identity`. El worktree parte de `1240ad7`; los cambios sin confirmar de main NO están incluidos ni se modifican. No hay push, merge, despliegue ni sustitución masiva de assets.

## Dirección propuesta: ciudad del conocimiento vivo

No imitar Civilization ni convertir el workspace en una ciudad medieval genérica. RepoCiv es una infraestructura cognitiva habitable: repos como barrios, agentes como habitantes, memoria como archivo, ejecución como taller y observación como torre.

Gramática compartida propuesta, pendiente de aprobación visual:

- Piedra caliza cálida y cerámica oscura como masa principal; cobre envejecido como estructura; ámbar como señal de actividad. Turquesa reservado a conexiones y observación, nunca color decorativo indiscriminado.
- Bases hexagonales compactas, volúmenes escalonados y una silueta dominante por función.
- Archivo/memoria: estratos, nichos y torre-linterna. Ejecución: bancada y cubierta abierta. Observación: lente y balcón. Coordinación: patio y puentes. No generar todavía estas familias secundarias.
- Detalle concentrado en puertas, cubiertas y coronamientos; nada de microtexto, logotipos o partículas horneadas.
- Legibilidad desde cámara elevada y a escala real del mapa; no basta una captura de primer plano.
- Colores de identidad y estado se aplican por materiales concretos, no tiñendo todo el modelo.
- Mantener contraste y señales de forma: el color por sí solo no identifica función ni estado.

## Piloto: Archivo de memoria

Un edificio estático, aislado y sin personajes. Geometría Smart Topology T2.5, objetivo 4000 triángulos, GLB. Esta primera fase es un preview SIN texturas; la paleta anterior es la intención para una fase posterior, no una propiedad ya demostrada del preview.

El prompt público es original y no contiene nombres de repos privados, rutas locales, transcripciones ni datos del workspace. Solo ese prompt y sus parámetros se envían a Meshy.

## Presupuesto y seguridad

Saldo inicial consultado: 1100 créditos, todos mensuales. Autorizar la rama no equivale a autorizar gastar el saldo entero. Este piloto se limita a UNA petición de preview (precio anunciado: 5 créditos). Sin reintentos POST, sin refine, sin variantes automáticas. Reconciliar `consumed_credits` y saldo tras la tarea. Un POST con resultado incierto requiere inspección manual antes de cualquier nueva generación.

Credencial exclusivamente en el .env local de Hermes o en MESHY_API_KEY; jamás en JSON versionado, argumentos o logs. El MCP de la sesión no cargó la clave: el piloto usa el endpoint REST oficial con la misma credencial, sin modificar Hermes.

## Flujo y entregables

1. Especificación versionada en `assets-src/meshy/memory-archive/spec.json`.
2. Generación única y reanudable por ID con `scripts/meshy/pilot.py`. Requiere Python y python-dotenv; en este host usar el Python del venv de Hermes.
3. Candidato descargado bajo `assets-src/meshy/memory-archive/`, fuera de `public/`: no entra al juego por accidente.
4. Metadatos sin secretos: ID, estado, consumo declarado, balances y checksum del GLB. Las URLs temporales del proveedor no se versionan.
5. Revisar geometría visualmente antes de texturizar. Hasta entonces el estado es candidato, no asset aprobado. Los binarios, el estado de la tarea, el lock y la auditoría quedan ignorados por Git; solo se versionan especificación, evaluación y herramientas. El lock local debe conservarse para prevenir duplicación de gasto. Al clonar esta rama no se hereda ese lock: NO ejecutar `--generate` para intentar recuperar el modelo existente; recuperar primero el ID de tarea documentado en REVIEW.md.
6. Tras aprobación: texturas/materiales, normalización de orientación y origen, preview en forge, prueba opt-in en runtime y evaluación A/B a escala real.

Para ejecutar por primera vez: `python scripts/meshy/pilot.py --generate`. Para reanudar/consultar/descargar: `python scripts/meshy/pilot.py`. La marca de envío impide duplicar gastos, incluso ante un timeout de creación. No borrar esa marca para forzar un reintento: investigar primero la cuenta.

## Puertas de aceptación

- Técnico: GLB válido, sin referencias externas inesperadas, geometría y materiales auditados, escala consistente y base al suelo; comprobar recuento real de triángulos, no asumir que el objetivo se cumplió.
- Visual: reconocer archivo a escala macro, coherencia con la gramática, ausencia de ruido de silueta, contraste día/noche. Revisión humana antes de multiplicar familias.
- Rendimiento: comparar draw calls, memoria de texturas y fluidez con baseline; no prometer compatibilidad de instancing por recibir un GLB.
- Procedencia: registrar fuente, modelo, prompt, tarea, transformaciones y condiciones de licencia verificadas para la cuenta. NO heredar automáticamente la licencia MIT del código; distribución bloqueada hasta resolver los términos aplicables.
- Integración: conservar fallback actual y rollback por manifiesto; sin nuevas mecánicas ni cambios al bridge/orquestador.

## Secuencia global, no ejecutada todavía

A. Aprobar lenguaje y Archivo. B. Auditar catálogo existente y mapear funciones a siluetas. C. Crear familia mínima consistente (archivo, taller, observatorio, coordinación). D. Diseñar unidades después de edificios, con identidad por función y animación presupuestada. E. Unificar terreno, iluminación y UI sin romper legibilidad. F. Dogfooding, comparativa y eventual merge autorizado.

Condición de término global: catálogo coherente y probado dentro de RepoCiv, no una carpeta de modelos inconexos. Este commit inaugura esa línea de trabajo; no declara terminada la renovación.

## Fuentes oficiales consultadas

- https://docs.meshy.ai/en/api/ai
- https://docs.meshy.ai/en/api/balance
- https://docs.meshy.ai/en/api/text-to-3d
