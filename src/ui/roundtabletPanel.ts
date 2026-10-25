// ─── RepoCiv — RoundTablet panel ─────────────────────────────────────────────
// Bot Mode para RepoCiv: cada perfil de Hermes y cada harness externo
// (claude, codex, cursor, opencode, devin) es un bot que se puede sentar
// en la mesa redonda y deliberar sobre un tema.
//
// El panel:
//  1. Lista bots disponibles (GET /api/roundtablet/bots)
//  2. Deja seleccionar bots y un tema
//  3. Ejecuta una ronda (POST /api/roundtablet/round)
//  4. Muestra el transcript en tiempo real vía SSE (/events)

import { bridgeHeaders, bridgeUrl, BRIDGE_TOKEN } from '../bridgeEnv.ts';
import { showNotification } from './notificationBanner.ts';

type Bot = {
  id: string;
  name: string;
  type: 'hermes_profile' | 'external_harness';
  harness: string;
  unit_id: string;
  profile: string;
  label: string;
  domain: string;
  is_bot: boolean;
  avatar_url: string | null;
  pet: { id: string; displayName: string; description: string } | null;
};

type RoundtabletPanel = {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
  element: HTMLElement;
};

let panelInstance: RoundtabletPanel | null = null;

function createRoundtabletPanel(): RoundtabletPanel {
  let visible = false;
  const selectedBots = new Set<string>();
  let currentRoundId: string | null = null;
  let sse: EventSource | null = null;

  const panel = document.createElement('div');
  panel.className = 'roundtablet-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="rt-header">
      <h3>RoundTablet</h3>
      <button class="rt-close" title="Cerrar">×</button>
    </div>
    <div class="rt-body">
      <div class="rt-section">
        <label class="rt-section-title">Bots disponibles</label>
        <div class="rt-bot-list" id="rt-bot-list">
          <!-- se llena por JS -->
        </div>
      </div>
      <div class="rt-section rt-narrow">
        <label class="rt-section-title">Tema de la ronda</label>
        <input type="text" id="rt-topic" placeholder="¿Sobre qué quieren deliberar los bots?" />
        <div class="rt-selected" id="rt-selected">
          <!-- bots seleccionados -->
        </div>
        <button class="rt-start" id="rt-start" disabled>Iniciar ronda</button>
      </div>
      <div class="rt-section rt-full rt-transcript">
        <label class="rt-section-title">Transcript</label>
        <div class="rt-messages" id="rt-messages">
          <!-- mensajes -->
        </div>
        <div class="rt-status" id="rt-status">Listo.</div>
      </div>
    </div>
  `;

  const botList = panel.querySelector('#rt-bot-list')! as HTMLElement;
  const topicInput = panel.querySelector('#rt-topic')! as HTMLInputElement;
  const selectedEl = panel.querySelector('#rt-selected')! as HTMLElement;
  const startBtn = panel.querySelector('#rt-start')! as HTMLButtonElement;
  const messagesEl = panel.querySelector('#rt-messages')! as HTMLElement;
  const statusEl = panel.querySelector('#rt-status')! as HTMLElement;
  const closeBtn = panel.querySelector('.rt-close')! as HTMLButtonElement;

  // ─── Cargar bots ─────────────────────────────────────────────────────────
  async function loadBots() {
    try {
      const res = await fetch(bridgeUrl('/api/roundtablet/bots'), {
        headers: bridgeHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { bots: Bot[] };
      renderBots(data.bots);
    } catch (err) {
      showNotification({ type: 'error', title: 'Error cargando bots', body: String(err) });
    }
  }

  function renderBots(bots: Bot[]) {
    botList.innerHTML = '';
    for (const bot of bots) {
      const el = document.createElement('label');
      el.className = 'rt-bot';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = bot.id;
      input.checked = selectedBots.has(bot.id);
      el.appendChild(input);

      if (bot.avatar_url) {
        const img = document.createElement('img');
        img.className = 'rt-avatar';
        img.src = bridgeUrl(bot.avatar_url);
        img.alt = bot.label;
        el.appendChild(img);
      } else {
        const glyph = document.createElement('div');
        glyph.className = 'rt-avatar rt-avatar-glyph';
        glyph.textContent = bot.label[0] ?? '';
        el.appendChild(glyph);
      }

      const label = document.createElement('span');
      label.className = 'rt-bot-label';
      label.textContent = bot.label;
      el.appendChild(label);

      const domain = document.createElement('span');
      domain.className = 'rt-bot-domain';
      domain.textContent = bot.domain;
      el.appendChild(domain);

      input.addEventListener('change', () => {
        if (input.checked) selectedBots.add(bot.id);
        else selectedBots.delete(bot.id);
        updateStartButton();
        renderSelected();
      });
      botList.appendChild(el);
    }
  }

  function renderSelected() {
    selectedEl.innerHTML = '';
    if (selectedBots.size === 0) {
      selectedEl.textContent = 'Ningún bot seleccionado.';
      return;
    }
    for (const id of selectedBots) {
      const chip = document.createElement('span');
      chip.className = 'rt-chip';
      chip.textContent = id.replace(/^(hermes|external):/, '');
      selectedEl.appendChild(chip);
    }
  }

  function updateStartButton() {
    const topic = topicInput.value.trim();
    startBtn.disabled = selectedBots.size === 0 || topic.length === 0;
  }

  topicInput.addEventListener('input', updateStartButton);

  // ─── Transcript ──────────────────────────────────────────────────────────
  function addMessage(unit: string, text: string, isSystem = false) {
    const div = document.createElement('div');
    div.className = `rt-message ${isSystem ? 'rt-system' : ''}`;
    const strong = document.createElement('strong');
    strong.className = 'rt-message-unit';
    strong.textContent = `${isSystem ? 'Sistema' : unit}:`;
    div.appendChild(strong);
    div.appendChild(document.createTextNode(` ${text}`));
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function clearTranscript() {
    messagesEl.innerHTML = '';
  }

  // ─── SSE para transcript en tiempo real ────────────────────────────────
  function connectSSE(roundId: string) {
    if (sse) sse.close();
    const tokenQs = BRIDGE_TOKEN ? `?token=${encodeURIComponent(BRIDGE_TOKEN)}` : '';
    sse = new EventSource(bridgeUrl('/events') + tokenQs);
    sse.onmessage = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'ping') return;
        if (
          data.type === 'chat_chunk' &&
          data.missionId &&
          String(data.missionId).startsWith(roundId)
        ) {
          const unit = data.unit || 'bot';
          const text = data.text || '';
          addMessage(unit, text);
        }
        if (data.type === 'RoundTabletRoundCompleted') {
          statusEl.textContent = 'Ronda completada.';
          startBtn.disabled = false;
        }
      } catch {
        // ignorar mensajes no JSON
      }
    };
    sse.onerror = () => {
      sse?.close();
      sse = null;
    };
  }

  // ─── Ejecutar ronda ────────────────────────────────────────────────────
  async function startRound() {
    const topic = topicInput.value.trim();
    if (!topic || selectedBots.size === 0) return;

    startBtn.disabled = true;
    statusEl.textContent = 'Ejecutando ronda...';
    clearTranscript();

    try {
      const res = await fetch(bridgeUrl('/api/roundtablet/round'), {
        method: 'POST',
        headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ topic, botIds: Array.from(selectedBots) }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      currentRoundId = data.roundId as string;
      statusEl.textContent = `Ronda ${currentRoundId} iniciada — ${data.turns} turno(s).`;
      connectSSE(currentRoundId);
    } catch (err) {
      showNotification({ type: 'error', title: 'Error iniciando ronda', body: String(err) });
      startBtn.disabled = false;
      statusEl.textContent = 'Error.';
    }
  }

  startBtn.addEventListener('click', startRound);

  closeBtn.addEventListener('click', close);

  // ─── API pública ───────────────────────────────────────────────────────
  function open() {
    if (visible) return;
    visible = true;
    panel.style.display = 'block';
    loadBots();
  }

  function close() {
    if (!visible) return;
    visible = false;
    panel.style.display = 'none';
    if (sse) {
      sse.close();
      sse = null;
    }
    currentRoundId = null;
  }

  function toggle() {
    if (visible) close();
    else open();
  }

  function isOpen() {
    return visible;
  }

  return { open, close, toggle, isOpen, element: panel };
}

export function initRoundtabletPanel(container: HTMLElement): RoundtabletPanel {
  if (!panelInstance) {
    panelInstance = createRoundtabletPanel();
    container.appendChild(panelInstance.element);
  }
  return panelInstance;
}
