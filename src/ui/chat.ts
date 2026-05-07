// ─── RepoCiv — Side panel: Chat / Git / Files (Civ V Aesthetic) ────────────────
import type { Unit } from '../types.ts';
import { trapFocus } from './focusTrap.ts';

let activeChatUnit: string | null = null;
export const chatBuffers = new Map<string, string>();
let _sidePanelCleanup: (() => void) | null = null;

// ─── Clipboard helper ────────────────────────────────────────────────────────
function clipboardWrite(text: string): boolean {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return true;
    }
  } catch {
    /* fall through */
  }
  // Fallback for older browsers / non-HTTPS contexts
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const COPY_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';

/** Returns true if the text contains a transport error marker. */
function hasErrorLine(text: string): boolean {
  return /\[(?:hermes|openclaw) error\]/i.test(text);
}

/** Extracts the first error line from the message text. */
function extractErrorLine(text: string): string {
  const m = text.match(/\[(?:hermes|openclaw) error\].*?(?:\n|$)/i);
  return m ? m[0] : '';
}

// ─── One-shot listener attachment (idempotent) ───────────────────────────────
const _wired = new WeakMap<HTMLElement, { full: boolean; err: boolean }>();

function attachCopyListeners(root: HTMLElement, unitId: string) {
  // Full-message copy buttons
  for (const btn of root.querySelectorAll<HTMLElement>('.chat-copy-btn')) {
    const state = _wired.get(btn) ?? { full: false, err: false };
    if (state.full) continue;
    state.full = true;
    _wired.set(btn, state);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const msg = btn.closest<HTMLElement>('.chat-msg');
      if (!msg) return;
      // Live agent bubble reads from buffer; history messages from data attr
      const isLive = msg.id === `chat-current-${unitId}`;
      const text = isLive
        ? (chatBuffers.get(unitId) ?? '')
        : (msg.dataset['raw'] ?? msg.textContent ?? '');
      clipboardWrite(text);
      // Flash check icon for feedback
      const orig = btn.innerHTML;
      btn.innerHTML = CHECK_SVG;
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.classList.remove('copied');
      }, 1500);
    });
  }

  // Error-only copy buttons
  for (const btn of root.querySelectorAll<HTMLElement>('.chat-error-btn')) {
    const state = _wired.get(btn) ?? { full: false, err: false };
    if (state.err) continue;
    state.err = true;
    _wired.set(btn, state);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const msg = btn.closest<HTMLElement>('.chat-msg');
      if (!msg) return;
      const text = msg.dataset['raw'] ?? msg.textContent ?? '';
      const line = extractErrorLine(text);
      if (line) {
        clipboardWrite(line);
        const orig = btn.textContent;
        btn.textContent = '¡Copiado!';
        setTimeout(() => {
          btn.textContent = orig;
        }, 1500);
      }
    });
  }
}

// ─── Panel lifecycle ─────────────────────────────────────────────────────────

