// ─── 3-layer selector: Harness / Provider / Model ──────────────────────────
import { bridgeHeaders, bridgeUrl, hermesWebUrl } from '../../bridgeEnv.ts';
import { getActiveChatUnit } from './state.ts';

interface HarnessInfo {
  id: string;
  name: string;
  transport: string;
  available: boolean;
}
interface ModelInfo {
  id: string;
  name: string;
  harnesses: string[];
  reachable?: boolean;
}
/** Live provider response from /providers/live (models have `reachable` baked in). */
interface LiveProviderInfo {
  id: string;
  models: { id: string; reachable: boolean }[];
}
interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  defaultModel: string;
  models: ModelInfo[];
  configured?: boolean;
  env?: string;
  hermesReachable?: boolean;
}

let _harnesses: HarnessInfo[] = [];
let _allProviders: ProviderInfo[] = []; // unfiltered — full list from server
let _selectedHarness = '';
let _selectedProvider = '';
let _selectedModel = '';
let _cursorAvailable = false;

/** Return providers — server already filters to only configured providers,
 *  so this just returns the full list regardless of harness. */
function _filteredProviders(): ProviderInfo[] {
  return _allProviders;
}

function newError(msg: string): Error {
  return new Error(msg);
}

export function initProviderSelectors(): void {
  const wrapper = document.getElementById('model-selector-wrapper');
  if (!wrapper) return;

  const harnessSel = document.getElementById('harness-selector') as HTMLSelectElement | null;
  const provSel = document.getElementById('provider-selector') as HTMLSelectElement | null;
  const modelSel = document.getElementById('model-selector') as HTMLSelectElement | null;

  if (harnessSel && !harnessSel.dataset['wired']) {
    harnessSel.addEventListener('change', () => {
      const prevHarness = _selectedHarness;
      _selectedHarness = harnessSel.value;
      persistSelection(getActiveChatUnit());
      // Only re-render provider list if the harness changed the filter
      if (_selectedHarness !== prevHarness) {
        _reloadProviderSelector();
      }
      updateStatusIndicator();
    });
    harnessSel.dataset['wired'] = '1';
  }
  if (provSel && !provSel.dataset['wired']) {
    provSel.addEventListener('change', () => {
      _selectedProvider = provSel.value;
      populateModels();
      persistSelection(getActiveChatUnit());
      updateStatusIndicator();
      if (_selectedModel) {
        switchHermesModel(_selectedProvider, _selectedModel);
      }
    });
    provSel.dataset['wired'] = '1';
  }
  if (modelSel && !modelSel.dataset['wired']) {
    modelSel.addEventListener('change', () => {
      _selectedModel = modelSel.value;
      persistSelection(getActiveChatUnit());
      updateStatusIndicator();
      if (_selectedModel && _selectedProvider) {
        switchHermesModel(_selectedProvider, _selectedModel);
      }
    });
    modelSel.dataset['wired'] = '1';
  }

  fetchBridgeHealth();

  fetch(bridgeUrl('/providers'), { headers: bridgeHeaders() })
    .then((r) => {
      if (!r.ok) throw newError(`HTTP ${r.status}`);
      return r.json();
    })
    .then(
      (data: {
        defaultHarness: string;
        defaultProvider: string;
        harnesses: HarnessInfo[];
        providers: ProviderInfo[];
      }) => {
        _harnesses = data.harnesses;
        _allProviders = data.providers;
        fetchLiveProviderStatus(data);
      },
    )
    .catch(() => {
      if (harnessSel) {
        harnessSel.innerHTML =
          '<option value="auto" selected>⚡ Auto</option><option value="hermes">Hermes</option>';
        _selectedHarness = 'auto';
      }
      if (provSel) {
        provSel.innerHTML = '<option value="auto" selected>⚡ Auto</option>';
        _selectedProvider = 'auto';
      }
      _selectedModel = '';
      populateModels();
      updateStatusIndicator();
    });
}

/** Re-render the provider selector dropdown using the current harness filter.
 *  Called when the harness selection changes or when a different unit chip
 *  is activated. */
