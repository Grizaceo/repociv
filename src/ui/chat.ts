// ─── RepoCiv — Side panel: Chat / Git / Files (Civ V Aesthetic) ────────────────
import type { Unit } from '../types.ts';
import { trapFocus } from './focusTrap.ts';
import { bridgeHeaders, bridgeUrl, hermesWebUrl } from '../bridgeEnv.ts';

let activeChatUnit: string | null = null;
export const chatBuffers = new Map<string, string>();
let _sidePanelCleanup: (() => void) | null = null;

// Chat history: per-unit array of messages
interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  timestamp: string;
}
const chatHistory = new Map<string, ChatMessage[]>();
// Reference to the currently streaming agent bubble per unit
const currentAgentBubble = new Map<string, HTMLElement>();
// Index of the current agent message in history (for updating)
const currentAgentMessageIndex = new Map<string, number>();

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

// 3-layer state: harness / provider / model
interface HarnessInfo {
  id: string;
  name: string;
  transport: string;
  available: boolean;
}
interface ModelInfo {
  id: string;
  name: string;
  harnesses: string[];
}
interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  defaultModel: string;
  models: ModelInfo[];
}
let _harnesses: HarnessInfo[] = [];
let _providers: ProviderInfo[] = [];
let _selectedHarness = "";
let _selectedProvider = "";
let _selectedModel = "";

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

  // Provider + Model selectors
  initProviderSelectors(unit);

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

