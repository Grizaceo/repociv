// ─── Side panel lifecycle + tab wiring + git/files loaders ──────────────────
import type { Unit } from '../../types.ts';
import { trapFocus } from '../focusTrap.ts';
import {
  setActiveChatUnit,
  getSidePanelCleanup,
  setSidePanelCleanup,
} from './state.ts';
import { escapeHtml } from './clipboard.ts';
import { renderChatHistory, renderChatBuffer } from './history.ts';
import { initAgentSelector } from './agentSelector.ts';
import { initProviderSelectors } from './modelSelector.ts';

export function openSidePanel(unit: Unit): void {
  const panel = document.getElementById('side-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  getSidePanelCleanup()?.();
  setSidePanelCleanup(trapFocus(panel));
  setActiveChatUnit(unit.id);

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

  initProviderSelectors();
  initAgentSelector(unit.id);

  renderChatHistory(unit.id);
  renderChatBuffer(unit.id);

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

    chatContainer.addEventListener('scroll', () => {
      const isAtBottom =
        chatContainer.scrollTop + chatContainer.clientHeight >= chatContainer.scrollHeight - 30;
      scrollBtn.classList.toggle('hidden', isAtBottom);
    });
  }

  // Re-init icons if needed for dynamic content
  const lucide = (window as unknown as Record<string, unknown>)['lucide'];
  if (lucide)
    (lucide as { createIcons: (opts: { icons: unknown }) => void }).createIcons({
      icons: (lucide as Record<string, unknown>)['icons'],
    });
}

export function closeSidePanel(): void {
  getSidePanelCleanup()?.();
  setSidePanelCleanup(null);
  document.getElementById('side-panel')?.classList.add('hidden');
}

export function isSidePanelOpen(): boolean {
  return !document.getElementById('side-panel')?.classList.contains('hidden');
}

export function wireSideTabs(onTabChange: (tab: string) => void): void {
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

export async function loadGitInfo(repoName: string): Promise<void> {
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

export async function loadFilesInfo(repoName: string): Promise<void> {
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
