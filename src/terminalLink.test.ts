import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRY_MS, TerminalLink } from './terminalLink.ts';
import type { TerminalLinkHandlers } from './terminalLink.ts';

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: object | ArrayBuffer): void {
    this.onmessage?.({ data: data instanceof ArrayBuffer ? data : JSON.stringify(data) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const ATTACHED = { type: 'attached', agent: {}, cols: 80, rows: 24, history: '' };

function handlers(): TerminalLinkHandlers & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onAttached: vi.fn(),
    onSize: vi.fn(),
    onScreen: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
    onClosed: vi.fn(),
    onRefused: vi.fn(),
    onDropped: vi.fn(),
  };
}

function link(on = handlers()) {
  const sockets: FakeSocket[] = [];
  const instance = new TerminalLink('ws://x/terminal', 'term_a', on, () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  instance.start();
  return { instance, sockets, on };
}

describe('TerminalLink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('attaches on open and asks for binary frames', () => {
    const { sockets } = link();
    sockets[0]!.open();
    expect(sockets[0]!.binaryType).toBe('arraybuffer');
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'attach', terminalId: 'term_a' });
  });

  it('routes binary to the screen and JSON to its handler', () => {
    const { sockets, on } = link();
    sockets[0]!.open();
    sockets[0]!.message(ATTACHED);
    sockets[0]!.message(new Uint8Array([65, 66]).buffer);
    sockets[0]!.message({ type: 'size', cols: 74, rows: 29 });
    sockets[0]!.message({ type: 'status', status: 'blocked' });
    expect(on.onAttached).toHaveBeenCalledTimes(1);
    expect(on.onScreen).toHaveBeenCalledWith(new Uint8Array([65, 66]));
    expect(on.onSize).toHaveBeenCalledWith(74, 29);
    expect(on.onStatus).toHaveBeenCalledWith('blocked');
  });

  it('keeps keystrokes and pastes apart on the wire', () => {
    const { instance, sockets } = link();
    sockets[0]!.open();
    sockets[0]!.message(ATTACHED);
    sockets[0]!.sent.length = 0;
    expect(instance.input('\x1b')).toBe(true);
    expect(instance.paste('a\nb')).toBe(true);
    expect(sockets[0]!.sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([
      { type: 'input', data: '\x1b' },
      { type: 'paste', data: 'a\nb' },
    ]);
  });

  it('attaches without a screen and sends a submit only while attached', () => {
    const on = { ...handlers(), onSubmitResult: vi.fn() };
    const socket = new FakeSocket();
    const instance = new TerminalLink(
      'ws://x/terminal',
      'term_a',
      on,
      () => socket as unknown as WebSocket,
      { screen: false },
    );
    instance.start();
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'attach',
      terminalId: 'term_a',
      screen: false,
    });
    expect(instance.submit('one', 'hello')).toBe(false);
    socket.message(ATTACHED);
    expect(instance.submit('one', 'hello')).toBe(true);
    expect(JSON.parse(socket.sent[1]!)).toEqual({ type: 'submit', id: 'one', text: 'hello' });
    socket.message({ type: 'submit_result', id: 'one', state: 'confirmed', reason: null });
    expect(on.onSubmitResult).toHaveBeenCalledWith({ id: 'one', state: 'confirmed', reason: null });
    socket.drop();
    expect(instance.submit('two', 'never queued')).toBe(false);
    vi.advanceTimersByTime(RETRY_MS[0]);
    expect(socket.sent.filter((m) => JSON.parse(m).type === 'submit')).toHaveLength(1);
  });

  it('drops keys typed before the attach instead of sending them blind', () => {
    const { instance, sockets } = link();
    sockets[0]!.open();
    expect(instance.input('x')).toBe(false);
    expect(sockets[0]!.sent).toHaveLength(1);
  });

  it('never replays keys typed during an outage', () => {
    const { instance, sockets } = link();
    sockets[0]!.open();
    sockets[0]!.message(ATTACHED);
    sockets[0]!.drop();
    expect(instance.input('\x03')).toBe(false);
    vi.advanceTimersByTime(RETRY_MS[0]);
    sockets[1]!.open();
    sockets[1]!.message(ATTACHED);
    expect(
      sockets[1]!.sent.map((raw) => JSON.parse(raw) as { type: string }).map((m) => m.type),
    ).toEqual(['attach']);
  });

  it('reconnects with back-off, and an attach resets it', () => {
    const { sockets, on } = link();
    sockets[0]!.open();
    sockets[0]!.drop();
    expect(on.onDropped).toHaveBeenLastCalledWith(RETRY_MS[0]);
    vi.advanceTimersByTime(RETRY_MS[0]);
    sockets[1]!.drop();
    expect(on.onDropped).toHaveBeenLastCalledWith(RETRY_MS[1]);
    vi.advanceTimersByTime(RETRY_MS[1]);
    sockets[2]!.open();
    sockets[2]!.message(ATTACHED);
    sockets[2]!.drop();
    expect(on.onDropped).toHaveBeenLastCalledWith(RETRY_MS[0]);
  });

  it('caps the back-off instead of giving up', () => {
    const { sockets, on } = link();
    for (let i = 0; i < RETRY_MS.length + 2; i += 1) {
      sockets[i]!.drop();
      vi.advanceTimersByTime(60_000);
    }
    expect(on.onDropped).toHaveBeenLastCalledWith(RETRY_MS[RETRY_MS.length - 1]);
  });

  it.each([
    ['closed', 'onClosed'],
    ['refused', 'onRefused'],
  ])('does not retry after %s: those are final', (type, handler) => {
    const { sockets, on } = link();
    sockets[0]!.open();
    sockets[0]!.message({ type, reason: 'why' });
    sockets[0]!.drop();
    vi.advanceTimersByTime(60_000);
    expect(on[handler]).toHaveBeenCalledWith('why');
    expect(on.onDropped).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it('stop closes the socket and cancels a pending retry', () => {
    const { instance, sockets } = link();
    sockets[0]!.open();
    sockets[0]!.drop();
    instance.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('ignores a socket that was already replaced', () => {
    const { instance, sockets, on } = link();
    sockets[0]!.open();
    instance.stop();
    sockets[0]!.message(ATTACHED);
    sockets[0]!.drop();
    expect(on.onAttached).not.toHaveBeenCalled();
    expect(on.onDropped).not.toHaveBeenCalled();
  });
});