function _reloadProviderSelector(): void {
  const provSel = document.getElementById('provider-selector') as HTMLSelectElement | null;
  if (!provSel) return;

  const providers = _filteredProviders();

  provSel.innerHTML = '';
  const autoProv = document.createElement('option');
  autoProv.value = 'auto';
  autoProv.textContent = '⚡ Auto';
  provSel.appendChild(autoProv);

  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    const anyReachable = p.models.some((m) => m.reachable);
    const allReachable = p.models.length > 0 && p.models.every((m) => m.reachable);
    const status = !p.available
      ? '(no disponible)'
      : allReachable
        ? ''
        : anyReachable
          ? '(parcial)'
          : '(sin conexión)';
    opt.textContent = status ? `${p.name} ${status}`.trim() : p.name;
    opt.disabled = !p.available && !anyReachable;
    provSel.appendChild(opt);
  }

  // Try to restore saved provider
  const activeUnit = getActiveChatUnit();
  const saved = loadSelection(activeUnit);
  if (saved.provider) {
    const exists = providers.find((p) => p.id === saved.provider && p.available);
    if (exists) {
      provSel.value = saved.provider;
      _selectedProvider = saved.provider;
    } else {
      provSel.value = 'auto';
      _selectedProvider = 'auto';
    }
  } else {
    provSel.value = 'auto';
    _selectedProvider = 'auto';
  }

  populateModels(saved.model);
}

/** Fetch live model reachability from the bridge's /providers/live endpoint
 *  and merge it into the provider list. Gracefully degrades on failure. */
function fetchLiveProviderStatus(data: {
  defaultHarness: string;
  defaultProvider: string;
  harnesses: HarnessInfo[];
  providers: ProviderInfo[];
}): void {
  fetch(bridgeUrl('/providers/live'), { headers: bridgeHeaders() })
    .then((lr) => {
      if (!lr.ok) return null;
      return lr.json() as Promise<{ providers: LiveProviderInfo[] } | null>;
    })
    .then((liveData) => {
      if (liveData && liveData.providers) {
        const liveMap: Record<string, LiveProviderInfo> = {};
        for (const p of liveData.providers) {
          liveMap[p.id] = p;
        }
        for (const p of _allProviders) {
          const lp = liveMap[p.id];
          if (lp && lp.models) {
            for (const m of p.models) {
              const lm = lp.models.find((x) => x.id === m.id);
              if (lm) m.reachable = lm.reachable;
            }
          }
        }
      }
      finishInit(data);
    })
    .catch(() => finishInit(data));
}

/** Shared initialization: populate DOM selectors and restore state. */
function finishInit(data: { defaultHarness: string; defaultProvider: string }): void {
  const harnessSel = document.getElementById('harness-selector') as HTMLSelectElement | null;

  if (harnessSel) {
    harnessSel.innerHTML = '';
    const autoHarness = document.createElement('option');
    autoHarness.value = 'auto';
    autoHarness.textContent = '⚡ Auto (cascade)';
    harnessSel.appendChild(autoHarness);
    for (const h of _harnesses) {
      const opt = document.createElement('option');
      opt.value = h.id;
      opt.textContent = h.available ? h.name : `${h.name} (no disponible)`;
      opt.disabled = !h.available;
      harnessSel.appendChild(opt);
    }
  }

  // Load per-unit config if a chip is already active, otherwise global.
  const activeUnit = getActiveChatUnit();
  const saved = loadSelection(activeUnit);

  if (harnessSel) {
    if (saved.harness) {
      const exists = _harnesses.find((h) => h.id === saved.harness && h.available);
      if (exists) {
        harnessSel.value = saved.harness;
        _selectedHarness = saved.harness;
      } else {
        harnessSel.value = data.defaultHarness || 'auto';
        _selectedHarness = data.defaultHarness || 'auto';
      }
    } else {
      harnessSel.value = data.defaultHarness || 'auto';
      _selectedHarness = data.defaultHarness || 'auto';
    }
  }

  // Populate provider selector (filtered by harness)
  _reloadProviderSelector();
  updateStatusIndicator();
}

/** Whether /health reports cursor-agent installed (Swarm tracking possible). */
export function isCursorTrackingAvailable(): boolean {
  return _cursorAvailable;
}

