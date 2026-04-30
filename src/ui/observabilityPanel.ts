// ─── RepoCiv — Observability Panel (Fase 7) ───────────────────────────────────
// Shows system health at a glance: agents, queue, error rate, duration,
// GPU/CPU/mem/disk, and recent failures.
import { openRecoveryPanel } from './recoveryPanel';
// Criterion: open RepoCiv → within 10 s know if the system is healthy.

const BRIDGE_URL   = import.meta.env.VITE_BRIDGE_URL   ?? 'http://localhost:5274';
const BRIDGE_TOKEN = import.meta.env.VITE_BRIDGE_TOKEN ?? '';
const POLL_MS = 5_000;

// ─── Types ────────────────────────────────────────────────────────────────────
interface AgentStatus {
  id: string;
  state: 'idle' | 'working' | 'sleeping' | 'offline';
  activeTask?: string | null;
}

interface Failure {
  commandId: string;
  error: string;
  ts: number;
  age: number;
  harnessId?: string;   // optional; populated if bridge sent it
  commandType?: string; // optional; command type that failed
}

interface Metrics {
  health: 'ok' | 'degraded' | 'critical';
  errorRate: number;
  durationP50: number | null;
  durationP95: number | null;
  completedCount: number;
  failedCount: number;
  queueDepth: number;
  toolCallsPerAgent: Record<string, number>;
  recentFailures: Failure[];
  agentStatus: AgentStatus[];
  gpu: { vramUsed: number; vramTotal: number; temp: number } | null;
  sys: {
    loadAvg1: number | null;
    memUsedGb: number | null;
    memTotalGb: number | null;
    diskUsedPct: number | null;
  };
  ts: number;
}

// ─── Module state ─────────────────────────────────────────────────────────────
let _panel:   HTMLElement | null = null;
let _timer    = 0;
let _visible  = false;
let _metrics: Metrics | null = null;
let _offline  = false;

// ─── Public API ───────────────────────────────────────────────────────────────
export function openObservabilityPanel() {
  _visible = true;
  _getOrCreate().classList.remove('hidden');
  void _fetch();
}

export function closeObservabilityPanel() {
  _visible = false;
  _panel?.classList.add('hidden');
}

export function isObservabilityPanelOpen(): boolean { return _visible; }

export function toggleObservabilityPanel() {
  if (_visible) closeObservabilityPanel();
  else openObservabilityPanel();
}

export function startObservabilityPolling() {
  _stopPolling();
  void _fetch();
  _timer = window.setInterval(() => { void _fetch(); }, POLL_MS);
}

export function stopObservabilityPolling() { _stopPolling(); }

// ─── Polling ──────────────────────────────────────────────────────────────────
function _stopPolling() {
  if (_timer) { clearInterval(_timer); _timer = 0; }
}

async function _fetch() {
  const headers: Record<string, string> = {};
  if (BRIDGE_TOKEN) headers['X-RepoCiv-Token'] = BRIDGE_TOKEN;
  try {
    const res = await fetch(`${BRIDGE_URL}/metrics`, { headers });
    if (!res.ok) { _offline = true; if (_visible) _render(); return; }
    _metrics = await res.json() as Metrics;
    _offline = false;
    _updateHealthDot(_metrics.health);
    if (_visible) _render();
  } catch {
    _offline = true;
    if (_visible) _render();
  }
}

