// ─── RepoCiv — Notification Banners (Civ V style) ────────────────────────────
// Banners que aparecen arriba-centro con slide-down animado.
// Queue para mostrar de a uno, con auto-dismiss y click action.

export interface NotificationOpts {
  type: 'success' | 'warn' | 'error' | 'info';
  title: string;
  body: string;
  unit?: string;
  actionLabel?: string;
  onAction?: () => void;
  ttl?: number; // ms, default 5000
}

const ICON: Record<NotificationOpts['type'], string> = {
  success: '✓',
  warn: '⚠',
  error: '✗',
  info: '◆',
};

const COLOR: Record<NotificationOpts['type'], string> = {
  success: 'var(--civ-food, #5b9b5b)',
  warn: 'var(--ui-gold, #c8a84b)',
  error: 'var(--civ-defense, #d45b5b)',
  info: 'var(--res-science, #5b9bd5)',
};

interface QueueItem extends NotificationOpts {
  id: number;
}

let _idSeq = 0;
const _queue: QueueItem[] = [];
let _active: QueueItem | null = null;
let _container: HTMLElement | null = null;
let _dismissTimer = 0;

function getContainer(): HTMLElement {
  if (_container) return _container;
  const el = document.createElement('div');
  el.id = 'civ-notification-container';
  el.style.cssText = [
    'position:fixed',
    'top:0',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:9999',
    'pointer-events:none',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'gap:6px',
    'padding-top:8px',
  ].join(';');
  document.body.appendChild(el);
  _container = el;
  return el;
}

function renderBanner(item: QueueItem): HTMLElement {
  const el = document.createElement('div');
  el.dataset.notifId = String(item.id);

  const icon = ICON[item.type];
  const color = COLOR[item.type];
  const unit = item.unit
    ? `<span style="color:var(--ui-gold,#c8a84b);margin-right:4px">${esc(item.unit)}</span>`
    : '';
  const action = item.actionLabel
    ? `<button class="notif-action" aria-label="${esc(item.actionLabel ?? '')}">${esc(item.actionLabel)}</button>`
    : '';

  el.innerHTML = `
    <div class="notif-icon" style="color:${color}">${icon}</div>
    <div class="notif-content">
      <div class="notif-title">${esc(item.title)}</div>
      <div class="notif-body">${unit}${esc(item.body)}</div>
    </div>
    ${action}
    <button class="notif-close" aria-label="Cerrar">✕</button>
  `;

  el.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:10px',
    'background:linear-gradient(135deg,rgba(26,18,8,0.97) 0%,rgba(15,10,4,0.97) 100%)',
    'border:1px solid var(--ui-border,#5a3e1e)',
    `border-left:3px solid ${color}`,
    'border-radius:3px',
    'padding:10px 14px',
    'min-width:280px',
    'max-width:420px',
    'pointer-events:auto',
    'cursor:default',
    'box-shadow:0 4px 16px rgba(0,0,0,0.7)',
    'font-family:var(--font-ui,"Cinzel",serif)',
    'transform:translateY(-110%)',
    'transition:transform 0.28s cubic-bezier(0.34,1.56,0.64,1)',
    'will-change:transform',
  ].join(';');

  // Inject inline scoped styles once
  if (!document.getElementById('civ-notif-styles')) {
    const style = document.createElement('style');
    style.id = 'civ-notif-styles';
    style.textContent = `
      #civ-notification-container .notif-icon {
        font-size: 18px; flex-shrink: 0;
      }
      #civ-notification-container .notif-content {
        flex: 1; min-width: 0;
      }
      #civ-notification-container .notif-title {
        font-size: 12px; font-weight: 700; color: var(--ui-text, #e8d5a0);
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      #civ-notification-container .notif-body {
        font-size: 11px; color: var(--ui-text-dim, #a89060); margin-top: 2px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #civ-notification-container .notif-action {
        background: none; border: 1px solid var(--ui-gold, #c8a84b);
        color: var(--ui-gold, #c8a84b); border-radius: 2px;
        font-family: inherit; font-size: 10px; padding: 3px 8px;
        cursor: pointer; flex-shrink: 0;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      #civ-notification-container .notif-action:hover {
        background: rgba(200,168,75,0.15);
      }
      #civ-notification-container .notif-close {
        background: none; border: none; color: var(--ui-text-dim, #a89060);
        font-size: 11px; cursor: pointer; padding: 0 2px; flex-shrink: 0;
        line-height: 1;
      }
      #civ-notification-container .notif-close:hover {
        color: var(--ui-text, #e8d5a0);
      }
    `;
    document.head.appendChild(style);
  }

  return el;
}

function dismissCurrent() {
  if (!_active || !_container) return;
  clearTimeout(_dismissTimer);
  const current = _container.querySelector<HTMLElement>(`[data-notif-id="${_active.id}"]`);
  if (current) {
    current.style.transform = 'translateY(-110%)';
    current.style.opacity = '0';
    current.style.transition = 'transform 0.22s ease-in, opacity 0.22s ease-in';
    setTimeout(() => {
      current.remove();
      _active = null;
      processQueue();
    }, 230);
  } else {
    _active = null;
    processQueue();
  }
}

function processQueue() {
  if (_active || _queue.length === 0) return;
  const item = _queue.shift()!;
  _active = item;

  const container = getContainer();
  const el = renderBanner(item);
  container.appendChild(el);

  // Slide in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.transform = 'translateY(0)';
    });
  });

  // Wire up close
  el.querySelector<HTMLButtonElement>('.notif-close')?.addEventListener('click', () => {
    dismissCurrent();
  });

  // Wire up action
  if (item.onAction) {
    el.querySelector<HTMLButtonElement>('.notif-action')?.addEventListener('click', () => {
      item.onAction?.();
      dismissCurrent();
    });
  }

  // Auto-dismiss
  _dismissTimer = window.setTimeout(dismissCurrent, item.ttl ?? 5000);
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Muestra un banner Civ V arriba-centro. Se encola si ya hay uno activo.
 */
export function showNotification(opts: NotificationOpts): void {
  _queue.push({ ...opts, id: ++_idSeq });
  processQueue();
}