/** Passive Task tracking available for the given harness (capability table). */
export function isSwarmTrackingAvailable(harness: string): boolean {
  if (harness === 'cursor') return _cursorAvailable;
  if (harness === 'claude-code') return true;
  return false;
}

function fetchBridgeHealth(): void {
  fetch(bridgeUrl('/health'), { headers: bridgeHeaders() })
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { cursor?: boolean } | null) => {
      _cursorAvailable = !!data?.cursor;
      updateSwarmBadge();
    })
    .catch(() => {
      _cursorAvailable = false;
      updateSwarmBadge();
    });
}

function updateSwarmBadge(): void {
  const wrapper = document.getElementById('model-selector-wrapper');
  if (!wrapper) return;
  let badge = wrapper.querySelector<HTMLElement>('.swarm-tracking-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'swarm-tracking-badge';
    wrapper.appendChild(badge);
  }
  const harness = _selectedHarness || 'auto';
  if (harness === 'auto') {
    badge.textContent = _cursorAvailable ? 'Swarm: on (cursor)' : 'Swarm: off';
    return;
  }
  if (isSwarmTrackingAvailable(harness)) {
    badge.textContent = `Swarm: on (${harness})`;
    return;
  }
  if (harness === 'hermes' || harness === 'hermes-cli') {
    badge.textContent = `Swarm: limited (${harness})`;
    return;
  }
  badge.textContent = 'Swarm: off';
  badge.title = isSwarmTrackingAvailable(harness)
    ? 'Task subagents con run_in_background se trackean en Orden de batalla'
    : _cursorAvailable
      ? 'Selecciona harness cursor para ver detachments en el mapa'
      : 'cursor-agent no instalado — Swarm tracking no disponible';
}

/** Update the small status dot / tooltip showing current provider health. */
function updateStatusIndicator(): void {
  const provSel = document.getElementById('provider-selector') as HTMLSelectElement | null;
  if (!provSel) return;

  const parent = provSel.parentNode;
  const oldDot = parent?.querySelector('.selector-status-dot');
  if (oldDot) oldDot.remove();

  const providers = _filteredProviders();

  let status: 'ok' | 'warn' | 'off' = 'off';
  if (_selectedProvider === 'auto' || !_selectedProvider) {
    const anyReady = providers.some((p) => p.available && p.models.some((m) => m.reachable));
    const anyAvailable = providers.some((p) => p.available);
    status = anyReady ? 'ok' : anyAvailable ? 'warn' : 'off';
  } else {
    const prov = providers.find((p) => p.id === _selectedProvider);
    if (prov) {
      const hasReachable = prov.models.some((m) => m.reachable);
      status = prov.available && hasReachable ? 'ok' : prov.available ? 'warn' : 'off';
    }
  }

  const dot = document.createElement('span');
  dot.className = `selector-status-dot ${status}`;
  const label = _selectedProvider || 'auto';
  const reason =
    status === 'ok' ? 'disponible' : status === 'warn' ? 'parcial / sin conexión' : 'no disponible';
  dot.title = `Provider: ${label} — ${reason}`;
  parent?.insertBefore(dot, provSel);
  updateSwarmBadge();
}

/** Switch Hermes model/provider via the web server API. */
function switchHermesModel(provider: string, model: string): void {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 10_000);
  fetch(hermesWebUrl('/api/model/switch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model, session_key: 'cli', persist: false }),
    signal: ctrl.signal,
  })
    .then(async (r) => {
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        // eslint-disable-next-line no-console
        console.warn('[repociv] model switch failed:', r.status, body);
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        // eslint-disable-next-line no-console
        console.warn('[repociv] model switch error:', err);
      }
    });
}

function populateModels(savedModel?: string): void {
  const modelSel = document.getElementById('model-selector') as HTMLSelectElement;
  if (!modelSel) return;
  modelSel.innerHTML = '';

  const providers = _filteredProviders();

  if (_selectedProvider === 'auto' || !_selectedProvider) {
    modelSel.disabled = true;
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Auto';
    modelSel.appendChild(opt);
    _selectedModel = '';
    return;
  }

  modelSel.disabled = false;
  const provider = providers.find((p) => p.id === _selectedProvider);
  if (!provider) return;

  for (const m of provider.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    const reachable = m.reachable;
    const mark = reachable !== undefined ? (reachable ? ' ✓' : ' ✗ unreachable') : '';
    opt.textContent = `${m.name}${mark}`;
    if (!reachable) opt.disabled = true;
    modelSel.appendChild(opt);
  }

  if (savedModel) {
    const exists = provider.models.find((m) => m.id === savedModel);
    if (exists) {
      modelSel.value = savedModel;
      _selectedModel = savedModel;
      return;
    }
  }
  modelSel.value = provider.defaultModel;
  _selectedModel = provider.defaultModel;
}

