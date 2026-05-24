# RepoCiv — Brand Guidelines

## 1. Identidad de marca

**Nombre**: RepoCiv  
**Tagline**: _Imperial Agent Dashboard_  
**Esencia**: Un mapa hexagonal estilo Civilization V que visualiza tu workspace de IA como un imperio.

### Dualidad semántica resuelta
- **"Repo"** → Repositorios de código, el territorio real.  
- **"Civ"** → Civilización, el marco mental.  
- Juntos: "Civilización de Repos" = un ecosistema de proyectos que evoluciona, expande y conquista bugs.

---

## 2. Voz y tono

| Contexto           | Voz                          | Ejemplo                                                   |
|--------------------|------------------------------|-----------------------------------------------------------|
| Loading            | Narrativa épica, épica lúdica | "Escaneando workspace..." → "Imperio listo."            |
| Acción exitosa     | Celebración imperial           | "¡Descubrimiento! Nueva ciudad fundada."                |
| Error              | Cuervo heráldico, no pánico  | "El Consejo Secreto te observa." (Easter egg)           |
| Estado vacío       | Llamada a la acción épica    | "Tu imperio está vacío. Conquista tu primer repo."      |
| Panel settings     | Técnico pero orgulloso       | "Configuración Imperial"                                 |

**NO**: Emoji excesivo en errores, tono corporativo genérico, paternalismo.  
**SÍ**: Metáfora consistente (imperio, ciudades, legiones, edictos, senado).

---

## 3. Paleta de agentes (mapa de color)

| Agente     | Color OKLCH                  | Rationale                                                     |
|------------|------------------------------|---------------------------------------------------------------|
| DAVI       | `var(--civ-gold)`            | Oro = autoridad, líder supremo del imperio.                   |
| WORKER     | `var(--civ-food)`            | Verde = sustento, constructores que alimentan el crecimiento. |
| SCOUT      | `var(--civ-movement)`        | Azul cian = reconocimiento, velocidad, frontera.              |
| LEXO       | `var(--civ-science)`         | Azul académico = leyes, conocimiento, referencias.          |
| OPENCLAW   | `oklch(0.82 0.12 175)`       | Aguamarina = puente de agua, conector entre mundos.           |

**Regla de extensión (6to+ agente):**  
1. Asignar un recurso Civ V no usado (Faith, Culture, Tourism, Diplomacy).  
2. Documentar en esta tabla antes de crear CSS variable `--agt-*`.  
3. Evitar duplicar tonos existentes en un radio hue < 30°.

---

## 4. Tokens críticos

Ver `src/styles/variables.css` para design tokens completos.
- OKLCH para todos los colores (excepto terrenos hexagonales).
- Espaciado: `--space-1` a `--space-13` (4px base).
- Tipografía: Cinzel (display/epic), Outfit (UI), Libre Baskerville (body), JetBrains Mono (logs).

---

## 5. Assets y procedimentalismo

- **Ningún asset rasterizado de IA**. Todo es procedural (Canvas 2D) o SVG inline.  
- Favicon: SVG artesanal triángulo dorado sobre selva verde.  
- Texturas: mármol inline SVG via feTurbulence, esquinas Art Déco inline.  
- Unidades: emoji + aura procedural.

---

## 6. Accesibilidad marca

- Dark mode por defecto; light mode disponible.  
- Preferencias de movimiento reducido respetadas.  
- Contraste texto secundario ≥ 4.5:1.  
- Focus-visible ring dorado en todos los elementos interactivos.
