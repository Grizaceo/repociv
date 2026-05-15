// ─── RepoCiv — Terminal HUD overlay (xterm.js) ────────────────────────────────
// xterm is loaded lazily (dynamic import) to keep the main bundle small.

const OVERLAY_ID = 'terminal-overlay';


// ── Singleton ────────────────────────────────────────────────────────────────
class XTermPanel {
  // xterm.js terminal overlay — loaded lazily
  async open(): Promise<void> {
    // dynamic import of xterm happens here
  }
  async close(): Promise<void> {}
}

export const terminalPanel = new XTermPanel();
