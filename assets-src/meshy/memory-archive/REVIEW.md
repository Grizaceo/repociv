# Archivo de memoria v001: evaluación del piloto

Estado: geometría generada y descargada; candidato NO aprobado ni integrado.

## Evidencia real

- Tarea Meshy: `01a16598-3b66-715c-8f9c-f4d6b673b9b4`, estado `SUCCEEDED`.
- Modelo solicitado: `meshy-t2.5`, Smart Topology, objetivo 4000 triángulos.
- Consumo declarado por la tarea: 5 créditos. Saldo antes: 1100; saldo tras generación: 1095. No se ejecutó refine.
- GLB: 71976 bytes, 1 mesh, 3732 triángulos, 0 materiales. Checksum en `geometry-audit.json`.
- PNG del proveedor descargado e inspeccionado visualmente. Esto NO equivale a prueba en el renderer de RepoCiv ni certifica el GLB completo.

## Lectura visual

El preview muestra un edificio compacto de varios niveles, acceso frontal con escalera curva, cubiertas amplias escalonadas y una pequeña torre abierta en la cima. La silueta principal es reconocible; hay una base poligonal y volumen suficiente para un edificio singular. La imagen está sin texturas, así que no demuestra la paleta propuesta.

Desviaciones del brief: se parece más a un pabellón/templo fantástico que a un archivo. Los aleros dominan; no se distinguen claramente estratos de almacenamiento o nichos de memoria. Hay pequeños detalles de soporte y salientes que pueden perderse al alejar la cámara. La base parece sobredimensionada respecto del acceso. La torre-linterna existe en forma, pero su función no se comunica todavía.

Decisión: conservar como exploración geométrica, no aprobar como identidad definitiva. No gastar en texturizado para ocultar una ambigüedad de silueta. Antes de otra generación, Cristóbal debe decidir si conserva la dirección arquitectónica o exige un archivo más distintivo y menos ceremonial.

## Aprobación y texturizado posterior

Cristóbal aprobó expresamente la geometría como edificio y autorizó el texturizado. La crítica anterior se conserva como evaluación inicial, no como veto a esa decisión.

Refine confirmado `SUCCEEDED`: tarea `01a165a1-e402-73ab-9253-e4b3ad030260`, heredando el modelo del preview, resolución 2K, PBR solicitado. Una sola petición, sin regenerar intencionalmente la geometría. Consumo: 10 créditos; saldo antes 1095, después 1085. Total del piloto: 15 créditos.

Artefactos locales ignorados por Git: `textured/archive-textured.glb` y `textured/archive-textured.png`. Auditoría estructural: 6942508 bytes, 3730 triángulos, 1 mesh y 1 material. El refine no conservó exactamente el recuento de 3732 triángulos del preview; no se afirma identidad binaria o topológica entre ambos.

Inspección del thumbnail: paredes claras ligeramente cálidas y cubiertas azul pizarra bien diferenciadas. Puerta, paño superior y coronamiento muestran marrones/cobrizos; el thumbnail no demuestra metal envejecido ni un efecto ámbar luminoso convincente. Se observan zonas de borde y ménsulas que merecen revisión cercana. La paleta tiene buena separación visual, pero la intención del prompt no se da por cumplida en todos sus detalles.

El GLB texturizado pesa considerablemente más que la geometría inicial: NO instalar como prop masivo sin medir memoria, texturas y draw calls. No se ha verificado aún dentro de RepoCiv ni se han aclarado los términos de distribución. Geometría aprobada por el usuario; texturizado pendiente de revisión del usuario.

## Pendiente verificable

- Normalización de ejes, base al suelo y escala; no solicitadas como operación de autosizing ni verificadas geométricamente todavía.
- Inspección posterior y lateral; un thumbnail frontal no cubre el modelo entero.
- Revisión en cámara macro real y prueba de integración opt-in.
- Condiciones de licencia/distribución de los assets generados para esta cuenta.
- Aprobación humana antes de nuevas peticiones pagadas.