export function openSidePanel(unit: Unit) {
  const panel = document.getElementById('side-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  _sidePanelCleanup?.();
  _sidePanelCleanup = trapFocus(panel);
  activeChatUnit = unit.id;

  const setText = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText('side-hero-name', unit.name.toUpperCase());
  const stateEl = document.getElementById('side-hero-state');
  if (stateEl) {
    stateEl.textContent = unit.state.toUpperCase();
    stateEl.className = `state-${unit.state}`;
  }

  // Model selector dropdown
  const selector = document.getElementById('model-selector') as HTMLSelectElement;
  if (selector) {
    selector.innerHTML = '';
    const base = unit.id.split('-')[0]?.toUpperCase();
    const options: string[] =
      base === 'DAVI' || base === 'LEXO'
        ? ['Hermes: minimax-m2.6', 'Hermes: claude-3-haiku', 'LM Studio: llama-3 (Local)']
        : ['OpenClaw: gemini', 'OpenClaw: codex', 'LM Studio: phi-3 (Local)'];
    options.forEach((opt) => {
      const el = document.createElement('option');
      el.value = opt;
      el.textContent = opt;
      selector.appendChild(el);
    });
  }

  renderChatBuffer(unit.id);

  // Initialize scroll-to-bottom button for chat-messages
  const chatContainer = document.getElementById('chat-messages');
  if (chatContainer && !document.getElementById('chat-scroll-bottom')) {
    const scrollBtn = document.createElement('button');
    scrollBtn.id = 'chat-scroll-bottom';
    scrollBtn.className = 'chat-scroll-btn hidden';
    scrollBtn.textContent = '↓ Nuevos mensajes';
    scrollBtn.addEventListener('click', () => {
      chatContainer.scrollTop = chatContainer.scrollHeight;
      scrollBtn.classList.add('hidden');
    });
    chatContainer.parentElement?.appendChild(scrollBtn);

    // Show/hide button based on scroll position
    chatContainer.addEventListener('scroll', () => {
      const isAtBottom = chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - 30;
      scrollBtn.classList.toggle('hidden', isAtBottom);
    });
  }

  // Re-init icons if needed for dynamic content
  if ((window as unknown as Record<string, unknown>)['lucide'])
    (window as unknown as Record<string, { createIcons: () => void }>)['lucide']!.createIcons();
}

export function closeSidePanel() {
  _sidePanelCleanup?.();
  _sidePanelCleanup = null;
  document.getElementById('side-panel')?.classList.add('hidden');
}

export function isSidePanelOpen(): boolean {
  return !document.getElementById('side-panel')?.classList.contains('hidden');
}

export function appendChatChunk(unitId: string, text: string) {
  const prev = chatBuffers.get(unitId) ?? '';
  chatBuffers.set(unitId, prev + text);
  if (activeChatUnit === unitId) {
    ensureLiveAgentBubble(unitId);
    renderChatBuffer(unitId);
  }
}

export function appendUserMessage(unitId: string, text: string) {
  const container = document.getElementById('chat-messages');
  if (!container || activeChatUnit !== unitId) return;

  // Finalize previous agent bubble (turn it into history)
  const prevBubble = document.getElementById(`chat-current-${unitId}`);
  if (prevBubble) {
    prevBubble.id = ''; // Remove live ID so it becomes regular history
  }

  // ── User message bubble (right-aligned) ──────────────────────
  const msg = document.createElement('div');
  msg.className = 'chat-msg user';
  msg.dataset['raw'] = text;
  const userTime = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  msg.innerHTML = `<div class="chat-msg-head">
    <div class="chat-msg-meta">
      <span>TÚ · ${userTime}</span>
      <button class="chat-copy-btn" title="Copiar mensaje" aria-label="Copiar mensaje al portapapeles">${COPY_SVG}</button>
    </div>
  </div>
  <div class="chat-body">${escapeHtml(text)}</div>`;
  container.appendChild(msg);

  // ── Agent reply bubble (left-aligned, will be filled by streaming chunks) ──
  chatBuffers.set(unitId, '');
  const agentTime = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg';
  bubble.id = `chat-current-${unitId}`;
  bubble.dataset['raw'] = '';
  bubble.innerHTML = `<div class="chat-msg-head">
    <div class="chat-msg-meta">
      <span>${unitId.toUpperCase()} · ${agentTime}</span>
      <div class="chat-msg-actions">
        <button class="chat-copy-btn" title="Copiar mensaje" aria-label="Copiar mensaje al portapapeles">${COPY_SVG}</button>
        <button class="chat-error-btn hidden" title="Copiar solo la línea de error" aria-label="Copiar línea de error al portapapeles">Copiar error</button>
      </div>
    </div>
  </div>
  <span class="chat-body"></span>`;
  container.appendChild(bubble);

  // Scroll to bottom on new message
  container.scrollTop = container.scrollHeight;
  attachCopyListeners(container, unitId);
}

function ensureLiveAgentBubble(unitId: string) {
  if (document.getElementById(`chat-current-${unitId}`)) return;
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const agentTime = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg';
  bubble.id = `chat-current-${unitId}`;
  bubble.dataset['raw'] = '';
  bubble.innerHTML = `<div class="chat-msg-head">
    <div class="chat-msg-meta">
      <span>${unitId.toUpperCase()} · ${agentTime}</span>
      <div class="chat-msg-actions">
        <button class="chat-copy-btn" title="Copiar mensaje" aria-label="Copiar mensaje al portapapeles">${COPY_SVG}</button>
        <button class="chat-error-btn hidden" title="Copiar solo la línea de error" aria-label="Copiar línea de error al portapapeles">Copiar error</button>
      </div>
    </div>
  </div>
  <span class="chat-body"></span>`;
  container.appendChild(bubble);
  attachCopyListeners(container, unitId);
}

function renderChatBuffer(unitId: string) {
  const current = document.getElementById(`chat-current-${unitId}`);
  if (!current) return;
  const body = current.querySelector<HTMLElement>('.chat-body');
  const text = chatBuffers.get(unitId) ?? '';
  if (body) body.textContent = text;
  // Keep data-raw in sync so error button reads correct text
  current.dataset['raw'] = text;
  // Show / hide the dedicated error-copy button
  const errBtn = current.querySelector<HTMLElement>('.chat-error-btn');
  if (errBtn) {
    errBtn.classList.toggle('hidden', !hasErrorLine(text));
  }
  // Only auto-scroll if user is near bottom
  const container = document.getElementById('chat-messages');
  if (container) {
    const isNearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
    if (isNearBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }
}

export function clearChat(unitId: string) {
  chatBuffers.delete(unitId);
  if (activeChatUnit === unitId) {
    const container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '';
  }
}

export function wireSideTabs(onTabChange: (tab: string) => void) {
  document.querySelectorAll<HTMLElement>('.side-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.side-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset['tab']!;
      document.querySelector(`.tab-pane[data-pane="${name}"]`)?.classList.add('active');
      onTabChange(name);
    });
  });
}

