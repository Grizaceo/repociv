// ─── RepoCiv — Terminal HUD overlay (xterm.js) ────────────────────────────────
// An agent's real CLI: the same process and screen as a terminal attached to
// herdr, not a synced copy. Closing this panel stops the view, never the agent.
// xterm is loaded lazily (dynamic import) to keep the main bundle small.
//
// What herdr's stream does not carry shapes this file (docs/HERDR_LIVE_CLI.md):
//  · xterm always takes the PTY's size, because a smaller viewer clips the screen.
//    The font scales to fit instead.
//  · PTY modes never reach xterm, so it cannot bracket a paste: pastes bypass
//    onData and the bridge applies the pane's live mode.

import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { BRIDGE_URL, bridgeHeaders, bridgeUrl } from './bridgeEnv.ts';
import { RETRY_MS, TerminalLink } from './terminalLink.ts';
import type { TerminalAgent, TerminalAttachment } from './terminalLink.ts';
import { bindPanelAction, ensurePanel, hidePanel, showPanel } from './ui/panelShell.ts';
import { herdrHint, plainHerdrHint } from './ui/herdrHint.ts';
import type { HerdrRuntime } from './ui/herdrHint.ts';

// Small on purpose: a maximized herdr window is over 300 columns, and seeing the
// whole screen beats reading it comfortably.
const MIN_FONT_PX = 6;
const MAX_FONT_PX = 16;
const DEFAULT_FONT_PX = 13;
/** What fits a bridge WebSocket message once JSON-escaped. */
const MAX_PASTE_CHARS = 200_000;
const SCROLLBACK_LINES = 5000;
/** xterm's own scrollbar overlays the grid's right edge. */
const SCROLLBAR_PX = 14;
const WINDOW_GAP_PX = 8;
/** ESC CR: a newline in the prompt. xterm sends a plain CR for Shift+Enter. */
const NEWLINE_SEQUENCE = '\x1b\r';

const STATUS_RANK: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3 };

const REASONS: Record<string, string> = {
  terminal_requires_token: 'La terminal exige REPOCIV_TOKEN en el bridge.',
  terminal_requires_loopback: 'La terminal solo abre con el bridge en loopback.',
  origin_not_allowed:
    'Este origen no puede abrir la terminal. Ábrela desde localhost o agrégalo a REPOCIV_TERMINAL_ORIGINS.',
  unauthorized: 'El token del bridge no coincide.',
  not_an_agent_pane: 'Ese panel ya no tiene un agente.',
  pane_not_found: 'Ese panel ya no existe.',
  herdr_missing: plainHerdrHint(herdrHint('claude', { state: 'missing', version: '', minVersion: '' })),
  herdr_stopped: plainHerdrHint(herdrHint('claude', { state: 'stopped', version: '', minVersion: '' })),
  herdr_outdated: 'Esta versión de herdr es demasiado antigua.',
  herdr_incompatible: plainHerdrHint(herdrHint('claude', { state: 'incompatible', version: '', minVersion: '' })),
  unavailable: 'No pude hablar con herdr.',
  agent_starting: 'El agente todavía está arrancando. Espera a que esté listo.',
  agent_changed: 'En ese panel ya corre otro agente. No se envió.',
};

export function reasonText(reason: string): string {
  return REASONS[reason] ?? reason;
}

export function runtimeText(runtime: HerdrRuntime): string {
  if (runtime.state === 'outdated') {
    return plainHerdrHint(herdrHint('claude', runtime));
  }
  return reasonText(`herdr_${runtime.state}`);
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>;
type KeyAction = 'newline' | 'leave' | 'copy' | 'paste' | null;

/** The few keys the panel handles itself; everything else belongs to the agent. */
export function terminalKeyAction(e: KeyLike): KeyAction {
  if (e.altKey || e.metaKey) return null;
  if (e.ctrlKey && e.shiftKey) {
    const key = e.key.toLowerCase();
    if (key === 'c') return 'copy';
    if (key === 'v') return 'paste';
    return null;
  }
  if (!e.shiftKey || e.ctrlKey) return null;
  if (e.key === 'Enter') return 'newline';
  if (e.key === 'Escape') return 'leave';
  return null;
}

interface CellGrid {
  cols: number;
  rows: number;
}

/** Font that fits the PTY's grid in the space `proposed` measured at `current`. */
export function fitFontSize(current: number, proposed: CellGrid | undefined, pty: CellGrid): number {
  if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) return current;
  const scale = Math.min(proposed.cols / pty.cols, proposed.rows / pty.rows);
  const halfSteps = Math.floor(current * scale * 2) / 2;
  return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, halfSteps));
}

