// ─── RepoCiv — Foreign Relations Panel ────────────────────────────────────────
// Shows existing reports and allows generating new ones.
// Launched from Gaceta: "Informe de Relaciones Exteriores" button.
// Respects the city selection from the map and allows manual override.

import type { CDailyArticle, ForeignRelationsReport } from '../types.ts';
import { generateForeignReport, listForeignReports, getForeignReport } from '../bridge.ts';

const STORAGE_LAST_REPORT = 'repociv-last-report';

interface PanelState {
  selectedArticles: CDailyArticle[];
  selectedCityId: string | null;
  selectedRepoPath: string | null;
  generating: boolean;
  currentReport: ForeignRelationsReport | null;
  recentReports: ForeignRelationsReport[];
  error: string | null;
}

const _state: PanelState = {
  selectedArticles: [],
  selectedCityId: null,
  selectedRepoPath: null,
  generating: false,
  currentReport: null,
  recentReports: [],
  error: null,
};

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function _impactEmoji(impact: string): string {
  switch (impact) {
    case 'none':
      return '⬜';
    case 'low':
      return '🟡';
    case 'medium':
      return '🟠';
    case 'high':
      return '🔴';
    case 'critical':
      return '🚨';
    default:
      return '⬜';
  }
}

function _confidenceLabel(c: number): string {
  if (c >= 0.7) return 'Alta';
  if (c >= 0.35) return 'Media';
  if (c >= 0.2) return 'Baja';
  return 'Muy baja';
}

let _mountContainer: HTMLElement | null = null;

export function openForeignRelationsPanel(
  container: HTMLElement,
  articles: CDailyArticle[],
  cityId?: string,
  repoPath?: string,
): void {
  _mountContainer = container;
  _state.selectedArticles = articles;
  _state.selectedCityId = cityId ?? null;
  _state.selectedRepoPath = repoPath ?? null;
  _state.currentReport = null;
  _state.error = null;

  _render();
  _loadRecentReports();
}

function _render(): void {
  if (!_mountContainer) return;

  const savedId = localStorage.getItem(STORAGE_LAST_REPORT);
  if (savedId && !_state.currentReport) {
    getForeignReport(savedId).then((r) => {
      const articleIds = new Set(_state.selectedArticles.map((a) => String(a.id)));
      if (r && r.articleIds.some((id) => articleIds.has(id))) {
        _state.currentReport = r;
        _renderReport();
      }
    });
  }

  _mountContainer.innerHTML = `
    <div class="foreign-relations-panel">
      <div class="panel-header">
        <span class="panel-title">🌍 Informe de Relaciones Exteriores</span>
        <button class="panel-close-btn" id="fr-close-btn">✕</button>
      </div>
      <div class="panel-body" id="fr-body">
        ${_renderSummary()}
        <div id="fr-report-area">${_state.currentReport ? _renderReportHTML() : _renderGenerateArea()}</div>
        <div id="fr-recent-reports"></div>
      </div>
    </div>
  `;

  document.getElementById('fr-close-btn')?.addEventListener('click', () => {
    if (_mountContainer) _mountContainer.innerHTML = '';
  });

  document.getElementById('fr-generate-btn')?.addEventListener('click', _doGenerate);
  document.getElementById('fr-back-btn')?.addEventListener('click', () => {
    _state.currentReport = null;
    _render();
  });

  _renderRecentReports();
}

function _renderSummary(): string {
  const articles = _state.selectedArticles;
  if (articles.length === 0) return '<div class="fr-empty">Selecciona una noticia primero</div>';
  const first = articles[0]!;
  const count = articles.length;
  return `
    <div class="fr-article-summary">
      <div class="fr-article-meta">
        <span>${esc(first.emoji ?? '📰')} ${esc(first.blogName)} · ${new Date(first.publishedDate).toLocaleDateString()}</span>
      </div>
      <div class="fr-article-title">${count === 1 ? esc(first.title) : `${esc(first.title)} + ${count - 1} noticia(s)`}</div>
      <div class="fr-article-meta">${count} noticia(s) seleccionada(s)</div>
      ${first.category ? `<span class="fr-category-badge">[${esc(first.category)}]</span>` : ''}
    </div>
  `;
}

function _renderGenerateArea(): string {
  const count = _state.selectedArticles.length;
  if (count === 0) return '';
  const cityValue = _state.selectedCityId ?? '';
  const repoValue = _state.selectedRepoPath ?? '';

  return `
    <div class="fr-generate-area">
      <div class="fr-target-info">
        <div class="fr-target-row">
          <span>🎯 Ciudad destino:</span>
          <input type="text" id="fr-city-id" class="fr-input" value="${esc(cityValue)}" placeholder="repociv / financial-lab / nombre de ciudad" />
        </div>
        <div class="fr-target-row">
          <span>📁 Repositorio:</span>
          <input type="text" id="fr-repo-path" class="fr-input" value="${esc(repoValue)}" placeholder="/home/gris/.hermes/workspace/repos/..." />
        </div>
      </div>
      <div class="fr-actions">
        <button id="fr-generate-btn" class="fr-btn fr-btn-primary" ${_state.generating ? 'disabled' : ''}>
          ${_state.generating ? '⏳ Generando...' : `🔍 Generar Informe (${count})`}
        </button>
      </div>
      ${_state.error ? `<div class="fr-error">${esc(_state.error)}</div>` : ''}
    </div>
  `;
}

