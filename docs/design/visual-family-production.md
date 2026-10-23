# RepoCiv — colección de identidad visual

## Estado vigente (2026-10-23)

Las etiquetas «Propuesto» de la tabla inferior son históricas. Prevalecen las fichas `spec.json` y las actas. Detalle de materiales y runtime: [visual-family-materials-review.md](visual-family-materials-review.md).

| ID | Concepto | Geometría | Materiales | Runtime |
| --- | --- | --- | --- | --- |
| memory-archive | Aprobado | Aprobada | Aprobados | Integrado en `public/assets/3d/props/meshy/` (por defecto) |
| observatory | Aprobado | Aprobada | Aprobados | Integrado en `public/assets/3d/props/meshy/` (por defecto) |
| coordination-court | Aprobado | repair-v003 aprobada | Aprobados | Integrado en `public/assets/3d/props/meshy/` (por defecto) |
| connection-gateway | Aprobado | Aprobada | Aprobados | Integrado en `public/assets/3d/props/meshy/` (por defecto) |
| artifact-vault | Aprobado | repair-v003 aprobada | Aprobados | Integrado en `public/assets/3d/props/meshy/` (por defecto) |
| research-laboratory | Aprobado | repair-v003 aprobada | Aprobados | Integrado en `public/assets/3d/props/meshy/` (por defecto) |
| civic-plaza | Aprobado | Aprobada | Aprobados | Sin consumidor (aprobado sin mapeo) |
| execution-workshop | Aprobado | repair-v003 aprobada | Pendiente (10 créditos, confirmar envío) | Kenney conservado |

Gasto de la tanda de materiales: 50 créditos (cinco Retexture de 10), saldo 552 → 502. Materiales, mapeo de servicios y escala aprobados por Cristóbal e integrados por defecto en RepoCiv.

## Encargo y estado

Cristóbal solicita pasar de las tres muestras a crear la familia de assets que dé identidad a RepoCiv. Este documento concreta una propuesta de colección y secuencia; no constituye aprobación de su catálogo ni autorización de gasto. Archivo y Observatorio aprobados artísticamente. Taller: concepto aprobado, geometría rechazada, reparación expresamente diferida. Mantener originales, sin integrar, publicar ni generar automáticamente.

## Autorización posterior

Cristóbal autorizó la ronda propuesta y expresó que prioriza que RepoCiv quede precioso, sin necesidad del tope de créditos propuesto. Mantener responsabilidad de gasto, registro del consumo y controles anti-duplicación. Empezar mostrando el Patio antes de los otros cuatro conceptos, como se propuso; esta autorización no equivale a aprobación artística anticipada de conceptos, geometrías o texturas ni levanta el diferimiento del Taller.

## Lenguaje común

Ciudad del conocimiento vivo, no reino medieval genérico. Piedra caliza cálida como masa; pizarra oscura para cubiertas; cobre envejecido en piezas estructurales y coronamientos. Ámbar para actividad; turquesa para observación y conexiones. Volúmenes escalonados, aleros sustanciales y base compacta. Cada función se reconoce en silueta sin depender del color. Usar la imagen real del Archivo aprobado como referencia de conceptos; el Observatorio aporta contraste vertical, no una segunda plantilla obligatoria.

Superficies cerradas, ventanas como paneles hundidos, piezas gruesas conectadas. Sin filigranas, texto, logos, suciedad fotográfica ni iluminación dramática horneada. Bases arquitectónicas discretas: no generar un hexágono de terreno que oculte el tile existente.

## Colección arquitectónica propuesta

Los cinco miembros nuevos son propuestas de diseño, no funciones de software ya implementadas.

| ID | Función visual | Silueta propia | Estado |
| --- | --- | --- | --- |
| memory-archive | Memoria | Terrazas escalonadas y coronamiento compacto | Aprobado |
| execution-workshop | Ejecución | Dos alas bajas, entrada amplia, chimenea corta | Reparación diferida |
| observatory | Observación | Torre esbelta y lente integrada | Geometría y PBR aprobados |
| coordination-court | Coordinación | Conjunto horizontal en U, patio amplio y sala central baja; no otra torre | Propuesto, siguiente |
| connection-gateway | Conexiones | Dos pilares macizos y dintel bajo, vano único legible, detalles turquesa restringidos | Propuesto |
| artifact-vault | Artefactos/resultados | Volumen ancho y bajo, muros gruesos y portal profundo; cubierta escalonada casi cerrada | Propuesto |
| research-laboratory | Investigación | Dos pabellones asimétricos alrededor de una cámara de ensayo robusta; sin lente ni chimenea de fábrica | Propuesto |
| civic-plaza | Espacio común | Plaza baja escalonada con mesa circular de piedra y señal central pequeña; sin torre ni templo | Propuesto |

