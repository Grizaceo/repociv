// ─── RepoCiv — Side panel: Chat / Git / Files ────────────────────────────────
import type { Unit } from '../types.ts';

let activeChatUnit: string | null = null;
export const chatBuffers = new Map<string, string>();

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
  chatBuffers.set(unitId, '');
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