function initProviderSelectors(_unit: Unit) {
  const wrapper = document.getElementById('model-selector-wrapper');
  if (!wrapper) return;

  // Wire event listeners (idempotent — safe to call multiple times)
  const harnessSel = document.getElementById('harness-selector') as HTMLSelectElement | null;
  const provSel = document.getElementById('provider-selector') as HTMLSelectElement | null;
  const modelSel = document.getElementById('model-selector') as HTMLSelectElement | null;

  if (harnessSel && !harnessSel.dataset['wired']) {
    harnessSel.addEventListener('change', () => {
      _selectedHarness = harnessSel.value;
      persistSelection();
      updateStatusIndicator();
    });
    harnessSel.dataset['wired'] = '1';
  }
  if (provSel && !provSel.dataset['wired']) {
    provSel.addEventListener('change', () => {
      _selectedProvider = provSel.value;
      populateModels();
      persistSelection();
      updateStatusIndicator();
      // When provider changes, also switch Hermes model if a model is selected
      if (_selectedModel) {
        switchHermesModel(_selectedProvider, _selectedModel);
      }
    });
    provSel.dataset['wired'] = '1';
  }
  if (modelSel && !modelSel.dataset['wired']) {
    modelSel.addEventListener('change', () => {
      _selectedModel = modelSel.value;
      persistSelection();
      updateStatusIndicator();
      // When model changes, switch Hermes to use it
      if (_selectedModel && _selectedProvider) {
        switchHermesModel(_selectedProvider, _selectedModel);
      }
    });
    modelSel.dataset['wired'] = '1';
  }

  // Fetch full 3-layer config from bridge
  fetch(bridgeUrl('/providers'), { headers: bridgeHeaders() })
    .then((r) => {
      if (!r.ok) throw newError(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data: {
      defaultHarness: string;
      defaultProvider: string;
      harnesses: HarnessInfo[];
      providers: ProviderInfo[];
    }) => {
      _harnesses = data.harnesses;
      _providers = data.providers;

      // ── Populate harness selector ──
      if (harnessSel) {
        harnessSel.innerHTML = '';
        const autoHarness = document.createElement('option');
        autoHarness.value = 'auto';
        autoHarness.textContent = '⚡ Auto (cascade)';
        harnessSel.appendChild(autoHarness);
        for (const h of _harnesses) {
          const opt = document.createElement('option');
          opt.value = h.id;
          opt.textContent = h.available ? h.name : `${h.name} (no disponible)`;
          opt.disabled = !h.available;
          harnessSel.appendChild(opt);
        }
      }

      // ── Populate provider selector ──
      if (provSel) {
        provSel.innerHTML = '';
        const autoProv = document.createElement('option');
        autoProv.value = 'auto';
        autoProv.textContent = '⚡ Auto';
        provSel.appendChild(autoProv);
        for (const p of _providers) {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.available ? p.name : `${p.name} (no disponible)`;
          opt.disabled = !p.available;
          provSel.appendChild(opt);
        }
      }

      // ── Restore persisted selection or use defaults ──
      const saved = loadSelection();

      if (harnessSel) {
        if (saved.harness) {
          const exists = _harnesses.find((h) => h.id === saved.harness && h.available);
          if (exists) {
            harnessSel.value = saved.harness;
            _selectedHarness = saved.harness;
          } else {
            harnessSel.value = data.defaultHarness || 'auto';
            _selectedHarness = data.defaultHarness || 'auto';
          }
        } else {
          harnessSel.value = data.defaultHarness || 'auto';
          _selectedHarness = data.defaultHarness || 'auto';
        }
      }

      if (provSel) {
        if (saved.provider) {
          const exists = _providers.find((p) => p.id === saved.provider && p.available);
          if (exists) {
            provSel.value = saved.provider;
            _selectedProvider = saved.provider;
          } else {
            provSel.value = data.defaultProvider || 'auto';
            _selectedProvider = data.defaultProvider || 'auto';
          }
        } else {
          provSel.value = data.defaultProvider || 'auto';
          _selectedProvider = data.defaultProvider || 'auto';
        }
      }

      populateModels(saved.model);
      updateStatusIndicator();
    })
    .catch(() => {
      // Fallback: minimal selectors so the user can still interact
      if (harnessSel) {
        harnessSel.innerHTML = '<option value="auto" selected>⚡ Auto</option><option value="hermes">Hermes</option>';
        _selectedHarness = 'auto';
      }
      if (provSel) {
        provSel.innerHTML = '<option value="auto" selected>⚡ Auto</option>';
        _selectedProvider = 'auto';
      }
      _selectedModel = '';
      populateModels();
      updateStatusIndicator();
    });
}

/** Update the small status dot / tooltip showing current provider health. */
function updateStatusIndicator() {
  const provSel = document.getElementById('provider-selector') as HTMLSelectElement | null;
  if (!provSel) return;

  // Remove old indicator
  const wrapper = document.getElementById('model-selector-wrapper');
  const oldDot = wrapper?.querySelector('.selector-status-dot');
  if (oldDot) oldDot.remove();

  // Determine status
  let status: 'ok' | 'warn' | 'off' = 'off';
  if (_selectedProvider === 'auto' || !_selectedProvider) {
    // Check if at least one provider is available
    const anyAvailable = _providers.some((p) => p.available);
    status = anyAvailable ? 'warn' : 'off'; // warn = auto but we don't know which
  } else {
    const prov = _providers.find((p) => p.id === _selectedProvider);
    if (prov) {
      status = prov.available ? 'ok' : 'off';
    }
  }

  const dot = document.createElement('span');
  dot.className = `selector-status-dot ${status}`;
  dot.title = `Provider: ${_selectedProvider || 'auto'} — ${status === 'ok' ? 'disponible' : status === 'warn' ? 'auto' : 'no disponible'}`;
  wrapper?.insertBefore(dot, provSel);
}

function newError(msg: string): Error {
  return new Error(msg);
}

/** Switch Hermes model/provider via the web server API.
 *  This writes to session_model_overrides.json which the gateway reads on next turn.
 */
function switchHermesModel(provider: string, model: string) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 10_000);
  fetch(hermesWebUrl('/api/model/switch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model, session_key: 'cli', persist: false }),
    signal: ctrl.signal,
  })
    .then(async (r) => {
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        console.warn('[repociv] model switch failed:', r.status, body);
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        console.warn('[repociv] model switch error:', err);
      }
    });
}

function populateModels(savedModel?: string) {
  const modelSel = document.getElementById('model-selector') as HTMLSelectElement;
  if (!modelSel) return;
  modelSel.innerHTML = '';

  if (_selectedProvider === 'auto' || !_selectedProvider) {
    modelSel.disabled = true;
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Auto';
    modelSel.appendChild(opt);
    _selectedModel = '';
    return;
  }

  modelSel.disabled = false;
  const provider = _providers.find((p) => p.id === _selectedProvider);
  if (!provider) return;

  for (const m of provider.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    modelSel.appendChild(opt);
  }

  // Restore saved model or use provider default
  if (savedModel) {
    const exists = provider.models.find((m) => m.id === savedModel);
    if (exists) {
      modelSel.value = savedModel;
      _selectedModel = savedModel;
      return;
    }
  }
  modelSel.value = provider.defaultModel;
  _selectedModel = provider.defaultModel;
}

