// ─── RepoCiv — Live terminal link ─────────────────────────────────────────────
// One browser attached to one herdr pane over the bridge's /terminal WebSocket.
// Binary messages are ANSI screen bytes; text messages are JSON control.
// See server/terminal_channel.py for the other end.

export interface TerminalAgent {
  paneId: string;
  terminalId: string;
  agent: string;
  status: string;
  name: string;
  folder: string;
}

export interface TerminalAttachment {
  agent: TerminalAgent;
  cols: number;
  rows: number;
  /** Scrollback as plain text: the stream itself only carries the screen. */
  history: string;
}

export interface TerminalLinkHandlers {
  onAttached(attachment: TerminalAttachment): void;
  onSize(cols: number, rows: number): void;
  onScreen(bytes: Uint8Array): void;
  onStatus(status: string): void;
  /** Input the bridge could not deliver. */
  onError(reason: string): void;
  /** The pane is gone: final. */
  onClosed(reason: string): void;
  /** The bridge will not serve this terminal: final. */
  onRefused(reason: string): void;
  /** Connection lost; another attempt comes in `retryMs`. */
  onDropped(retryMs: number): void;
}

/** Back-off between attempts; the last value repeats while the panel is open. */
export const RETRY_MS = [500, 1000, 2000, 4000, 8000] as const;

type OpenSocket = (url: string) => WebSocket;

export class TerminalLink {
  private _ws: WebSocket | null = null;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _attempt = 0;
  private _attached = false;
  private _done = false;

  constructor(
    private readonly _url: string,
    private readonly _terminalId: string,
    private readonly _on: TerminalLinkHandlers,
    private readonly _open: OpenSocket = (url) => new WebSocket(url),
  ) {}

  start(): void {
    this._connect();
  }

  /** Stop watching. The agent keeps running: only the view goes away. */
  stop(): void {
    this._done = true;
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
    this._ws?.close();
    this._ws = null;
  }

  /** False when the keys were dropped. They are never queued: a stale Ctrl+C or
   *  Enter arriving after a reconnect would hit whatever the agent does by then. */
  input(data: string): boolean {
    return this._send('input', data);
  }

  paste(data: string): boolean {
    return this._send('paste', data);
  }

  private _send(type: 'input' | 'paste', data: string): boolean {
    if (!this._attached || this._ws?.readyState !== WebSocket.OPEN) return false;
    this._ws.send(JSON.stringify({ type, data }));
    return true;
  }

  private _connect(): void {
    const ws = this._open(this._url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'attach', terminalId: this._terminalId }));
    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (this._ws === ws) this._receive(event.data);
    };
    ws.onclose = () => {
      if (this._ws === ws) this._dropped();
    };
  }

  private _receive(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      this._on.onScreen(new Uint8Array(data));
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message['type']) {
      case 'attached':
        this._attached = true;
        this._attempt = 0;
        this._on.onAttached(message as unknown as TerminalAttachment);
        break;
      case 'size':
        this._on.onSize(message['cols'] as number, message['rows'] as number);
        break;
      case 'status':
        this._on.onStatus(String(message['status']));
        break;
      case 'error':
        this._on.onError(String(message['reason']));
        break;
      case 'closed':
        this._finish();
        this._on.onClosed(String(message['reason']));
        break;
      case 'refused':
        this._finish();
        this._on.onRefused(String(message['reason']));
        break;
    }
  }

  private _finish(): void {
    this._done = true;
    this._attached = false;
    this._ws?.close();
    this._ws = null;
  }

  private _dropped(): void {
    this._attached = false;
    this._ws = null;
    if (this._done) return;
    const retryMs = RETRY_MS[Math.min(this._attempt, RETRY_MS.length - 1)] ?? 0;
    this._attempt += 1;
    this._on.onDropped(retryMs);
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this._done) this._connect();
    }, retryMs);
  }
}