// ─── Per-unit config storage ────────────────────────────────────────────────
// Each agent chip persists its own harness/provider/model selection so that
// switching chips restores the previous configuration for that agent.
// Key format: repociv:chatConfig:<unitId>  (falls back to repociv:chatConfig)

function _storageKey(unitId: string | null): string {
  return unitId ? `repociv:chatConfig:${unitId}` : 'repociv:chatConfig';
}

function persistSelection(unitId: string | null = null): void {
  try {
    const data = JSON.stringify({
      harness: _selectedHarness,
      provider: _selectedProvider,
      model: _selectedModel,
    });
    localStorage.setItem(_storageKey(unitId), data);
    // Always mirror to the global key so new chips without saved config
    // get the most recent global choice as their default.
    localStorage.setItem('repociv:chatConfig', data);
  } catch {
    // localStorage full or unavailable
  }
}

function loadSelection(unitId: string | null = null): {
  harness: string;
  provider: string;
  model: string;
} {
  try {
    // Try per-unit key first, fall back to global, then legacy key.
    const perUnit = unitId ? localStorage.getItem(_storageKey(unitId)) : null;
    const raw = perUnit ?? localStorage.getItem('repociv:chatConfig');
    if (raw) return JSON.parse(raw);
    const old = localStorage.getItem('repociv:provider');
    if (old) {
      const parsed = JSON.parse(old);
      return { harness: '', provider: parsed.provider || '', model: parsed.model || '' };
    }
  } catch {
    // ignore
  }
  return { harness: '', provider: '', model: '' };
}

/**
 * Restore the saved harness/provider/model config for the given unit id and
 * update the DOM selectors to match. Called by agentChip on chip-switch.
 */
export function loadConfigForUnit(unitId: string): void {
  if (!_harnesses.length && !_allProviders.length) return; // data not yet fetched
  const saved = loadSelection(unitId);

  const harnessSel = document.getElementById('harness-selector') as HTMLSelectElement | null;

  if (harnessSel) {
    const exists = saved.harness && _harnesses.find((h) => h.id === saved.harness && h.available);
    const newHarness = exists ? saved.harness : 'auto';
    if (newHarness !== _selectedHarness) {
      _selectedHarness = newHarness;
      harnessSel.value = newHarness;
      // Re-filter provider list because harness changed
      _reloadProviderSelector();
    } else {
      harnessSel.value = newHarness;
      _selectedHarness = newHarness;
    }
  } else {
    _selectedHarness = saved.harness || 'auto';
  }

  // Provider selector is already updated by _reloadProviderSelector() above
  // if harness changed. Otherwise restore the saved provider.
  const provSel = document.getElementById('provider-selector') as HTMLSelectElement | null;
  if (provSel) {
    const providers = _filteredProviders();
    const exists = saved.provider && providers.find((p) => p.id === saved.provider && p.available);
    if (exists) {
      _selectedProvider = saved.provider;
      provSel.value = saved.provider;
    } else if (provSel.value !== _selectedProvider) {
      // Only reset to auto if the current selection isn't already valid
      provSel.value = 'auto';
      _selectedProvider = 'auto';
    }
  }

  populateModels(saved.model);
  updateStatusIndicator();

  // Stamp active unit on the wrapper so CSS can show a label like "CFG: CLAUDE".
  const wrapper = document.getElementById('model-selector-wrapper');
  if (wrapper) wrapper.dataset['configUnit'] = unitId;
}

/** Get the currently selected harness, provider and model for sending to the bridge. */
export function getSelectedConfig(): { harness: string; provider: string; model: string } {
  return { harness: _selectedHarness, provider: _selectedProvider, model: _selectedModel };
}
