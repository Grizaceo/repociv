// ─── RepoCiv — Imperial Empty States ────────────────────────────────────────
// 3/8 Whimsy Injector: "Empty states con copy imperial + acción sugerida"

export interface EmptyStateConfig {
  icon: string;
  title: string;
  message: string;
  action?: { label: string; handler: () => void };
}

const EMPTY_STATES: Record<string, EmptyStateConfig> = {
  world: {
    icon: '⛺',
    title: 'Tierras Inexploradas',
    message: 'Tu imperio no tiene colonias. Escanea el workspace para fundar la primera ciudad.',
    action: { label: 'Explorar terrenos', handler: () => { /* caller wires */ } },
  },
  agents: {
    icon: '🦅',
    title: 'Sin Tropas en Campo',
    message: 'Despliega al menos un agente para comenzar las operaciones.',
    action: { label: 'Desplegar agente', handler: () => { /* caller wires */ } },
  },
  bridge: {
    icon: '⚡',
    title: 'El Puente Está Cerrado',
    message: 'No hay conexión con el servidor. El imperio está incomunicado.',
    action: { label: 'Intentar reconexión', handler: () => { window.location.reload(); } },
  },
  pending: {
    icon: '📜',
    title: 'Sin Edictos Pendientes',
    message: 'TODOs limpios. El imperio descansa. Por ahora.',
  },
  approvals: {
    icon: '🛡',
    title: 'Sin Cartas Reales por Firmar',
    message: 'Ninguna aprobación requiere tu autoridad imperial.',
  },
  chat: {
    icon: '📯',
    title: 'Silencio en la Sala del Trono',
    message: 'Ningún mensaje aún. Escribe un decreto para iniciar la conversación.',
  },
};

export function getEmptyState(key: string): EmptyStateConfig | null {
  return EMPTY_STATES[key] ?? null;
}

export function renderEmptyState(container: HTMLElement, key: string, customAction?: () => void): void {
  const cfg = getEmptyState(key);
  if (!cfg) return;
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  wrap.innerHTML = `
    <div class="empty-icon">${cfg.icon}</div>
    <div class="empty-title">${cfg.title}</div>
    <div class="empty-message">${cfg.message}</div>
  `;
  if (cfg.action) {
    const btn = document.createElement('button');
    btn.className = 'empty-action';
    btn.textContent = cfg.action.label;
    btn.addEventListener('click', customAction ?? cfg.action.handler);
    wrap.appendChild(btn);
  }
  container.appendChild(wrap);
}

export function clearEmptyState(container: HTMLElement): void {
  const es = container.querySelector('.empty-state');
  if (es) es.remove();
}
