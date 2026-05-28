// ─── RepoCiv — Terminal HUD overlay (xterm.js) ────────────────────────────────
// xterm is loaded lazily (dynamic import) to keep the main bundle small.

// ── Singleton ────────────────────────────────────────────────────────────────
class XTermPanel {
  private _isOpen = false;

  async open(): Promise<void> {
    this._isOpen = true;
  }

  async close(): Promise<void> {
    this._isOpen = false;
  }

  write(_text: string): void {}

  isVisible(): boolean {
    return this._isOpen;
  }

  hide(): void {
    this._isOpen = false;
  }

  toggle(): void {
    if (this._isOpen) this.close();
    else void this.open();
  }
}

export const terminalPanel = new XTermPanel();