function _renderReportHTML(): string {
  const r = _state.currentReport;
  if (!r) return _renderGenerateArea();

  const hasLLM = !r.llmUnavailable;
  const conf = _confidenceLabel(r.confidence);

  return `
    <div class="fr-report">
      <button id="fr-back-btn" class="fr-btn fr-btn-secondary">← Volver</button>

      <div class="fr-report-header">
        <h3>${esc(r.title)}</h3>
      </div>

      <div class="fr-report-meta">
        <span class="fr-meta-badge">${_impactEmoji(r.impact)} Impacto: ${r.impact}</span>
        <span class="fr-meta-badge">📊 Confianza: ${conf} (${(r.confidence * 100).toFixed(0)}%)</span>
        <span class="fr-meta-badge">🤖 ${esc(r.agentId)}</span>
        ${!hasLLM ? '<span class="fr-meta-badge fr-meta-warn">⚠ Solo heurísticas</span>' : ''}
        <span class="fr-meta-badge">🆔 ${r.id.slice(0, 8)}</span>
      </div>

      <div class="fr-report-section">
        <h4>Resumen</h4>
        <p>${esc(r.summary)}</p>
      </div>

      <div class="fr-report-section">
        <h4>Por qué importa</h4>
        <p>${esc(r.impact === 'none' ? 'La relación actual es débil o no clara.' : `El reporte detecta impacto ${r.impact} sobre ${r.targetCityId}.`)}</p>
      </div>

      <div class="fr-report-section">
        <h4>Seguimiento</h4>
        <p>${r.requiresFollowUp ? 'Sí, requiere seguimiento manual.' : 'No requiere seguimiento inmediato.'}</p>
      </div>

      <div class="fr-report-section">
        <h4>Evidencia utilizada</h4>
        <ul class="fr-evidence-list">
          ${r.evidence
            .map(
              (e) => `
            <li>
              <span class="fr-evidence-type">${e.type === 'article' ? '📰' : e.type === 'repo_file' ? '📁' : e.type === 'event' ? '🔔' : '🔗'}</span>
              <span class="fr-evidence-ref">${esc(e.ref)}</span>
              ${e.quote ? `<span class="fr-evidence-quote"> — ${esc(e.quote.slice(0, 120))}</span>` : ''}
            </li>
          `,
            )
            .join('')}
        </ul>
      </div>

      <div class="fr-report-section">
        <h4>Recomendaciones</h4>
        <ul class="fr-rec-list">
          ${r.recommendations
            .map(
              (rec) => `
            <li>
              <span class="fr-rec-risk ${rec.risk}">[${rec.risk}]</span>
              <span>${esc(rec.label)}</span>
            </li>
          `,
            )
            .join('')}
        </ul>
      </div>

      ${
        r.markdown
          ? `
      <div class="fr-report-section">
        <h4>Informe completo</h4>
        <pre class="fr-markdown">${esc(r.markdown.slice(0, 2500))}</pre>
      </div>
      `
          : ''
      }

      <div class="fr-report-footer">
        <small>Creado: ${new Date(r.createdAt).toLocaleString()}</small>
      </div>
    </div>
  `;
}

async function _doGenerate(): Promise<void> {
  const articles = _state.selectedArticles;
  if (articles.length === 0) return;

  const repoPathInput = document.getElementById('fr-repo-path') as HTMLInputElement | null;
  const cityIdInput = document.getElementById('fr-city-id') as HTMLInputElement | null;
  const repoPath = repoPathInput?.value.trim() ?? _state.selectedRepoPath ?? '';
  const cityId = cityIdInput?.value.trim() ?? _state.selectedCityId ?? '';

  if (!repoPath) {
    _state.error = 'Se requiere una ruta de repositorio';
    _render();
    return;
  }

  _state.generating = true;
  _state.error = null;
  _state.selectedCityId = cityId || null;
  _state.selectedRepoPath = repoPath;
  _render();

  try {
    const report = await generateForeignReport(articles, repoPath, cityId || undefined, 'diplomat');

    if (report) {
      _state.currentReport = report;
      _state.generating = false;
      localStorage.setItem(STORAGE_LAST_REPORT, report.id);
      _renderReport();
      _loadRecentReports();
    } else {
      _state.error = 'No se pudo generar el informe. Verifica que el bridge esté funcionando.';
      _state.generating = false;
      _render();
    }
  } catch (e) {
    _state.error = `Error: ${String(e)}`;
    _state.generating = false;
    _render();
  }
}

function _renderReport(): void {
  const area = document.getElementById('fr-report-area');
  if (!area) return;
  area.innerHTML = _renderReportHTML();

  document.getElementById('fr-back-btn')?.addEventListener('click', () => {
    _state.currentReport = null;
    _render();
  });
}

async function _loadRecentReports(): Promise<void> {
  const first = _state.selectedArticles[0];
  if (!first) return;
  _state.recentReports = await listForeignReports(undefined, String(first.id));
  _renderRecentReports();
}

function _renderRecentReports(): void {
  const container = document.getElementById('fr-recent-reports');
  if (!container) return;
  const reports = _state.recentReports;
  if (reports.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="fr-section-title">📋 Informes anteriores para esta noticia</div>
    <div class="fr-recent-list">
      ${reports
        .map(
          (r) => `
        <div class="fr-recent-item" data-id="${esc(r.id)}">
          <span>${_impactEmoji(r.impact)} ${esc(r.title.slice(0, 60))}</span>
          <span class="fr-recent-meta">${esc(r.targetCityId)} · ${_confidenceLabel(r.confidence)}</span>
        </div>
      `,
        )
        .join('')}
    </div>
  `;

  container.querySelectorAll('.fr-recent-item').forEach((item) => {
    item.addEventListener('click', async () => {
      const id = (item as HTMLElement).dataset['id'];
      if (!id) return;
      const report = await getForeignReport(id);
      if (report) {
        _state.currentReport = report;
        _renderReport();
      }
    });
  });
}

export function isGeneratingReport(): boolean {
  return _state.generating;
}
