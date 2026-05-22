// ─── RepoCiv — WebSocket Client ──────────────────────────────────────────────
// Bidirectional transport layer. BridgeEvents (src/bridge.ts) uses this as the
// primary transport and falls back to SSE (EventSource) when WS is unavailable.
//
// Protocol:
//   1. Connect → send auth token (if configured) → receive {type: "auth_ok"}
//   2. Bidirectional JSON messages (same schema as bridge events)
//   3. Heartbeat: server ping → client pong (automatic via WS protocol)
//   4. Reconnect: exponential backoff (1s, 2s, 4s, ... 30s max)

import { logger } from './logger.ts';

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'auth_failed';

export interface WsConfig {
  /** WebSocket URL (e.g. ws://localhost:5275) */
  url: string;
  /** Auth token (empty = no auth in dev mode) */
  token?: string;
  /** Max reconnect interval in ms (default: 30000) */
  maxBackoff?: number;
  /** Initial reconnect interval in ms (default: 1000) */
  initialBackoff?: number;
}

export type MessageHandler = (data: Record<string, unknown>) => void;
export type StatusHandler = (status: WsStatus) => void;

const DEFAULT_MAX_BACKOFF = 30_000;
const DEFAULT_INITIAL_BACKOFF = 1_000;

export class RepoCivWebSocket {
  private ws: WebSocket | null = null;
  private config: WsConfig;
  private status: WsStatus = 'disconnected';
  private backoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private healthInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: WsConfig) {
    this.config = {
      ...config,
      maxBackoff: config.maxBackoff ?? DEFAULT_MAX_BACKOFF,
      initialBackoff: config.initialBackoff ?? DEFAULT_INITIAL_BACKOFF,
    };
    this.backoff = this.config.initialBackoff!;
  }

  /** Current connection status */
  get connectionStatus(): WsStatus {
    return this.status;
  }

  /** Whether the socket is connected and authenticated */
  get isConnected(): boolean {
    return this.status === 'connected';
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Open the WebSocket connection */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return; // Already connected or connecting
    }
    this.closed = false;
    this._setStatus('connecting');
    this._doConnect();
  }

  /** Close the WebSocket connection and stop reconnecting */
  close(): void {
    this.closed = true;
    this._clearTimers();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'client close');
      }
      this.ws = null;
    }
    this._setStatus('disconnected');
  }

  // ─── Send ───────────────────────────────────────────────────────────────

  /** Send a JSON message. Returns false if not connected. */
  send(data: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('[ws] cannot send — not connected');
      return false;
    }
    try {
      this.ws.send(JSON.stringify(data));
      return true;
    } catch (err) {
      logger.warn('[ws] send error:', err);
      return false;
    }
  }

  /** Send a command to the bridge (type + data) */
  sendCommand(type: string, payload: Record<string, unknown> = {}): boolean {
    return this.send({ type, ...payload });
  }

  // ─── Event handlers ─────────────────────────────────────────────────────

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private _doConnect(): void {
    if (this.closed) return;
    try {
      const ws = new WebSocket(this.config.url);
      this.ws = ws;

      ws.onopen = () => {
        if (ws !== this.ws) return; // Stale connection
        logger.log('[ws] connected to', this.config.url);
        this.backoff = this.config.initialBackoff!;
        this._sendAuth();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (ws !== this.ws) return;
        try {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          this._handleMessage(data);
        } catch {
          logger.warn('[ws] invalid JSON:', event.data);
        }
      };

      ws.onclose = (event: CloseEvent) => {
        if (ws !== this.ws) return;
        this.ws = null;
        logger.log(`[ws] closed (code=${event.code})`);
        if (!this.closed) {
          this._setStatus('disconnected');
          this._scheduleReconnect();
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    } catch (err) {
      logger.warn('[ws] connection error:', err);
      if (!this.closed) {
        this._setStatus('disconnected');
        this._scheduleReconnect();
      }
    }
  }

  private _sendAuth(): void {
    if (!this.ws) return;
    const token = this.config.token;
    if (token) {
      this.send({ type: 'auth', token });
      // Wait for auth_ok response; temporarily handle it in message loop
      // If auth fails, connection will be closed by server
      this._setStatus('connected'); // Optimistic — server rejects if invalid
    } else {
      this._setStatus('connected');
    }
  }

  private _handleMessage(data: Record<string, unknown>): void {
    const msgType = data.type as string;

    // Handle auth responses
    if (msgType === 'auth_error') {
      logger.error('[ws] auth failed:', data.msg);
      this._setStatus('auth_failed');
      this.close();
      return;
    }

    // Handle pong (server heartbeat response)
    if (msgType === 'pong') return;

    // Forward to registered handlers
    for (const handler of this.messageHandlers) {
      try {
        handler(data);
      } catch (err) {
        logger.warn('[ws] handler error:', err);
      }
    }
  }

  private _setStatus(status: WsStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch {
        // ignore handler errors
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoff;
    logger.log(`[ws] reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(this.backoff * 2, this.config.maxBackoff!);
      this._doConnect();
    }, delay);
  }

  private _clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }
}