// ─── Health dot in top bar ────────────────────────────────────────────────────
function _updateHealthDot(health: string) {
  const btn = document.getElementById('btn-observability');
  if (!btn) return;
  const colors: Record<string, string> = { ok: '#5b9b5b', degraded: '#e8a040', critical: '#d44b4b' };
  let dot = btn.querySelector<HTMLElement>('.obs-health-dot');
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'obs-health-dot';
    btn.appendChild(dot);
  }
  dot.style.background = colors[health] ?? '#666';
  dot.title = `Sistema: ${health.toUpperCase()}`;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render() {
  const panel = _getOrCreate();
  const body  = panel.querySelector<HTMLElement>('.obs-body')!;

  if (_offline) {
    body.innerHTML = '<div class="obs-offline">⚠ Bridge offline — sin datos</div>';
    return;
  }
  if (!_metrics) {
    body.innerHTML = '<div class="obs-offline">Cargando…</div>';
    return;
  }

  const m = _metrics;
  const [hColor, hIcon, hLabel] = _healthStyle(m.health);
  const errPct = Math.round(m.errorRate * 100);

  body.innerHTML = `
    <!-- Health banner -->
    <div class="obs-health-banner" style="background:${hColor}22;border-color:${hColor}">
      <span class="obs-health-icon">${hIcon}</span>
      <span class="obs-health-label">Sistema: ${hLabel}</span>
      <span class="obs-health-ts">Actualizado hace ${Math.round(Date.now() / 1000 - m.ts)}s</span>
    </div>

    <!-- Agent grid -->
    <div class="obs-section-title">Agentes</div>
    <div class="obs-agent-grid">
      ${m.agentStatus.length > 0
        ? m.agentStatus.map(a => _agentCard(a)).join('')
        : '<div class="obs-empty">Sin agentes activos</div>'}
    </div>

    <!-- Core metrics -->
    <div class="obs-section-title">Métricas</div>
    <div class="obs-metrics-grid">
      ${_metric('Cola', String(m.queueDepth), m.queueDepth > 8 ? 'warn' : m.queueDepth > 20 ? 'crit' : 'ok')}
      ${_metric('Tasa error', `${errPct}%`, errPct > 30 ? 'crit' : errPct > 10 ? 'warn' : 'ok')}
      ${_metric('Completadas', String(m.completedCount), 'ok')}
      ${_metric('Falladas', String(m.failedCount), m.failedCount > 0 ? 'warn' : 'ok')}
      ${m.durationP50 != null ? _metric('P50 dur.', `${m.durationP50}s`, 'ok') : ''}
      ${m.durationP95 != null ? _metric('P95 dur.', `${m.durationP95}s`, m.durationP95 > 60 ? 'warn' : 'ok') : ''}
    </div>

    <!-- Tool calls per agent -->
    ${Object.keys(m.toolCallsPerAgent).length > 0 ? `
      <div class="obs-section-title">Comandos por agente</div>
      <div class="obs-tool-calls">
        ${Object.entries(m.toolCallsPerAgent)
          .sort((a, b) => b[1] - a[1])
          .map(([id, n]) => `<span class="obs-tc-item"><span class="obs-tc-agent">${_esc(id)}</span><span class="obs-tc-count">${n}</span></span>`)
          .join('')}
      </div>` : ''}

    <!-- System resources -->
    <div class="obs-section-title">Sistema</div>
    <div class="obs-metrics-grid">
      ${m.sys.loadAvg1 != null ? _metric('Load avg', String(m.sys.loadAvg1), m.sys.loadAvg1 > 4 ? 'warn' : 'ok') : ''}
      ${m.sys.memUsedGb != null && m.sys.memTotalGb != null
        ? _metric('Memoria', `${m.sys.memUsedGb}/${m.sys.memTotalGb} GB`,
            (m.sys.memUsedGb / m.sys.memTotalGb) > 0.9 ? 'warn' : 'ok')
        : ''}
      ${m.sys.diskUsedPct != null
        ? _metric('Disco', `${m.sys.diskUsedPct}%`, m.sys.diskUsedPct > 90 ? 'crit' : m.sys.diskUsedPct > 75 ? 'warn' : 'ok')
        : ''}
      ${m.gpu
        ? _metric('GPU VRAM', `${m.gpu.vramUsed}/${m.gpu.vramTotal} MB`, 'ok')
        : ''}
      ${m.gpu
        ? _metric('GPU Temp', `${m.gpu.temp}°C`, m.gpu.temp > 85 ? 'crit' : m.gpu.temp > 70 ? 'warn' : 'ok')
        : ''}
    </div>

    <!-- Recent failures -->
    ${m.recentFailures.length > 0 ? `
      <div class="obs-section-title">Últimos fallos</div>
      <div class="obs-failures">
        ${m.recentFailures.map(f => `
          <div class="obs-failure-item">
            <span class="obs-fail-id">${_esc(f.commandId.slice(0, 8))}</span>
            <span class="obs-fail-age">${_age(f.age)}</span>
            <span class="obs-fail-err">${_esc(f.error || '(sin mensaje)')}</span>
            ${f.harnessId ? `
              <button class="obs-btn-recover"
                      data-harness="${_esc(f.harnessId)}"
                      data-reason="${_esc(f.error || 'failure')}"
                      data-cmdtype="${_esc(f.commandType ?? '')}"
                      title="Abrir plan de recovery">
                🔧
              </button>` : ''}
          </div>
        `).join('')}
      </div>` : ''}
  `;
}

// ─── Card helpers ─────────────────────────────────────────────────────────────
function _agentCard(a: AgentStatus): string {
  const colors: Record<string, string> = {
    idle: '#5b9b5b', working: '#4a9ade', sleeping: '#666', offline: '#d44b4b',
  };
  const color = colors[a.state] ?? '#888';
  return `
    <div class="obs-agent-card">
      <span class="obs-agent-dot" style="background:${color}" title="${a.state}"></span>
      <span class="obs-agent-id">${_esc(a.id)}</span>
      <span class="obs-agent-state">${a.state}</span>
      ${a.activeTask ? `<span class="obs-agent-task" title="${_esc(a.activeTask)}">${_esc(a.activeTask.slice(0, 18))}</span>` : ''}
    </div>
  `;
}

function _metric(label: string, value: string, status: 'ok' | 'warn' | 'crit'): string {
  const colors = { ok: '#5b9b5b', warn: '#e8a040', crit: '#d44b4b' };
  return `
    <div class="obs-metric">
      <span class="obs-metric-value" style="color:${colors[status]}">${_esc(value)}</span>
      <span class="obs-metric-label">${_esc(label)}</span>
    </div>
  `;
}

function _healthStyle(h: string): [string, string, string] {
  if (h === 'critical') return ['#d44b4b', '☠', 'CRÍTICO'];
  if (h === 'degraded') return ['#e8a040', '⚠', 'DEGRADADO'];
  return ['#5b9b5b', '✔', 'SANO'];
}

function _age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
function _getOrCreate(): HTMLElement {
  if (_panel) return _panel;
  const el = document.createElement('div');
  el.id = 'observability-panel';
  el.className = 'obs-panel hidden';
  el.innerHTML = `
    <div class="obs-header">
      <span class="obs-title">◉ OBSERVABILIDAD</span>
      <button id="obs-close" title="Cerrar [F8]">✕</button>
    </div>
    <div class="obs-body"></div>
  `;
  document.body.appendChild(el);
  el.querySelector('#obs-close')?.addEventListener('click', closeObservabilityPanel);

  // Delegated recovery-button handler — survives innerHTML re-renders
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.obs-btn-recover');
    if (!btn) return;
    const harnessId = btn.dataset['harness'] ?? '';
    const reason    = btn.dataset['reason']    ?? 'failure';
    const cmdtype   = btn.dataset['cmdtype']  ?? '';
    void openRecoveryPanel(harnessId, reason, { command_type: cmdtype });
  });

  _panel = el;
  return el;
}

function _esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