export function sortAgents(agents: TerminalAgent[]): TerminalAgent[] {
  const rank = (agent: TerminalAgent) => STATUS_RANK[agent.status] ?? 4;
  return [...agents].sort((a, b) => rank(a) - rank(b));
}

function terminalUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/repociv-ws/terminal`;
}

export async function fetchAgents(): Promise<{ runtime: HerdrRuntime; agents: TerminalAgent[] } | null> {
  try {
    const res = await fetch(bridgeUrl('/api/herdr/agents'), { headers: bridgeHeaders() });
    return res.ok ? ((await res.json()) as { runtime: HerdrRuntime; agents: TerminalAgent[] }) : null;
  } catch {
    return null;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────
class XTermPanel {
  private _isOpen = false;
  private _panel: HTMLElement | null = null;
  private _term: Terminal | null = null;
  private _fit: FitAddon | null = null;
  private _link: TerminalLink | null = null;
  private _target: TerminalAgent | null = null;
  private _pty: CellGrid = { cols: 80, rows: 24 };
  private _grown = false;

  /** Open on `target`, or on the last agent, or on the list of agents. */
  async open(target?: TerminalAgent): Promise<void> {
    this._isOpen = true;
    showPanel(this._mount());
    const next = target ?? this._target;
    if (next) await this._attach(next);
    else await this._showPicker();
  }

  async close(): Promise<void> {
    this.hide();
  }

  isVisible(): boolean {
    return this._isOpen;
  }

  /** While the terminal holds focus, the keyboard belongs to the agent. */
  hasFocus(): boolean {
    const active = document.activeElement;
    return Boolean(active) && this._term?.textarea === active;
  }

  hide(): void {
    this._isOpen = false;
    this._disconnect();
    if (this._panel) hidePanel(this._panel);
  }

  toggle(): void {
    if (this._isOpen) void this.close();
    else void this.open();
  }

  private _mount(): HTMLElement {
    if (this._panel) return this._panel;
    const panel = ensurePanel(
      'terminal-panel',
      'panel terminal-panel hidden',
      `<div class="terminal-header">
        <span class="terminal-title">⌨ Terminal</span>
        <span class="terminal-status hidden"></span>
        <span class="terminal-keys">Ctrl+Shift+V pega · Shift+Esc vuelve al mapa</span>
        <div class="terminal-actions">
          <button type="button" class="terminal-switch" title="Elegir otro agente" aria-label="Elegir otro agente">⇄</button>
          <button type="button" class="terminal-close" title="Cerrar [T]" aria-label="Cerrar terminal">✕</button>
        </div>
      </div>
      <div class="terminal-body">
        <div class="terminal-picker hidden"></div>
        <div class="terminal-viewport hidden"><div class="terminal-host"></div></div>
        <p class="terminal-notice hidden" role="status"></p>
      </div>`,
    );
    bindPanelAction(panel, '.terminal-close', () => this.hide());
    bindPanelAction(panel, '.terminal-switch', () => void this._showPicker());
    panel.addEventListener('paste', (event) => this._onPaste(event), true);
    this._panel = panel;
    return panel;
  }

  private _element(selector: string): HTMLElement | null {
    return this._panel?.querySelector<HTMLElement>(selector) ?? null;
  }

  private _setNotice(text: string): void {
    const notice = this._element('.terminal-notice');
    if (!notice) return;
    notice.textContent = text;
    notice.classList.toggle('hidden', text === '');
  }

  private _showView(view: 'picker' | 'terminal'): void {
    this._element('.terminal-picker')?.classList.toggle('hidden', view !== 'picker');
    this._element('.terminal-viewport')?.classList.toggle('hidden', view !== 'terminal');
  }

  private _setHeader(agent: TerminalAgent | null): void {
    const title = this._element('.terminal-title');
    if (title) {
      const where = agent ? [agent.name || agent.agent, agent.folder].filter(Boolean).join(' · ') : '';
      title.textContent = where ? `⌨ ${where}` : '⌨ Terminal';
    }
    this._setStatus(agent?.status ?? '');
  }

  private _setStatus(status: string): void {
    const badge = this._element('.terminal-status');
    if (!badge) return;
    badge.textContent = status;
    badge.className = `terminal-status terminal-status--${status}${status ? '' : ' hidden'}`;
  }

  private _disconnect(): void {
    this._link?.stop();
    this._link = null;
  }

  private async _showPicker(): Promise<void> {
    this._disconnect();
    this._restorePanel();
    this._setHeader(null);
    this._setNotice('');
    this._showView('picker');
    const picker = this._element('.terminal-picker');
    if (!picker) return;
    const say = (text: string) => {
      const line = document.createElement('div');
      line.className = 'agents-empty';
      line.textContent = text;
      picker.replaceChildren(line);
    };
    say('Buscando agentes…');
    const data = await fetchAgents();
    if (!this._isOpen || this._link) return;
    if (!data) {
      say('⚠ No pude hablar con el bridge.');
      return;
    }
    if (data.runtime.state !== 'ready') {
      say(runtimeText(data.runtime));
      return;
    }
    if (data.agents.length === 0) {
      say('herdr no tiene agentes abiertos.');
      return;
    }
    picker.replaceChildren(...sortAgents(data.agents).map((agent) => this._agentButton(agent)));
  }

  private _agentButton(agent: TerminalAgent): HTMLElement {
    const part = (tag: string, className: string, text: string) => {
      const el = document.createElement(tag);
      el.className = className;
      el.textContent = text;
      return el;
    };
    const button = part('button', 'terminal-agent', '') as HTMLButtonElement;
    button.type = 'button';
    button.append(
      part('span', 'terminal-agent-name', agent.name || agent.agent),
      part('span', 'terminal-agent-folder', agent.folder),
      part('span', `terminal-status terminal-status--${agent.status}`, agent.status),
      part('code', 'terminal-agent-pane', agent.paneId),
    );
    button.addEventListener('click', () => void this._attach(agent));
    return button;
  }

  private async _attach(target: TerminalAgent): Promise<void> {
    if (this._link && this._target?.terminalId === target.terminalId) {
      this._term?.focus();
      return;
    }
    this._disconnect();
    this._target = target;
    this._setHeader(target);
    this._showView('terminal');
    if (BRIDGE_URL) {
      this._setNotice('La terminal solo funciona a través del proxy de la interfaz.');
      return;
    }
    this._setNotice('Conectando…');
    await this._ensureTerm();
    if (!this._isOpen || this._target !== target) return;
    this._link = new TerminalLink(terminalUrl(), target.terminalId, {
      onAttached: (attachment) => this._onAttached(attachment),
      onSize: (cols, rows) => this._resize({ cols, rows }),
      onScreen: (bytes) => this._term?.write(bytes),
      onStatus: (status) => this._setStatus(status),
      onError: (reason) => this._setNotice(`⚠ No se entregó la entrada: ${reasonText(reason)}`),
      onClosed: (reason) => this._onGone(`El panel se cerró: ${reasonText(reason)}`),
      onRefused: (reason) => this._onGone(reasonText(reason)),
      onDropped: (retryMs) => this._onDropped(retryMs),
    });
    this._link.start();
  }

  private _onGone(text: string): void {
    this._link = null;
    this._setNotice(text);
  }

  private _onDropped(retryMs: number): void {
    // The first drop is usually a bridge restart: no need to alarm yet.
    const quiet = retryMs <= (RETRY_MS[0] ?? 0);
    this._setNotice(quiet ? 'Reconectando…' : '⚠ Sin conexión con el bridge. Reconectando…');
  }

  private _onAttached({ agent, cols, rows, history }: TerminalAttachment): void {
    this._setNotice('');
    this._setHeader(agent);
    this._term?.reset();
    this._resize({ cols, rows });
    // A full frame clears the screen, not the scrollback: pushing the history
    // past the visible rows keeps it from being painted over.
    if (history) this._term?.write(`${history}${'\r\n'.repeat(rows)}`);
    this._term?.focus();
  }

  private _resize(pty: CellGrid): void {
    this._pty = pty;
    this._term?.resize(pty.cols, pty.rows);
    this._restorePanel();
    this._fitFont();
    requestAnimationFrame(() => this._revealPty());
  }

  private _restorePanel(): void {
    if (!this._grown) return;
    this._grown = false;
    this._panel?.style.removeProperty('width');
    this._panel?.style.removeProperty('height');
  }

  /** The smallest font may still not fit: grow into the free screen, unless the
   *  user sized this window. Whatever stays clipped is the top of the screen,
   *  never the prompt, which agents keep on the last rows. */
  private _revealPty(): void {
    const panel = this._panel;
    const viewport = this._element('.terminal-viewport');
    const screen = this._element('.xterm-screen');
    if (!this._isOpen || !panel || !viewport || !screen) return;
    if (!panel.classList.contains('hud-window--customized')) {
      const { left, top } = panel.getBoundingClientRect();
      const needed = {
        width: panel.offsetWidth - viewport.clientWidth + screen.offsetWidth + SCROLLBAR_PX,
        height: panel.offsetHeight - viewport.clientHeight + screen.offsetHeight,
      };
      if (screen.offsetWidth > viewport.clientWidth) {
        panel.style.width = `${Math.min(needed.width, innerWidth - left - WINDOW_GAP_PX)}px`;
        this._grown = true;
      }
      if (screen.offsetHeight > viewport.clientHeight) {
        panel.style.height = `${Math.min(needed.height, innerHeight - top - WINDOW_GAP_PX)}px`;
        this._grown = true;
      }
    }
    viewport.scrollTop = viewport.scrollHeight;
  }

  private _fitFont(): void {
    const term = this._term;
    if (!term || !this._fit) return;
    const next = fitFontSize(term.options.fontSize ?? DEFAULT_FONT_PX, this._fit.proposeDimensions(), this._pty);
    if (next !== term.options.fontSize) term.options.fontSize = next;
  }

  private _onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const text = (event.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
    if (!text) return;
    if (text.length > MAX_PASTE_CHARS) {
      this._setNotice(`⚠ Texto demasiado largo para pegarlo (máximo ${MAX_PASTE_CHARS} caracteres).`);
      return;
    }
    if (!this._link?.paste(text)) this._setNotice('⚠ No se pegó: sin conexión con el agente.');
  }

  private _onKey(event: KeyboardEvent): boolean {
    const action = terminalKeyAction(event);
    if (!action) return true;
    if (event.type === 'keydown') {
      if (action === 'newline') this._link?.input(NEWLINE_SEQUENCE);
      if (action === 'leave') this._term?.blur();
      if (action === 'copy') {
        const selection = this._term?.getSelection();
        if (selection) void navigator.clipboard?.writeText(selection);
      }
    }
    if (action !== 'paste') event.preventDefault();
    return false;
  }

  private async _ensureTerm(): Promise<void> {
    if (this._term) return;
    const host = this._element('.terminal-host');
    if (!host) return;
    const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ]);
    if (this._term) return;
    const fontFamily = getComputedStyle(host).getPropertyValue('--font-mono').trim() || 'monospace';
    const term = new XTerm({
      fontFamily,
      fontSize: DEFAULT_FONT_PX,
      scrollback: SCROLLBACK_LINES,
      theme: { background: '#0b0e13', foreground: '#d7dae0', cursor: '#d7dae0' },
    });
    const fit = new Fit();
    term.loadAddon(fit);
    term.open(host);
    term.attachCustomKeyEventHandler((event) => this._onKey(event));
    term.onData((data) => {
      if (!this._link?.input(data)) this._setNotice('⚠ Sin conexión con el agente: la tecla no se envió.');
    });
    this._term = term;
    this._fit = fit;
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this._fitFont()).observe(host);
    }
  }
}

export const terminalPanel = new XTermPanel();
