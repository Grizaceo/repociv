// ─── RepoCiv — UI Helpers ─────────────────────────────────────────────────────

import type { GameState, Mission } from './game.ts';
import type { Unit } from './types.ts';

let loadingText: HTMLElement | null = null;
let loadingFill: HTMLElement | null = null;

export function showLoadingProgress(pct: number, text: string) {
  if (!loadingText) loadingText = document.getElementById('loading-text');
  if (!loadingFill) loadingFill = document.getElementById('loading-fill');
  if (loadingText) loadingText.textContent = text;
  if (loadingFill) loadingFill.style.width = `${pct}%`;
}

export function hideLoadingScreen() {
  const screen = document.getElementById('loading-screen');
  if (screen) {
    screen.style.opacity = '0';
    screen.style.pointerEvents = 'none';
    setTimeout(() => { screen.style.display = 'none'; }, 400);
  }
}

// ─── HUD resource bar ─────────────────────────────────────────────────────
export function updateResource(id: 'gold' | 'science' | 'production', value: number) {
  const el = document.querySelector<HTMLElement>(`#res-${id} .res-value`);
  if (el) el.textContent = value.toLocaleString();
}

// ─── Event log ────────────────────────────────────────────────────────────
const LOG_MAX = 6;
export function logEvent(msg: string, type: 'info' | 'warn' | 'success' | 'build' | 'error' = 'info') {
  const container = document.getElementById('log-messages');
  if (!container) return;
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type === 'warn' ? 'error' : type === 'success' ? 'gold' : type}`;
  
  let icon = '·';
  let iconColor = 'var(--gold-mid)';
  if (type === 'success') { icon = '✓'; iconColor = 'var(--state-success)'; }
  else if (type === 'warn') { icon = '⚠'; iconColor = 'var(--state-warn)'; }
  else if (type === 'error') { icon = '✗'; iconColor = 'var(--state-error)'; }
  else if (type === 'build') { icon = '◆'; iconColor = 'var(--state-working)'; }

  entry.innerHTML = `<span class="log-icon" style="color:${iconColor}">${icon}</span> <span class="log-text">${escapeHtml(msg)}</span>`;
  container.appendChild(entry);
  while (container.children.length > LOG_MAX) {
    container.removeChild(container.firstChild!);
  }
}

// ─── Bridge status indicator ──────────────────────────────────────────────
export function setBridgeStatus(online: boolean, mode: 'openclaw' | 'hermes' | 'demo' = 'hermes') {
  const el = document.getElementById('bridge-status');
  if (!el) return;
  el.classList.toggle('bridge-online', online);
  el.classList.toggle('bridge-offline', !online);
  el.classList.toggle('bridge-demo', mode === 'demo');
  el.textContent = online ? `⚡ ${mode}` : (mode === 'demo' ? '⚡ DEMO' : '⚡ offline');
}

// ─── GPU / VRAM bar ──────────────────────────────────────────────────────
export function updateGpuBar(data: { vramUsed?: number; vramTotal?: number; temp?: number } | null) {
  const bar = document.getElementById('gpu-bar');
  if (!bar) return;

  if (!data || data.vramUsed === undefined) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');

  const vramEl = bar.querySelector<HTMLElement>('.gpu-vram');
  const tempEl = bar.querySelector<HTMLElement>('.gpu-temp');

  if (vramEl && data.vramTotal) {
    const gb = (v: number) => (v / 1024).toFixed(1);
    vramEl.textContent = `VRAM ${gb(data.vramUsed)}/${gb(data.vramTotal)} GB`;
    const ratio = data.vramUsed / data.vramTotal;
    vramEl.classList.toggle('gpu-warn', ratio > 0.875);
  }

  if (tempEl && data.temp !== undefined) {
    tempEl.textContent = `GPU ${data.temp}°C`;
    tempEl.classList.toggle('gpu-warn', data.temp > 80);
  }
}

// ─── Operation ticker (chat panel) ───────────────────────────────────────
export function setOperationTicker(active: boolean, text = '') {
  const el = document.getElementById('operation-ticker');
  if (!el) return;
  el.classList.toggle('hidden', !active);
  const t = document.getElementById('ticker-text');
  if (t && text) t.textContent = text;
}

// ─── Unit panel ───────────────────────────────────────────────────────────
export function showUnitPanel(unit: Unit) {
  const panel = document.getElementById('unit-panel');
  if (!panel) return;
  panel.classList.remove('hidden');

  const sprite = document.getElementById('unit-sprite');
  if (sprite) {
    sprite.textContent = unit.name[0] ?? '?';
    sprite.style.background = unit.color;
    sprite.style.color = '#1a1208';
  }

  const setText = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText('unit-name', unit.name);
  setText('unit-state-text', unit.state);
  setText('unit-mission', unit.mission ?? 'Sin misión');
  setText('unit-moves', `${unit.movesLeft}/${unit.maxMoves} mov`);
  setText('unit-model', unitModelLabel(unit));

  const fill = document.getElementById('unit-moves-fill');
  if (fill) fill.style.width = `${(unit.movesLeft / unit.maxMoves) * 100}%`;

  const dot = document.getElementById('unit-status-dot');
  if (dot) dot.style.background = unitStateColor(unit.state);
  
  if (unit.state === 'working') sprite.classList.add('working');
  else sprite.classList.remove('working');
}

function unitModelLabel(unit: Unit): string {
  const base = unit.id.split('-')[0]?.toUpperCase();
  if (base === 'DAVI')   return 'mimo · técnico';
  if (base === 'WORKER') return 'fluido · conciso';
  if (base === 'SCOUT')  return 'analítico · útil';
  if (base === 'LEXO')   return 'lexo-alpha · analítico';
  if (base === 'OPENCLAW') return 'openclaw · local';
  return unit.type;
}

function unitStateColor(state: Unit['state']): string {
  return state === 'working' ? '#5b9bd5' :
         state === 'moving'  ? '#c8a84b' :
         state === 'sleeping'? '#444'    :
         state === 'building'? '#5b9b5b' : '#888';
}

export function hideUnitPanel() {
  const panel = document.getElementById('unit-panel');
  if (panel) panel.classList.add('hidden');
}

// ─── Hero Bar (top-left, AgentCraft-style hero slots 1-9) ─────────────────
export function renderHeroBar(state: GameState, onSelect: (u: Unit) => void) {
  const slots = document.getElementById('hero-bar-slots');
  if (!slots) return;
  slots.innerHTML = '';

  const heroes = state.getAllUnits().slice(0, 9);
  heroes.forEach((unit, idx) => {
    const slot = document.createElement('div');
    slot.className = 'hero-slot';
    if (state.selectedUnit?.id === unit.id) slot.classList.add('selected');
    slot.style.background = `linear-gradient(135deg, ${unit.color}33, ${unit.color}11)`;
    slot.style.color = unit.color;
    slot.title = `${unit.name} — ${unit.state} (${idx + 1})`;
    slot.innerHTML = `
      <span class="slot-num">${idx + 1}</span>
      <span class="slot-letter">${unit.name[0]}</span>
      <span class="slot-state ${unit.state}"></span>
    `;
    slot.addEventListener('click', () => onSelect(unit));
    slots.appendChild(slot);
  });
}

// ─── Side Panel: Chat ─────────────────────────────────────────────────────
let activeChatUnit: string | null = null;
const chatBuffers = new Map<string, string>();

export function openSidePanel(unit: Unit) {
  const panel = document.getElementById('side-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  activeChatUnit = unit.id;
  const setText = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText('side-hero-name', unit.name);
  const stateEl = document.getElementById('side-hero-state');
  if (stateEl) {
    stateEl.textContent = unit.state;
    stateEl.className = `state-${unit.state}`;
  }
  
  // Model selector dropdown
  const selector = document.getElementById('model-selector') as HTMLSelectElement;
  if (selector) {
    selector.innerHTML = '';
    const base = unit.id.split('-')[0]?.toUpperCase();
    let options = [];
    if (base === 'DAVI' || base === 'LEXO') {
       options = ['Hermes: minimax-m2.6', 'Hermes: claude-3-haiku', 'LM Studio: llama-3 (Local)'];
    } else {
       options = ['OpenClaw: gemini', 'OpenClaw: codex', 'LM Studio: phi-3 (Local)'];
    }
    options.forEach(opt => {
       const el = document.createElement('option');
       el.value = opt; el.textContent = opt;
       selector.appendChild(el);
    });
  }

  renderChatBuffer(unit.id);
}

export function closeSidePanel() {
  document.getElementById('side-panel')?.classList.add('hidden');
}

export function isSidePanelOpen(): boolean {
  return !document.getElementById('side-panel')?.classList.contains('hidden');
}

export function appendChatChunk(unitId: string, text: string, _missionId?: string) {
  const prev = chatBuffers.get(unitId) ?? '';
  chatBuffers.set(unitId, prev + text);
  if (activeChatUnit === unitId) renderChatBuffer(unitId);
}

export function appendUserMessage(unitId: string, text: string) {
  const container = document.getElementById('chat-messages');
  if (!container || activeChatUnit !== unitId) return;
  const msg = document.createElement('div');
  msg.className = 'chat-msg user';
  msg.innerHTML = `<div class="chat-msg-meta">tú → ${unitId}</div>${escapeHtml(text)}`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;

  // Reset assistant buffer for new turn
  chatBuffers.set(unitId, '');
  // Add fresh assistant message bubble
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg';
  bubble.id = `chat-current-${unitId}`;
  bubble.innerHTML = `<div class="chat-msg-meta">${unitId}</div><span class="chat-body"></span>`;
  container.appendChild(bubble);
}

function renderChatBuffer(unitId: string) {
  const current = document.getElementById(`chat-current-${unitId}`);
  if (!current) return;
  const body = current.querySelector<HTMLElement>('.chat-body');
  if (body) body.textContent = chatBuffers.get(unitId) ?? '';
  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

export function clearChat(unitId: string) {
  chatBuffers.delete(unitId);
  if (activeChatUnit === unitId) {
    const container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '';
  }
}

// ─── Side Panel tabs ──────────────────────────────────────────────────────
export function wireSideTabs(onTabChange: (tab: string) => void) {
  document.querySelectorAll<HTMLElement>('.side-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.side-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset['tab']!;
      document.querySelector(`.tab-pane[data-pane="${name}"]`)?.classList.add('active');
      onTabChange(name);
    });
  });
}

// ─── Side Panel: Git tab ──────────────────────────────────────────────────
export async function loadGitInfo(repoName: string) {
  const target = document.getElementById('git-info');
  if (!target) return;
  target.innerHTML = `<div class="git-line" style="color:#888">cargando ${repoName}...</div>`;
  try {
    const res = await fetch(`/api/git/${encodeURIComponent(repoName)}`);
    if (!res.ok) {
      target.innerHTML = `<div class="git-line" style="color:#d45b5b">${repoName} no es un repo git.</div>`;
      return;
    }
    const data = await res.json() as { branch: string; lastCommit: string; changes: string[] };
    const [hash, subject, ago] = data.lastCommit.split('|');
    const changesHtml = data.changes.length === 0
      ? '<div class="git-line" style="color:#5b9b5b">working tree limpio</div>'
      : data.changes.map(c => {
          const code = c.trim()[0] ?? '?';
          const cls = code === 'M' ? 'git-status-M' :
                      code === 'A' ? 'git-status-A' :
                      code === 'D' ? 'git-status-D' : 'git-status-untracked';
          return `<div class="git-line ${cls}">${escapeHtml(c)}</div>`;
        }).join('');

    target.innerHTML = `
      <div class="git-branch">⎇ ${escapeHtml(data.branch)}</div>
      <div class="git-last">${escapeHtml(hash ?? '')} · ${escapeHtml(subject ?? '')} · ${escapeHtml(ago ?? '')}</div>
      ${changesHtml}
    `;
  } catch (e) {
    target.innerHTML = `<div class="git-line" style="color:#d45b5b">Error: ${String(e)}</div>`;
  }
}

// ─── Side Panel: Files tab ────────────────────────────────────────────────
export async function loadFilesInfo(repoName: string) {
  const target = document.getElementById('files-info');
  if (!target) return;
  target.innerHTML = `<div class="file-row" style="color:#888">cargando ${repoName}...</div>`;
  try {
    const res = await fetch(`/api/files/${encodeURIComponent(repoName)}`);
    if (!res.ok) {
      target.innerHTML = `<div class="file-row" style="color:#d45b5b">No se pudieron leer archivos.</div>`;
      return;
    }
    const data = await res.json() as { files: string[] };
    target.innerHTML = data.files.length === 0
      ? '<div class="file-row" style="color:#888">vacío</div>'
      : data.files.map(f => `<div class="file-row">${escapeHtml(f)}</div>`).join('');
  } catch (e) {
    target.innerHTML = `<div class="file-row" style="color:#d45b5b">Error: ${String(e)}</div>`;
  }
}

// ─── Ficha de Ciudad (City Modal Mocks) ───────────────────────────────────
export function openCityModal(cityName: string) {
  const panel = document.getElementById('city-panel');
  if (!panel) return;
  panel.classList.remove('hidden');

  const setText = (id: string, text: string) => { const e = document.getElementById(id); if(e) e.textContent = text; };
  setText('city-panel-name', cityName.toUpperCase());
  setText('city-repo-name', cityName);

  // Mocks delay para simular fetch
  setTimeout(() => {
    setText('city-git-branch', 'main');
    setText('city-git-status', 'clean');
    setText('city-terrain', '🌲 Bosque (70% código)');
    setText('city-session', '🔆 Bright (Actividad reciente)');
    setText('city-skill', '⚡ OK');
    setText('city-res-gold', Math.floor(Math.random() * 2000).toLocaleString());
    setText('city-res-sci', Math.floor(Math.random() * 200).toString());
    setText('city-res-prod', Math.floor(Math.random() * 100).toString());
    
    const missionsEl = document.getElementById('city-missions-list');
    if (missionsEl) missionsEl.innerHTML = '<div class="city-item">◉ Analizar dataset (2h ago)</div><div class="city-item">○ Revisar README (pending)</div>';

    const gitEl = document.getElementById('city-git-details');
    if (gitEl) gitEl.innerHTML = '<div class="city-item">⎇ main · a3f9b2c</div><div class="city-item" style="color:var(--text-dim)">3 files changed</div>';

    const filesEl = document.getElementById('city-files-list');
    if (filesEl) filesEl.innerHTML = '<div class="city-item">src/main.ts (mod 2h)</div><div class="city-item">docs/README.md (clean)</div>';
  }, 400);
}

export function closeCityModal() {
  document.getElementById('city-panel')?.classList.add('hidden');
}

// ─── Quest Board ──────────────────────────────────────────────────────────
let questFilter: 'all' | 'running' | 'complete' | 'failed' = 'all';

export function openQuestBoard(state: GameState) {
  document.getElementById('quest-board')?.classList.remove('hidden');
  renderQuestBoard(state);
}

export function closeQuestBoard() {
  document.getElementById('quest-board')?.classList.add('hidden');
}

export function isQuestBoardOpen(): boolean {
  return !document.getElementById('quest-board')?.classList.contains('hidden');
}

export async function fetchPendingTracker(): Promise<Mission[]> {
  try {
    const res = await fetch(`${import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:5274'}/pending`);
    if (!res.ok) return [];
    const raw = await res.json() as Array<{ title: string; description?: string }>;
    return raw.map((r, i) => ({
      id: `pending-${i}`,
      unit: 'DAVI',
      questName: r.title,
      status: 'running' as const,
      startedAt: Date.now(),
      completedAt: null,
    }));
  } catch {
    return [];
  }
}

