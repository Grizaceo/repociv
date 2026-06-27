// ─── RepoCivWebSocket unit tests (M10 pipeline) ─────────────────────────────
// Auth handshake gate, message forwarding, and exponential reconnect backoff.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoCivWebSocket } from './websocket.ts';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sentMessages: string[] = [];
  private _onopen: (() => void) | null = null;
  private _onclose: ((evt: { code: number }) => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;

  get onopen() {
    return this._onopen;
  }
  set onopen(handler) {
    this._onopen = handler;
  }

  get onclose() {
    return this._onclose;
  }
  set onclose(handler) {
    this._onclose = handler;
  }

  get onerror() {
    return null;
  }
  set onerror(_handler) {
    // noop
  }

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this._onopen?.();
  }

  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  closeConnection(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this._onclose?.({ code });
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

describe('RepoCivWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends auth token on open when configured', () => {
    const client = new RepoCivWebSocket({ url: 'ws://localhost:5275', token: 'secret' });
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    expect(ws.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws.sentMessages[0]!)).toEqual({ type: 'auth', token: 'secret' });
    client.close();
  });

  it('connects without auth when token is omitted', () => {
    const client = new RepoCivWebSocket({ url: 'ws://localhost:5275' });
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message({ type: 'auth_ok' });
    expect(client.isConnected).toBe(true);
    expect(FakeWebSocket.instances[0]!.sentMessages).toHaveLength(0);
    client.close();
  });

  it('consumes auth_ok silently — does not forward to message handlers', () => {
    const client = new RepoCivWebSocket({ url: 'ws://localhost:5275', token: 't' });
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message({ type: 'auth_ok' });
    ws.message({ type: 'log', msg: 'hello', level: 'info' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: 'log', msg: 'hello', level: 'info' });
    client.close();
  });

  it('consumes pong silently', () => {
    const client = new RepoCivWebSocket({ url: 'ws://localhost:5275' });
    const handler = vi.fn();
    client.onMessage(handler);
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message({ type: 'pong' });
    expect(handler).not.toHaveBeenCalled();
    client.close();
  });

  it('auth_error sets auth_failed and closes the client', () => {
    const client = new RepoCivWebSocket({ url: 'ws://localhost:5275', token: 'bad' });
    const statuses: string[] = [];
    client.onStatusChange((s) => statuses.push(s));
    client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.message({ type: 'auth_error', msg: 'invalid token' });
    expect(statuses).toContain('auth_failed');
    expect(client.connectionStatus).toBe('disconnected');
    client.close();
  });

  it('reconnects with exponential backoff capped at maxBackoff', async () => {
    const client = new RepoCivWebSocket({
      url: 'ws://localhost:5275',
      initialBackoff: 1000,
      maxBackoff: 8000,
    });
    client.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.closeConnection();

    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1]!.closeConnection();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances[2]!.closeConnection();
    await vi.advanceTimersByTimeAsync(4000);
    expect(FakeWebSocket.instances).toHaveLength(4);

    FakeWebSocket.instances[3]!.closeConnection();
    await vi.advanceTimersByTimeAsync(8000);
    expect(FakeWebSocket.instances).toHaveLength(5);

    FakeWebSocket.instances[4]!.closeConnection();
    await vi.advanceTimersByTimeAsync(8000);
    expect(FakeWebSocket.instances).toHaveLength(6);

    client.close();
  });

  it('resets backoff after a successful open', async () => {
    const client = new RepoCivWebSocket({
      url: 'ws://localhost:5275',
      initialBackoff: 1000,
      maxBackoff: 30000,
    });
    client.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.closeConnection();

    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.instances[1]!.open();
    FakeWebSocket.instances[1]!.closeConnection();

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    client.close();
  });

  it('does not reconnect after explicit close()', async () => {
    const client = new RepoCivWebSocket({ url: 'ws://localhost:5275', initialBackoff: 500 });
    client.connect();
    FakeWebSocket.instances[0]!.open();
    client.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('send returns false when not connected', () => {
    const client = new RepoCivWebSocket({ url: 'ws://localhost:5275' });
    expect(client.send({ type: 'ping' })).toBe(false);
  });
});
