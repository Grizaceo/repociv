// ─── RepoCiv — Spatial Preview & Context Menu (Fase 5) ──────────────────────
// Barrel: re-exporta la API publica desde submodulos en src/ui/spatialPreview/.

export {
  showDirectivePreview,
  hideDirectivePreview,
  showContextMenu,
  hideContextMenu,
} from './spatialPreview/directive.ts';

export {
  renderDragGhost,
  renderCityDragGhost,
  renderAreaSelect,
  renderDropTarget,
} from './spatialPreview/canvas.ts';

export { showDragTooltip } from './spatialPreview/tooltip.ts';