export async function fetchPersistedMissions(): Promise<Mission[]> {
  try {
    const res = await fetch(`${import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:5274'}/missions`);
    if (!res.ok) return [];
    const raw = await res.json() as Array<{
      id: string; unit: string; questName: string; status: string;
      startedAt: number; completedAt: number | null;
    }>;
    return raw.map(r => ({
      id: r.id, unit: r.unit, questName: r.questName,
      status: r.status as Mission['status'],
      startedAt: r.startedAt * 1000,
      completedAt: r.completedAt ? r.completedAt * 1000 : null,
    }));
  } catch {
    return [];
  }
}

export function renderQuestBoard(state: GameState, persisted: Mission[] = []) {
  const list = document.getElementById('quest-list');
  if (!list) return;

  // Merge in-memory + persisted by id
  const map = new Map<string, Mission>();
  for (const m of persisted) map.set(m.id, m);
  for (const m of state.missions.values()) map.set(m.id, m);

  let missions = Array.from(map.values()).sort((a, b) => b.startedAt - a.startedAt);
  if (questFilter !== 'all') missions = missions.filter(m => m.status === questFilter);

  if (missions.length === 0) {
    list.innerHTML = '<div class="quest-empty">No hay misiones aún. Selecciona un héroe y dale una misión.</div>';
    return;
  }

  list.innerHTML = missions.map(m => {
    const dur = m.completedAt
      ? Math.round((m.completedAt - m.startedAt) / 1000) + 's'
      : Math.round((Date.now() - m.startedAt) / 1000) + 's…';
    const when = new Date(m.startedAt).toLocaleString('es-CL', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    return `
      <div class="quest-item">
        <span class="quest-status ${m.status}"></span>
        <div>
          <div class="quest-name">${escapeHtml(m.questName)}</div>
          <div class="quest-meta">${escapeHtml(m.unit)} · ${when} · ${dur}</div>
        </div>
        <div class="quest-meta">${m.status}</div>
      </div>
    `;
  }).join('');
}

export function wireQuestBoardTabs(state: GameState) {
  document.querySelectorAll<HTMLElement>('.quest-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('.quest-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      questFilter = tab.dataset['filter'] as typeof questFilter;
      const persisted = await fetchPersistedMissions();
      renderQuestBoard(state, persisted);
    });
  });
}

// ─── Keyboard help overlay ────────────────────────────────────────────────
export function toggleKeyboardHelp(force?: boolean) {
  const el = document.getElementById('keyboard-help');
  if (!el) return;
  if (force === true) el.classList.remove('hidden');
  else if (force === false) el.classList.add('hidden');
  else el.classList.toggle('hidden');
}

// ─── Tooltip ──────────────────────────────────────────────────────────────
export function showTooltip(text: string, x: number, y: number) {
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  tip.textContent = text;
  tip.style.left = `${x + 12}px`;
  tip.style.top = `${y - 8}px`;
  tip.classList.remove('hidden');
}

export function hideTooltip() {
  const tip = document.getElementById('tooltip');
  if (tip) tip.classList.add('hidden');
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
