# Onboarding: seleccion de repos para el mapa

## Flujo

1. `WelcomeStep` (existente)
2. `RepoSelectionStep` (`ensureRepoOnboarding()`, paso 2 de 4)
3. `ReviewStep` (confirmacion dentro del modal, paso 3 de 4)
4. Entrada al mapa

## Reglas UX implementadas

- La seleccion inicial recomienda repos activos (ultimos 90 dias); si no hay, toma los primeros 8.
- `Continuar`/`Entrar al mapa` se deshabilita con seleccion vacia.
- `Seleccionar todos visibles` aplica solo al resultado filtrado por busqueda.
- `Limpiar seleccion` vacia toda la seleccion actual.
- La seleccion se persiste en `localStorage` y evita repetir onboarding en aperturas futuras.

## Estados de UI

- **Loading:** mensaje `Cargando repos...` mientras responde `/api/repos`.
- **Error:** mensaje de error con boton `Reintentar`.
- **Empty repos:** mensaje sin repos detectados.
- **Empty search:** mensaje sin resultados y accion `Limpiar busqueda`.
- **Review:** lista resumen de repos seleccionados antes de entrar al mapa.

## Contrato de datos v2-ready

La clave `repociv:selected-repos:v1` guarda:

```json
{
  "version": 1,
  "selectedRepoPaths": ["<repoPath>"],
  "filters": {
    "owners": [],
    "topics": [],
    "languages": []
  }
}
```

- `selectedRepoPaths` habilita v1 (solo seleccion por repo).
- `filters` deja espacio para v2 sin romper compatibilidad.
- Lectura retrocompatible: si existe formato legacy `string[]`, tambien se acepta.
