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

## Pendiente verificable

- Normalización de ejes, base al suelo y escala; no solicitadas como operación de autosizing ni verificadas geométricamente todavía.
- Inspección posterior y lateral; un thumbnail frontal no cubre el modelo entero.
- Revisión en cámara macro real y prueba de integración opt-in.
- Condiciones de licencia/distribución de los assets generados para esta cuenta.
- Aprobación humana antes de nuevas peticiones pagadas.