export async function loadGitInfo(repoName: string) {
  const target = document.getElementById('git-info');
  if (!target) return;
  target.innerHTML = `<div class="git-line" style="color:var(--text-dim)">consultando manuscritos de ${repoName}...</div>`;
  try {
    const res = await fetch(`/api/git/${encodeURIComponent(repoName)}`);
    if (!res.ok) {
      target.innerHTML = `<div class="git-line" style="color:var(--civ-happiness)">${repoName} no es un territorio git.</div>`;
      return;
    }
    const data = (await res.json()) as { branch: string; lastCommit: string; changes: string[] };
    const [hash, subject, ago] = data.lastCommit.split('|');
    const changesHtml =
      data.changes.length === 0
        ? '<div class="git-line" style="color:var(--civ-food)">territorio limpio</div>'
        : data.changes
            .map((c) => {
              const code = c.trim()[0] ?? '?';
              const color =
                code === 'M'
                  ? 'var(--civ-gold)'
                  : code === 'A'
                    ? 'var(--civ-food)'
                    : code === 'D'
                      ? 'var(--civ-happiness)'
                      : 'var(--text-dim)';
              return `<div class="git-line" style="color:${color}">${escapeHtml(c)}</div>`;
            })
            .join('');
    target.innerHTML = `
      <div class="git-branch" style="color:var(--gold-bright); font-weight:700; margin-bottom:8px">⎇ ${escapeHtml(data.branch)}</div>
      <div class="git-last" style="font-size:11px; opacity:0.7; margin-bottom:12px; border-bottom:1px solid var(--panel-border); padding-bottom:8px">${escapeHtml(hash ?? '')} · ${escapeHtml(subject ?? '')} · ${escapeHtml(ago ?? '')}</div>
      ${changesHtml}
    `;
  } catch (e) {
    target.innerHTML = `<div class="git-line" style="color:var(--civ-happiness)">Error: ${String(e)}</div>`;
  }
}

export async function loadFilesInfo(repoName: string) {
  const target = document.getElementById('files-info');
  if (!target) return;
  target.innerHTML = `<div class="file-row" style="color:var(--text-dim)">explorando archivos de ${repoName}...</div>`;
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(repoName)}`);
    if (!res.ok) {
      target.innerHTML = `<div class="file-row" style="color:var(--civ-happiness)">No se pudieron leer los archivos.</div>`;
      return;
    }
    const data = (await res.json()) as { files: string[] };
    target.innerHTML =
      data.files.length === 0
        ? '<div class="file-row" style="color:var(--text-dim)">vacío</div>'
        : data.files
            .map((f) => `<div class="file-row" style="padding:2px 0">${escapeHtml(f)}</div>`)
            .join('');
  } catch (e) {
    target.innerHTML = `<div class="file-row" style="color:var(--civ-happiness)">Error: ${String(e)}</div>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