No comprar texturas para salvar una silueta ambigua. El patio del conjunto de coordinación es espacio abierto intencional; las cubiertas de sus alas deben ser cerradas. Evitar puentes finos y columnas diminutas durante reconstrucción.

## Olas posteriores

1. Asentamientos: pequeño núcleo, barrio, ciudad y capital construidos con módulos comunes, no cuatro estilos independientes. El catálogo existente contiene city-hamlet, city-village, city-town y city-capital; el consumidor CityProps3D tiene recetas por nivel, que requieren auditoría antes de sustituir assets.
2. Kit urbano compartido: caminos/bordes, escaleras, muros bajos, puente robusto, farola, señal y cajas. Preferir construcción local determinista de piezas simples y repetibles, reservando Meshy para siluetas principales.
3. Habitantes/agentes: identificar roles reales antes de definir personajes; una misma anatomía y proporciones, herramientas y accesorios por función, sin convertir el sistema en ejército de fantasía. Rigging y animación fuera del presupuesto arquitectónico.
4. Entorno: armonizar vegetación, rocas, terreno e iluminación después de validar una pequeña escena de familia; no regenerar todo por defecto.

Inventario consultado: public/assets/3d/props y consumidores src/three/CityProps3D.ts, WonderProps3D.ts y UnitProps3D.ts. Inventario de archivos no implica aceptación visual ni compatibilidad de los reemplazos.

## Producción por etapas y coste propuesto

Fuente consultada: https://docs.meshy.ai/en/api/pricing

Cinco conceptos nuevos, una petición Image-to-Image nano-banana-pro por miembro: 9 créditos cada uno, máximo 45. Primera opción recomendada: producir y revisar únicamente coordination-court (9 créditos), antes de autorizar el resto del lote. No hay gasto autorizado mediante este documento.

Después de aprobación humana de conceptos y autorización separada: Image-to-3D meshy-t2.5 sin texturas, 5 por miembro (25 para los cinco). Después de revisión humana de cada geometría: Retexture 2K PBR, 10 por miembro (50 para los cinco). Total orientativo si los cinco superan todas las etapas sin variantes: 120 créditos. Excluye reparación del Taller, unidades, animaciones, reintentos y optimización. No presentar el saldo histórico de 1047 como consulta actual.

No agrupar concepto, geometría y textura en una operación automática. Saldo gratuito antes y después, solicitud exacta persistida, marcador exclusivo y tarea por asset/etapa; nunca reintentar un POST incierto. No borrar locks anteriores.

## Siguiente brief: Patio de coordinación

Una construcción compacta horizontal, tres alas gruesas en U alrededor de un patio abierto y una mesa central de piedra integrada en el suelo. Sala de reunión central baja y algo más ancha; cubiertas de pizarra cerradas, aleros de cobre y piedra clara compatibles con el Archivo. Entrada amplia visible desde cámara isométrica. La masa y el patio expresan coordinación: sin torre de observación, chimenea, biblioteca, engranajes ni símbolos textuales. Sin mobiliario menudo, barandillas, puentes finos, figuras ni terreno exterior. El hueco del patio debe leerse desde arriba y no confundirse con una cubierta rota.

## Aceptación

Mostrar concepto real junto al Archivo antes de generar 3D. Revisar frente, trasera, laterales y vista elevada de la geometría antes de texturizar. Comparar también siluetas pequeñas y monocromas. Mantener aprobación artística, conformidad técnica y aceptación en runtime separadas. Crear escena de conjunto con escala/cámara/iluminación comunes antes de reemplazar assets. Optimizar copias, comprobar origen al suelo, peso de texturas, draw calls y fallback. Licencia y distribución siguen pendientes de verificación para la cuenta. Ningún cambio al bridge ni al orquestador forma parte de este encargo artístico.
