// ─── RepoCiv — Replay Panel (Fase 9) ─────────────────────────────────────────
// Shows recent successful directive sequences; clicking one re-submits via
// the command bus (still goes through policy — nothing bypasses it).

import { fetchStats, cmdTypeLabel, successRateColor, type ReplayEntry } from '../directiveLearner.ts';
import { sendCommand } from '../commandBus.ts';
import { draftCommand } from '../commandSchema.ts';

let _panel:   HTMLElement | null = null;
let _visible  = false;
let _entries: ReplayEntry[] = [];

// ─── Public API ───────────────────────────────────────────────────────────────
export function openReplayPanel()  { _visible = true;  _getOrCreate().classList.remove('hidden'); void _load(); }
export function closeReplayPanel() { _visible = false; _panel?.classList.add('hidden'); }
export function isReplayPanelOpen(): boolean { return _visible; }
export function toggleReplayPanel() { if (_visible) closeReplayPanel(); else openReplayPanel(); }

// ─── Load + render ────────────────────────────────────────────────────────────
async function _load() {
  const stats = await fetchStats();
  _entries = stats?.recentSuccesses ?? [];
  _render();
}

function _render() {
  const panel = _getOrCreate();
  const body  = panel.querySelector<HTMLElement>('.rp-body')!;

  if (_entries.length === 0) {
    body.innerHTML = `
      <div class="rp-empty">
        Aún no hay directivas exitosas registradas.<br>
        Completa algunas misiones para ver sugerencias de replay.
      </div>`;
    return;
  }

  body.innerHTML = _entries.map((e, i) => {
    const color = successRateColor(1);
    const ago   = _age(Math.round(Date.now() / 1000 - e.ts));
    const label = cmdTypeLabel(e.cmd_type);
    const icon  = _gestureIcon(e.gesture);
    return `
      <div class="rp-entry" data-idx="${i}">
        <div class="rp-entry-header">
          <span class="rp-gesture-icon">${icon}</span>
          <span class="rp-cmd-type" style="color:${color}">${_esc(label)}</span>
          <span class="rp-agent">${_esc(e.agent_id)}</span>
          <span class="rp-ago">${ago}</span>
        </div>
        <div class="rp-target" title="${_esc(e.target)}">${_esc(e.target.slice(0, 40))}</div>
        <div class="rp-entry-footer">
          <span class="rp-dur">${e.duration_s.toFixed(1)}s</span>
          <button class="rp-replay-btn" data-idx="${i}">↩ Replay</button>
        </div>
      </div>`;
  }).join('');

  body.querySelectorAll<HTMLButtonElement>('.rp-replay-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx  = parseInt(btn.dataset['idx'] ?? '0', 10);
      const entry = _entries[idx];
      if (!entry) return;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const draft = draftCommand(
          entry.cmd_type as never,
          entry.target,
          { unit: entry.agent_id, agentType: 'hero', mission: `Replay: ${cmdTypeLabel(entry.cmd_type)}` },
        );
        await sendCommand(draft);
        btn.textContent = '✔ Encolado';
      } catch {
        btn.textContent = '✗ Error';
        btn.disabled = false;
      }
    });
  });
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  const el = document.createElement('div');
  el.id = 'replay-panel';
  el.className = 'rp-panel hidden';
  el.innerHTML = `
    <div class="rp-header">
      <span class="rp-title">↩ REPLAY DE DIRECTIVAS</span>
      <button id="rp-close" title="Cerrar">✕</button>
    </div>
    <div class="rp-subheader">Últimas directivas exitosas — confirman a través de policy</div>
    <div class="rp-body"></div>
  `;
  document.body.appendChild(el);
  el.querySelector('#rp-close')?.addEventListener('click', closeReplayPanel);
  _panel = el;
  return el;
}

function _gestureIcon(g: string): string {
  if (g === 'drag_unit_to_city')  return '→';
  if (g === 'drag_city_to_city')  return '⇌';
  if (g === 'area_select')        return '▣';
  if (g === 'right_click')        return '◈';
  return '⬡';
}

function _age(seconds: number): string {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function _esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
