// ─── Pure HTML templates for the pending panel ──────────────────────────────
import {
  type PendingItem,
  STATE_OPTIONS,
  getExpandedId,
  getEditingId,
} from './state.ts';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderItem(item: PendingItem): string {
  const isExpanded = getExpandedId() === item.id;
  const isEditing = getEditingId() === item.id;
  // Detail section
  let detailHtml = '';
  if (isExpanded && item.detail) {
    detailHtml = `<div class="pending-detail">${escapeHtml(item.detail).replace(/\n/g, '<br>')}</div>`;
  }

  // Edit form
  let editHtml = '';
  if (isEditing) {
    editHtml = `
      <div class="pending-edit">
        <form class="pending-edit-form" data-id="${escapeHtml(item.id)}">
          <div class="edit-row">
            <label class="edit-label">Título</label>
            <input type="text" class="edit-title" value="${escapeHtml(item.title)}" required />
          </div>
          <div class="edit-row">
            <label class="edit-label">Prioridad</label>
            <select class="edit-priority">
              <option value="ALTA" ${item.priority === 'ALTA' ? 'selected' : ''}>ALTA</option>
              <option value="MEDIA" ${item.priority === 'MEDIA' ? 'selected' : ''}>MEDIA</option>
              <option value="BAJA" ${item.priority === 'BAJA' ? 'selected' : ''}>BAJA</option>
            </select>
          </div>
          <div class="edit-row">
            <label class="edit-label">Detalle</label>
            <textarea class="edit-detail" rows="4">${escapeHtml(item.detail)}</textarea>
          </div>
          <div class="edit-actions">
            <button type="submit" class="btn-save-edit">💾 Guardar</button>
            <button type="button" class="btn-cancel-edit" data-action="cancel-edit" data-id="${escapeHtml(item.id)}">✕ Cancelar</button>
          </div>
        </form>
      </div>
    `;
  }

  // State selector
  const stateOptions = STATE_OPTIONS.map(
    (o) =>
      `<option value="${o.value}" ${item.state === o.value ? 'selected' : ''}>${o.label}</option>`,
  ).join('');

  return `
    <div class="pending-item ${isExpanded ? 'expanded' : ''} ${isEditing ? 'editing' : ''}" data-id="${escapeHtml(item.id)}">
      <div class="pending-item-row" data-id="${escapeHtml(item.id)}">
        <span class="pending-id">[${escapeHtml(item.id)}]</span>
        <span class="pending-title">${escapeHtml(item.title)}</span>
        <select class="pending-state-select" data-id="${escapeHtml(item.id)}" title="Cambiar estado">
          ${stateOptions}
        </select>
        <button class="btn-edit" data-id="${escapeHtml(item.id)}" title="Editar pendiente" aria-label="Editar ${escapeHtml(item.title)}">✎</button>
        <button class="btn-resolve" data-id="${escapeHtml(item.id)}" title="Marcar como resuelto (mover a HECHO)" aria-label="Resolver ${escapeHtml(item.title)}">✓</button>
        <button class="btn-delete" data-id="${escapeHtml(item.id)}" title="Eliminar pendiente" aria-label="Eliminar ${escapeHtml(item.title)}">✕</button>
      </div>
      ${detailHtml}
      ${editHtml}
    </div>
  `;
}

export function renderForm(): string {
  return `
    <div class="pending-form">
      <div class="pending-form-title">+ Agregar pendiente</div>
      <div class="pending-form-row">
        <input type="text" class="pending-form-input" id="pending-new-title" placeholder="Título del pendiente..." autocomplete="off" />
        <select class="pending-form-select" id="pending-new-priority">
          <option value="ALTA">ALTA</option>
          <option value="MEDIA" selected>MEDIA</option>
          <option value="BAJA">BAJA</option>
        </select>
        <button class="pending-form-btn" id="pending-btn-add">Agregar</button>
      </div>
    </div>
  `;
}
