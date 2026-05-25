// ─── RepoCiv — Wonder Capability Badges ───────────────────────────────────────
//
// Renders compact capability/contract badges for a WonderManifest.
// Pure HTML strings — no DOM dependency.
//
// Design principles:
// - Passive features: muted/subtle color
// - Agentic features: distinct color (warm/amber)
// - Opt-in features: shown as "disabled" with toggle hint
// - Safe actions: standard button style
// - Risk actions: distinct border/color

import type { WonderManifest } from './types.ts';
import { getWonderActions, getWonderOptionalFeatures } from './manifest.ts';

/** Single badge HTML for display in headers or compact lists. */
export function renderCapabilityBadge(m: WonderManifest): string {
  const parts: string[] = [];

  if (m.automationLevel === 'assist') {
    parts.push('<span class="wonder-badge wonder-badge--assist" title="Sugiere pero no ejecuta automáticamente">⚡ Asistente</span>');
  } else if (m.automationLevel === 'auto') {
    parts.push('<span class="wonder-badge wonder-badge--auto" title="Ejecuta acciones seguras automáticamente">🔄 Automático</span>');
  } else {
    parts.push('<span class="wonder-badge wonder-badge--passive" title="Solo muestra información">📖 Pasivo</span>');
  }

  if (m.agenticMode) {
    parts.push('<span class="wonder-badge wonder-badge--agentic" title="Puede sugerir acciones">🤖 Agente</span>');
  }

  return parts.join('');
}

/** Full capability detail panel for tab content or expanded views. */
export function renderCapabilityPanel(m: WonderManifest): string {
  const actions = getWonderActions(m.id);
  const features = getWonderOptionalFeatures(m.id);

  const sections: string[] = [];

  // ── Mode banner ──
  let modeText = 'Modo pasivo';
  let modeHint = 'Solo muestra información. No sugiere ni actúa.';
  if (m.automationLevel === 'assist') {
    modeText = 'Modo asistente';
    modeHint = 'Puede sugerir acciones. No ejecuta sin tu aprobación.';
  } else if (m.automationLevel === 'auto') {
    modeText = 'Modo automático';
    modeHint = 'Ejecuta acciones seguras sin pedir confirmación.';
  }

  sections.push(`
    <div class="wonder-cap-mode">
      <span class="wonder-cap-mode-icon">${m.automationLevel === 'passive' ? '📖' : m.automationLevel === 'assist' ? '⚡' : '🔄'}</span>
      <div>
        <div class="wonder-cap-mode-text">${modeText}</div>
        <div class="wonder-cap-mode-hint">${modeHint}</div>
      </div>
    </div>
  `);

  // ── Capability flags ──
  const caps: string[] = [];
  if (m.canSuggest) {
    caps.push('<span class="wonder-cap-chip wonder-cap-chip--on">💡 Sugiere</span>');
  } else {
    caps.push('<span class="wonder-cap-chip wonder-cap-chip--off">💡 No sugiere</span>');
  }
  if (m.canAct) {
    caps.push('<span class="wonder-cap-chip wonder-cap-chip--on">🛠 Puede actuar</span>');
  } else {
    caps.push('<span class="wonder-cap-chip wonder-cap-chip--off">🛠 Solo sugiere</span>');
  }
  if (m.requiresConfirmation) {
    caps.push('<span class="wonder-cap-chip wonder-cap-chip--warn">⚠️ Requiere confirmación</span>');
  }

  if (caps.length > 0) {
    sections.push(`<div class="wonder-cap-flags">${caps.join('')}</div>`);
  }

  // ── Available actions ──
  if (actions.length > 0) {
    const actionItems = actions.map((a) => {
      const riskClass = a.risk === 'safe'
        ? 'wonder-action--safe'
        : a.risk === 'approval'
          ? 'wonder-action--approval'
          : 'wonder-action--manual';
      const optInMark = a.requiresUserOptIn ? ' <span class="wonder-optin-mark">(opt-in)</span>' : '';
      return `<div class="wonder-action-item ${riskClass}">${a.label}${optInMark}</div>`;
    }).join('');
    sections.push(`<div class="wonder-cap-section"><h4>Acciones disponibles</h4><div class="wonder-action-list">${actionItems}</div></div>`);
  }

  // ── Optional features ──
  if (features.length > 0) {
    const featureItems = features.map((f) => {
      const statusIcon = f.defaultEnabled ? '✅' : '⬜';
      const statusClass = f.defaultEnabled ? 'wonder-feature--on' : 'wonder-feature--off';
      return `<div class="wonder-feature-item ${statusClass}">${statusIcon} ${f.label} <span class="wonder-feature-desc">${f.description}</span></div>`;
    }).join('');
    sections.push(`<div class="wonder-cap-section"><h4>Funciones opcionales (requieren activación)</h4><div class="wonder-feature-list">${featureItems}</div></div>`);
  }

  // ── Permissions summary ──
  if (m.permissions) {
    const perms: string[] = [];
    if (m.permissions.readRepos) perms.push('Lectura de repos');
    if (m.permissions.writeRepos) perms.push('Escritura de repos');
    perms.push(`Red: ${m.permissions.network === 'none' ? 'sin red' : 'loopback'}`);
    if (m.permissions.requiresApprovalForMutations) perms.push('Mutaciones requieren aprobation');

    if (perms.length > 0) {
      sections.push(`<div class="wonder-cap-section"><h4>Permisos</h4><div class="wonder-perm-list">${perms.map((p) => `<span class="wonder-perm-chip">${p}</span>`).join('')}</div></div>`);
    }
  }

  return `<div class="wonder-cap-panel">${sections.join('')}</div>`;
}
