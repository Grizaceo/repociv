// ─── RepoCiv — Terminal HUD overlay (xterm.js) ────────────────────────────────
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const OVERLAY_ID = 'terminal-overlay';

export class XTermPanel {
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private container: HTMLDivElement | null = null;
  private visible = false;
  private resizeObserver: ResizeObserver | null = null;
  private initialized = false;

  private _init(): void {
    if (this.initialized || typeof document === 'undefined') return;
    this.initialized = true;

    this.term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#484f58',
        brightBlack: '#6e7681',
        red: '#ff7b72',
        brightRed: '#ffa198',
        green: '#3fb950',
        brightGreen: '#56d364',
        yellow: '#d29922',
        brightYellow: '#e3b341',
        blue: '#58a6ff',
        brightBlue: '#79c0ff',
        magenta: '#bc8cff',
        brightMagenta: '#d2a8ff',
        cyan: '#39d353',
        brightCyan: '#56d364',
        white: '#b1bac4',
        brightWhite: '#f0f6fc',
      },
      fontFamily: '"Cascadia Code", "Fira Mono", "JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      scrollback: 2000,
      convertEol: true,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.container = this._buildContainer();
  }

  private _buildContainer(): HTMLDivElement {
    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.style.cssText = [
      'position: fixed',
      'bottom: 0',
      'left: 0',
      'right: 0',
      'height: 300px',
      'background: #0d1117',
      'border-top: 1px solid #30363d',
      'z-index: 9000',
      'display: none',
      'flex-direction: column',
    ].join(';');

    // ── Header bar ──────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = [
      'display: flex',
      'align-items: center',
      'justify-content: space-between',
      'padding: 4px 12px',
      'background: #161b22',
      'border-bottom: 1px solid #30363d',
      'user-select: none',
      'flex-shrink: 0',
    ].join(';');

    const title = document.createElement('span');
    title.textContent = '⚡ Terminal';
    title.style.cssText = 'color: #58a6ff; font-size: 12px; font-family: monospace; font-weight: 600;';
    header.appendChild(title);

    const hint = document.createElement('span');
    hint.textContent = '[T] cerrar';
    hint.style.cssText = 'color: #6e7681; font-size: 11px; font-family: monospace;';
    header.appendChild(hint);

    el.appendChild(header);

    // ── Terminal viewport ────────────────────────────────────────────────────
    const viewport = document.createElement('div');
    viewport.style.cssText = 'flex: 1; overflow: hidden; padding: 4px;';
    el.appendChild(viewport);

    document.body.appendChild(el);
    this.term!.open(viewport);

    // Fit once after mount
    requestAnimationFrame(() => this.fitAddon?.fit());

    // Re-fit on container resize
    this.resizeObserver = new ResizeObserver(() => {
      if (this.visible) this.fitAddon?.fit();
    });
    this.resizeObserver.observe(el);

    return el;
  }

  write(text: string): void {
    this._init();
    if (!this.term) return;
    this.term.write(text.endsWith('\n') ? text : text + '\r\n');
  }

  show(): void {
    this._init();
    if (this.visible || !this.container) return;
    this.visible = true;
    this.container.style.display = 'flex';
    requestAnimationFrame(() => this.fitAddon?.fit());
  }

  hide(): void {
    if (!this.visible || !this.container) return;
    this.visible = false;
    this.container.style.display = 'none';
  }

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  isVisible(): boolean {
    return this.visible;
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.term?.dispose();
    this.container?.remove();
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────
export const terminalPanel = new XTermPanel();
