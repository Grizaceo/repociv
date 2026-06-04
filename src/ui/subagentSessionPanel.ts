// ─── Subagent session viewer — progress + output paths ───────────────────────
import type { GameState } from '../game.ts';
import type { SubagentRun } from '../types.ts';
import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';

function sessionStatusLabel(status: SubagentRun['status']): string {
  if (status === 'proposed') return 'pending';
  if (status === 'running') return 'working';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'done';
}

let _state: GameState | null = null;

export function bindSubagentSessionPanel(state: GameState): void {
  _state = state;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function guessTranscriptHint(harness: string): string {
  const h = (harness || '').toLowerCase();
  if (h.includes('cursor')) {
    return '~/.cursor/projects/<workspace>/agent-transcripts/<uuid>.jsonl';
  }
  return '';
}

function findRun(state: GameState, subagentId: string): SubagentRun | undefined {
  return (
    state.subagents.get(subagentId) ??
    state.completedSubagents.find((s) => s.id === subagentId)
  );
}

export function openSubagentSession(subagentId: string | null | undefined): boolean {
  const state = _state;
  if (!state || !subagentId) return false;
  const run = findRun(state, subagentId);
  if (!run) return false;

  const panel = document.getElementById('subagent-session-panel');
  if (!panel) return false;

  const progress = state.subagentProgress.get(subagentId) ?? [];
  const d = sessionStatusLabel(run.status);
  const harness = run.harness ?? run.parentHarness ?? '—';
  const outputPath = run.outputFilePath ?? '';
  const transcriptHint = guessTranscriptHint(harness);

  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="subagent-session-inner">
      <header class="subagent-session-header">
        <span class="subagent-session-title">Sesión subagente</span>
        <button type="button" class="subagent-session-close" aria-label="Cerrar">×</button>
      </header>
      <div class="subagent-session-meta">
        <span class="orden-status orden-status--${d}">${escapeHtml(d)}</span>
        <span class="subagent-session-id">${escapeHtml(run.id)}</span>
      </div>
      <div class="subagent-session-field"><strong>Etiqueta</strong> ${escapeHtml(run.label)}</div>
      <div class="subagent-session-field"><strong>Harness</strong> <code>${escapeHtml(harness)}</code> · ${escapeHtml(run.kind)} · ${escapeHtml(run.risk)}</div>
      ${
        run.summary
          ? `<div class="subagent-session-field"><strong>Resumen</strong><pre class="subagent-session-summary">${escapeHtml(run.summary)}</pre></div>`
          : ''
      }
      <div class="subagent-session-field"><strong>Progreso</strong></div>
      <pre class="subagent-session-progress">${progress.length ? escapeHtml(progress.join('\n')) : '(sin eventos aún)'}</pre>
      ${
        outputPath
          ? `<div class="subagent-session-field"><strong>Salida</strong><code class="subagent-session-path">${escapeHtml(outputPath)}</code>
             <button type="button" class="subagent-session-copy" data-path="${escapeHtml(outputPath)}">Copiar ruta</button></div>`
          : ''
      }
      ${
        transcriptHint
          ? `<p class="subagent-session-hint">Transcripts Cursor: <code>${escapeHtml(transcriptHint)}</code> (no enlazado automáticamente al id <code>sub-*</code>).</p>`
          : ''
      }
      <p class="subagent-session-hint">Recall (cancel) solo detiene procesos hijo si el bridge tiene PID. Cursor Task sigue en segundo plano.</p>
    </div>
  `;

  panel.querySelector('.subagent-session-close')?.addEventListener('click', closeSubagentSession);
  panel.querySelector('.subagent-session-copy')?.addEventListener('click', (e) => {
    const path = (e.currentTarget as HTMLElement).dataset['path'];
    if (path) void navigator.clipboard.writeText(path);
  });
  return true;
}

export function closeSubagentSession(): void {
  const panel = document.getElementById('subagent-session-panel');
  if (panel) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
}

export function isSubagentSessionOpen(): boolean {
  const panel = document.getElementById('subagent-session-panel');
  return !!panel && !panel.classList.contains('hidden');
}

export async function recallSubagent(subagentId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(bridgeUrl('/subagents/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify({ subagentId }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; note?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, message: data.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, message: data.note ?? 'cancelled' };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}
