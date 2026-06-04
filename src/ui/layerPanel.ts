// ─── RepoCiv — Layer Visibility Panel ─────────────────────────────────────────
// Floating panel with toggles for each map layer + Clean Map mode.
// Uses layers.ts for state management and persistence.

import type { MapLayerId } from '../types.ts';
import { getLayerState, toggleLayer, resetLayers, subscribe } from '../layers.ts';

// ─── Layer metadata ───────────────────────────────────────────────────────────
interface LayerDef {
  id: MapLayerId;
  label: string;
  icon: string;
  desc: string;
}

const LAYERS: LayerDef[] = [
  {
    id: 'base',
    label: 'Base',
    icon: '⬡',
    desc: 'Terreno, ciudades, agentes — siempre visible',
  },
  {
    id: 'structure',
    label: 'Estructura',
    icon: '🏛',
    desc: 'Edificios, maravillas, territorio de ciudades',
  },
  {
    id: 'ops',
    label: 'Ops',
    icon: '⚙',
    desc: 'Tareas, detachments subagente (líneas padre→hijo), aprobaciones',
  },
  {
    id: 'knowledge',
    label: 'Conocimiento',
    icon: '📖',
    desc: 'Conexiones de Bibliotheca, overlays de saber',
  },
  {
    id: 'labs',
    label: 'Laboratorios',
    icon: '🔬',
    desc: 'Actividad de LabHub, experimentos activos, indicadores de entrenamiento',
  },
  {
    id: 'security',
    label: 'Seguridad',
    icon: '🛡',
    desc: 'Alarmas de laboratorio, bloqueos, perímetros',
  },
  {
    id: 'labels',
    label: 'Etiquetas',
    icon: '🏷',
    desc: 'Nombres de ciudades, distritos, carpetas — control de densidad de texto',
  },
];

// ─── Panel state ──────────────────────────────────────────────────────────────
const PANEL_ID = 'layer-panel';
const CLEAN_STORAGE_KEY = 'repociv_clean_map';
let _isOpen = false;
let _cleanMode = loadCleanMode();

