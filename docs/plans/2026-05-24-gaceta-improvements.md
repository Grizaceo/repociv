# Plan de Implementación: Mejoras en la Gaceta (CDaily) — RepoCiv

Este plan propone mejoras robustas y sencillas (KISS) para la integración de la **Gaceta** en RepoCiv, cubriendo:
1. Redimensionamiento libre de la ventana.
2. Botón de actualización de noticias (escaneo directo de `blogwatcher-cli`).
3. Categorías dinámicas en la parte superior con filtrado instantáneo.

---

## Propuesta de Cambios

### 1. Ventana Redimensionable a Gusto

Actualmente, el widget `#gaceta-widget` alterna estrictamente entre `max-height: 48px` (colapsado) y `max-height: 420px` (expandido) usando CSS estático.

#### [MODIFY] `src/styles/gaceta.css`
* Cambiaremos `#gaceta-widget` para usar un layout de tipo **Flexbox** vertical, lo que permite que el cuerpo (`.gaceta-body`) se adapte dinámicamente al tamaño del contenedor padre.
* Añadiremos soporte nativo para redimensionamiento en el estado expandido:
  ```css
  #gaceta-widget {
    display: flex;
    flex-direction: column;
    /* ... resto de propiedades existentes ... */
  }

  #gaceta-widget.gaceta-expanded {
    resize: both; /* Permite redimensionar ancho y alto */
    overflow: hidden; /* Requerido por el navegador para activar el resize nativo */
    min-width: 280px;
    min-height: 180px;
    max-width: 600px;
    max-height: 800px;
    height: 420px; /* Tamaño inicial por defecto */
  }

  .gaceta-body {
    flex: 1; /* Rellena todo el espacio disponible */
    overflow-y: auto; /* Scroll vertical interno */
  }
  ```
* Cuando el widget se colapse (`.gaceta-collapsed`), desactivaremos `resize` para retornar a la barra fija superior de 48px de alto y 320px de ancho.

---

### 2. Actualización de Noticias (Scan) desde la Ventana

Para permitir la sincronización bajo demanda sin depender de que el backend de `cdaily` esté levantado, ejecutaremos directamente el comando de escaneo del CLI.

#### [MODIFY] `server/http_routes.py`
* Añadiremos una nueva ruta POST `/api/news/scan` que ejecuta `blogwatcher-cli scan` a través de Python `subprocess`:
  ```python
  def post_news_scan(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, Any]:
      try:
          import subprocess
          result = subprocess.run(
              ["blogwatcher-cli", "scan"],
              capture_output=True,
              text=True,
              timeout=120
          )
          ok = result.returncode == 0
          return 200, {
              "ok": ok,
              "stdout": result.stdout,
              "stderr": result.stderr,
              "returncode": result.returncode
          }
      except FileNotFoundError:
          return 200, {"ok": False, "error": "blogwatcher-cli no encontrado en el PATH"}
      except subprocess.TimeoutExpired:
          return 200, {"ok": False, "error": "El escaneo expiró (timeout > 120s)"}
      except Exception as e:
          return 500, {"error": f"Error interno: {str(e)}"}
  ```

#### [MODIFY] `server/bridge.py`
* Registraremos la ruta POST en el mapeo `_POST_EXACT`:
  ```python
  "/api/news/scan": _routes.post_news_scan,
  ```

#### [MODIFY] `src/bridge.ts`
* Exportaremos una nueva función auxiliar para invocar el escaneo:
  ```typescript
  export async function scanNews(): Promise<{ ok: boolean; error?: string }> {
    try {
      const token = (window as any).VITE_BRIDGE_TOKEN || '';
      const res = await fetch('/api/news/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RepoCiv-Token': token,
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return (await res.json()) as { ok: boolean; error?: string };
    } catch (e: any) {
      return { ok: false, error: e.message || 'Error de red' };
    }
  }
  ```

#### [MODIFY] `src/ui/gacetaWidget.ts`
* Añadiremos un botón de recarga `🔄` o `sync` en la cabecera `.gaceta-header` (al lado del chevron) o en el cuerpo.
* Al hacer click en el botón de actualización:
  1. Pondremos el botón en un estado activo/animado (haciendo que el icono gire).
  2. Llamaremos a `scanNews()`.
  3. Al completar, invocaremos a `_refresh()` para traer los nuevos artículos inmediatamente y desactivaremos la animación.

---

### 3. Categorías de Noticias y Filtrado

Haremos que el backend provea la categoría de cada noticia leyendo las configuraciones compartidas de CDaily, y el frontend ofrecerá un filtrado instantáneo tipo "chips".

#### [MODIFY] `server/http_routes.py`
* Cargaremos de forma segura el mapeo de categorías y emojis desde `../cdaily/config.yaml`.
* Si no se encuentra el archivo o falla, usaremos los diccionarios por defecto idénticos a los de CDaily.
* Ampliaremos el límite de consulta en `get_latest_news` de **5 a 15 artículos** para asegurar que haya variedad para el filtrado.
* Retornaremos en el JSON de cada artículo: `"category"` (ej. `security`) y `"emoji"` (ej. `🔐`).

#### [MODIFY] `src/ui/gacetaWidget.ts`
* Añadiremos una barra horizontal de categorías en el DOM superior de `.gaceta-body`:
  ```html
  <div class="gaceta-categories"></div>
  ```
* En el CSS (`gaceta.css`), crearemos estilos premium para estos chips horizontales con scroll de desbordamiento horizontal suave.
* En `gacetaWidget.ts`, mantendremos un estado local: `let _selectedCategory = 'all';`.
* Al refrescar las noticias:
  1. Extraeremos de forma dinámica todas las categorías únicas presentes en la lista de artículos cargados.
  2. Renderizaremos los chips de categoría correspondientes: `[Todo]`, `[🔐 Seguridad]`, `[💻 Tech]`, etc.
  3. Al presionar una categoría, actualizaremos `_selectedCategory` y re-renderizaremos la lista aplicando un filtro local instantáneo (mostrando los primeros 5 artículos de esa categoría seleccionada).

---

## Plan de Verificación

### Pruebas Automatizadas
* Añadir un test en `server/test_cdaily_bridge.py` para asegurar que el endpoint POST `/api/news/scan` se ejecuta correctamente y gestiona bien los fallos de subprocess o timeouts.
* Verificar lints y tipos con `npm run build` o `npx tsc`.

### Verificación Manual
1. Levantar el bridge y frontend de RepoCiv.
2. Expandir el widget de Gaceta y comprobar que arrastrando la esquina inferior derecha el panel se redimensiona fluidamente en alto y ancho.
3. Colapsar el widget y comprobar que regresa exactamente a su tamaño mínimo de barra.
4. Presionar el botón de escaneo/sincronización `🔄`. Comprobar que gira mientras carga y luego muestra las últimas novedades si las hay.
5. Hacer click en los chips de categorías (`Tech`, `Security`, etc.) en la parte superior y verificar que el listado se filtra al instante sin parpadeo y de manera responsiva.