function persistSelection() {
  try {
    localStorage.setItem('repociv:chatConfig', JSON.stringify({
      harness: _selectedHarness,
      provider: _selectedProvider,
      model: _selectedModel,
    }));
  } catch {
    // localStorage full or unavailable
  }
}

function loadSelection(): { harness: string; provider: string; model: string } {
  try {
    const raw = localStorage.getItem('repociv:chatConfig');
    if (raw) return JSON.parse(raw);
    // Migrate from old key
    const old = localStorage.getItem('repociv:provider');
    if (old) {
      const parsed = JSON.parse(old);
      return { harness: '', provider: parsed.provider || '', model: parsed.model || '' };
    }
  } catch {
    // ignore
  }
  return { harness: '', provider: '', model: '' };
}

/** Get the currently selected harness, provider and model for sending to the bridge. */
export function getSelectedConfig(): { harness: string; provider: string; model: string } {
  return { harness: _selectedHarness, provider: _selectedProvider, model: _selectedModel };
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
  const newText = prev + text;
  chatBuffers.set(unitId, newText);
  if (activeChatUnit === unitId) {
    ensureLiveAgentBubble(unitId);
    // Update history
    const history = chatHistory.get(unitId) ?? [];
    const idx = currentAgentMessageIndex.get(unitId);
    if (idx !== undefined && idx >= 0 && idx < history.length) {
      const msg = history[idx];
      if (!msg) return;
      history[idx] = { role: msg.role, text: newText, timestamp: msg.timestamp };
      chatHistory.set(unitId, history);
    }
    // Update bubble directly
    const bubble = currentAgentBubble.get(unitId);
    if (bubble) {
      const body = bubble.querySelector<HTMLElement>('.chat-body');
      if (body) body.textContent = newText;
      bubble.dataset['raw'] = newText;
      // Show/hide error button
      const errBtn = bubble.querySelector<HTMLElement>('.chat-error-btn');
      if (errBtn) {
        errBtn.classList.toggle('hidden', !hasErrorLine(newText));
      }
    }
    // Auto-scroll if near bottom
    const container = document.getElementById('chat-messages');
    if (container) {
      const isNearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
      if (isNearBottom) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }
}

export function appendUserMessage(unitId: string, text: string) {
  const container = document.getElementById('chat-messages');
  if (!container || activeChatUnit !== unitId) return;

  // Finalize previous agent bubble (turn it into history)
  const prevBubble = currentAgentBubble.get(unitId);
  if (prevBubble) {
    prevBubble.id = ''; // Remove live ID
    prevBubble.classList.add('history');
    currentAgentBubble.delete(unitId);
  }

  // Add user message to history
  const userTime = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  const history = chatHistory.get(unitId) ?? [];
  history.push({ role: 'user', text, timestamp: userTime });
  chatHistory.set(unitId, history);

  // Render user message immediately
  const msg = document.createElement('div');
  msg.className = 'chat-msg user';
  msg.dataset['raw'] = text;
  msg.innerHTML = `<div class="chat-msg-head">
    <div class="chat-msg-meta">
      <span>TÚ · ${userTime}</span>
      <button class="chat-copy-btn" title="Copiar mensaje" aria-label="Copiar mensaje al portapapeles">${COPY_SVG}</button>
    </div>
  </div>
  <div class="chat-body">${escapeHtml(text)}</div>`;
  container.appendChild(msg);

  // Create new agent bubble (will be filled by streaming chunks)
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
  currentAgentBubble.set(unitId, bubble);

  // Add placeholder to history for upcoming agent response
  history.push({ role: 'agent', text: '', timestamp: agentTime });
  currentAgentMessageIndex.set(unitId, history.length - 1);

  // Scroll to bottom on new message
  container.scrollTop = container.scrollHeight;
  attachCopyListeners(container, unitId);
}

function ensureLiveAgentBubble(unitId: string) {
  if (currentAgentBubble.has(unitId)) return;
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
  currentAgentBubble.set(unitId, bubble);
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
  chatHistory.delete(unitId);
  currentAgentBubble.delete(unitId);
  currentAgentMessageIndex.delete(unitId);
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