function loadCleanMode(): boolean {
  try {
    return localStorage.getItem(CLEAN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistCleanMode(): void {
  try {
    localStorage.setItem(CLEAN_STORAGE_KEY, _cleanMode ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

// ─── Externally settable clean-mode listener (for renderer integration) ────────
let _onCleanModeChange: ((active: boolean) => void) | null = null;
export function setOnCleanModeChange(fn: (active: boolean) => void): void {
  _onCleanModeChange = fn;
}

export function isCleanMode(): boolean {
  return _cleanMode;
}

// ─── Per-layer status: allows renderer to signal empty/loading/error ──────────
// Status drives visual cues (dim icon, pulse, red dot) via CSS data attribute.
export type LayerStatus = 'ok' | 'empty' | 'loading' | 'error';

export function setLayerStatus(id: MapLayerId, status: LayerStatus): void {
  const row = document.querySelector<HTMLElement>(
    `.layer-row input[data-layer-id="${id}"]`,
  )?.parentElement;
  if (row) row.dataset['layerStatus'] = status;
}

// ─── Build panel DOM ──────────────────────────────────────────────────────────
function buildPanel(): HTMLDivElement {
  const existing = document.getElementById(PANEL_ID);
  if (existing) return existing as HTMLDivElement;

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'hidden';

  // Header
  const header = document.createElement('div');
  header.className = 'layer-panel-header';
  header.innerHTML = '<span class="layer-panel-title">🗺 Capas del Mapa</span>';
  panel.appendChild(header);

  // Layer toggles
  const layersState = getLayerState();
  for (const def of LAYERS) {
    const row = document.createElement('label');
    row.className = 'layer-row';
    row.title = def.desc;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'layer-checkbox';
    cb.checked = layersState.layers[def.id] ?? false;
    cb.dataset['layerId'] = def.id;
    if (def.id === 'base') {
      cb.disabled = true;
      cb.checked = true;
      row.classList.add('layer-row-fixed');
    } else {
      cb.addEventListener('change', () => {
        toggleLayer(def.id);
      });
    }

    // Subscribe to external changes (e.g., resetLayers)
    subscribe((st) => {
      cb.checked = def.id === 'base' ? true : (st.layers[def.id] ?? false);
    });

    const iconSpan = document.createElement('span');
    iconSpan.className = 'layer-icon';
    iconSpan.textContent = def.icon;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'layer-label';
    labelSpan.textContent = def.label;

    row.appendChild(cb);
    row.appendChild(iconSpan);
    row.appendChild(labelSpan);
    panel.appendChild(row);
  }

  // Clean Map toggle
  const cleanRow = document.createElement('label');
  cleanRow.className = 'layer-row clean-mode-row';
  cleanRow.title = 'Modo concentración: oculta labels pequeñas, adornos y badges no críticos';

  const cleanCb = document.createElement('input');
  cleanCb.type = 'checkbox';
  cleanCb.className = 'layer-checkbox';
  cleanCb.id = 'clean-mode-toggle';
  cleanCb.checked = _cleanMode;
  cleanCb.addEventListener('change', () => {
    _cleanMode = cleanCb.checked;
    persistCleanMode();
    _onCleanModeChange?.(_cleanMode);
  });

  const cleanIcon = document.createElement('span');
  cleanIcon.className = 'layer-icon';
  cleanIcon.textContent = '🧹';

  const cleanLabel = document.createElement('span');
  cleanLabel.className = 'layer-label';
  cleanLabel.textContent = 'Mapa Limpio';

  // Separator (between layer list and clean mode — must be sibling of rows, not child of label)
  const sep = document.createElement('div');
  sep.className = 'layer-separator';
  panel.appendChild(sep);

  cleanRow.appendChild(cleanCb);
  cleanRow.appendChild(cleanIcon);
  cleanRow.appendChild(cleanLabel);
  panel.appendChild(cleanRow);

  // Zoom LOD indicator — grouped visually with a hairline separator
  const lodSep = document.createElement('div');
  lodSep.className = 'layer-separator';
  panel.appendChild(lodSep);

  const lodRow = document.createElement('div');
  lodRow.className = 'layer-lod-row';
  lodRow.id = 'layer-lod-indicator';
  lodRow.title =
    'Level of Detail: controla qué elementos se renderizan según el nivel de zoom actual';
  lodRow.innerHTML =
    '<span class="layer-lod-label">🔍 LOD:</span><span class="layer-lod-value">Auto</span>';
  panel.appendChild(lodRow);

  // Reset button
  const resetBtn = document.createElement('button');
  resetBtn.className = 'layer-reset-btn';
  resetBtn.textContent = '↺ Restablecer capas';
  resetBtn.addEventListener('click', () => {
    resetLayers();
    _cleanMode = false;
    persistCleanMode();
    const cm = document.getElementById('clean-mode-toggle') as HTMLInputElement;
    if (cm) cm.checked = false;
    _onCleanModeChange?.(false);
  });
  panel.appendChild(resetBtn);

  document.getElementById('app')?.appendChild(panel);
  return panel;
}

// ─── Update LOD display ───────────────────────────────────────────────────────
export function updateLodDisplay(zoom: number): void {
  const el = document.getElementById('layer-lod-indicator');
  if (!el) return;
  const label =
    zoom >= 1.2
      ? 'Alto (textura completa)'
      : zoom >= 0.5
        ? 'Medio (nombres + distritos)'
        : 'Bajo (solo capital)';
  el.querySelector('.layer-lod-value')!.textContent = label;
}

// ─── Toggle panel ─────────────────────────────────────────────────────────────
export function toggleLayerPanel(): void {
  const panel = buildPanel();
  _isOpen = !_isOpen;
  panel.classList.toggle('hidden', !_isOpen);
}

export function closeLayerPanel(): void {
  const panel = document.getElementById(PANEL_ID);
  if (panel) {
    _isOpen = false;
    panel.classList.add('hidden');
  }
}

export function isLayerPanelOpen(): boolean {
  return _isOpen;
}

// ─── Force rebuild on new layers being added ─────────────────────────────────
export function initLayerPanel(): void {
  buildPanel();
}
