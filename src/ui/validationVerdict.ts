// ─── RepoCiv — Validation Verdict UI presentation ────────────────────────────────────
// Pure UI module for displaying validation results in panels.
// Provides a formatter for the validator output and doesn't depend on orchestration logic.

import { escapeHtml } from './escapeHtml.ts';

export interface ValidationResult {
  verdict: 'pass' | 'fail' | 'needs-human-review';
  summary: string;
  technical_checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
  behaviour_checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
  evidence: string[];
  followups: string[];
  limitations?: string[];
}

export interface FormattedValidation {
  html: string;
  verdict: 'pass' | 'fail' | 'needs-human-review';
  verdict_label: string;
  summary_html: string;
  checks_html: string;
  limitations_html?: string;
  followups_html: string;
}

// CSS classes for each verdict tone
const VERDICT_STYLES: Record<
  ValidationResult['verdict'],
  { bg: string; border: string; color: string; label: string }
> = {
  pass: {
    bg: 'rgba(91, 155, 91, 0.15)',
    border: '#5b9b5b',
    color: '#5b9b5b',
    label: '✓ Validated',
  },
  fail: {
    bg: 'rgba(212, 75, 75, 0.15)',
    border: '#d44b4b',
    color: '#d44b4b',
    label: '✗ Validation Failed',
  },
  'needs-human-review': {
    bg: 'rgba(232, 160, 64, 0.15)',
    border: '#e8a040',
    color: '#e8a040',
    label: '⚠️ Needs Human Review',
  },
};

export function formatValidationResult(result: ValidationResult): FormattedValidation {
  const style = VERDICT_STYLES[result.verdict];

  const checksRows = result.technical_checks
    .map((check) => {
      const status = check.passed ? '✓' : '✗';
      const status_class = check.passed ? 'validated-check' : 'failed-check';
      return `<tr class="validation-check-row">
      <td class="check-status ${status_class}">${escapeHtml(status)}</td>
      <td class="check-label"><strong>${escapeHtml(check.label)}</strong></td>
      <td class="check-detail">${escapeHtml(check.detail)}</td>
    </tr>`;
    })
    .join('');

  const behaviourRows = result.behaviour_checks
    .map((check) => {
      const status = check.passed ? '✓' : '✗';
      const status_class = check.passed ? 'validated-check' : 'failed-check';
      return `<tr class="validation-check-row">
      <td class="check-status ${status_class}">${escapeHtml(status)}</td>
      <td class="check-label"><strong>${escapeHtml(check.label)}</strong></td>
      <td class="check-detail">${escapeHtml(check.detail)}</td>
    </tr>`;
    })
    .join('');

  const limitations_html = result.limitations?.length
    ? `<div class="validation-limitations">
      <h4>Why Not Verified Success?</h4>
      <ul>
        ${result.limitations.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}
      </ul>
    </div>`
    : '';

  const followups_html = result.followups.length
    ? `<div class="validation-followups">
      <h4>Recommended Follow‑up</h4>
      <ul>
        ${result.followups.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}
      </ul>
    </div>`
    : '';

  const medalImg =
    result.verdict === 'pass'
      ? '<img src="/assets/medals/shaded_medal1.png" alt="" class="validation-medal" style="width:18px;height:18px;vertical-align:middle;margin-right:6px;" />'
      : '';

  const html = `<div class="validation-result">
    <div class="validation-verdict" style="background:${style.bg}; border-color:${style.border}; color:${style.color};">
      <strong>${medalImg}${style.label}</strong>
      <p class="summary">${escapeHtml(result.summary)}</p>
    </div>

    ${
      result.technical_checks.length > 0
        ? `
      <div class="validation-section">
        <h4>Technical Checks</h4>
        <table class="validation-table">
          <thead>
            <tr>
              <th style="width: 80px;">Status</th>
              <th>Check</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            ${checksRows}
          </tbody>
        </table>
      </div>`
        : ''
    }

    ${
      result.behaviour_checks.length > 0
        ? `
      <div class="validation-section">
        <h4>Behaviour Checks</h4>
        <table class="validation-table">
          <thead>
            <tr>
              <th style="width: 80px;">Status</th>
              <th>Check</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            ${behaviourRows}
          </tbody>
        </table>
      </div>`
        : ''
    }

    ${limitations_html}

    ${followups_html}

    ${
      result.evidence.length > 0
        ? `
      <div class="validation-section">
        <h4>Evidence (from passed checks)</h4>
        <ul class="evidence-list">
          ${result.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}
        </ul>
      </div>`
        : ''
    }
  </div>`;

  return {
    html,
    verdict: result.verdict,
    verdict_label: style.label,
    summary_html: escapeHtml(result.summary),
    checks_html: checksRows,
    limitations_html,
    followups_html,
  };
}

export function renderValidationResult(container: HTMLElement, result: ValidationResult): void {
  const formatted = formatValidationResult(result);
  container.innerHTML = formatted.html;
}
