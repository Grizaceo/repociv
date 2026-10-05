// ─── Bridge dispatch: unit_tool_call ────────────────────────────────────────
// The handler map is exhaustively typed over BridgeEvent['type'], so a new
// variant without a handler is a compile error. What tsc cannot catch is the
// handler quietly doing nothing — that is what this pins down.

import { describe, it, expect, vi } from 'vitest';
import { dispatchBridgeEvent, type MessageContext } from './bridgeMessageHandlers.ts';
import type { BridgeEvent } from './types.ts';

function stubContext(): MessageContext & { noteUnitActivity: ReturnType<typeof vi.fn> } {
  const noteUnitActivity = vi.fn();
  return {
    noteUnitActivity,
    state: { noteUnitActivity } as unknown as MessageContext['state'],
    logEvent: vi.fn(),
    showNotification: vi.fn(),
    setOperationTicker: vi.fn(),
    appendChatChunk: vi.fn(),
    appendApprovalCard: vi.fn(),
    terminalPanel: {} as MessageContext['terminalPanel'],
    playSound: vi.fn(),
    approveCommand: vi.fn(),
    cfg: {} as MessageContext['cfg'],
  };
}

describe('dispatchBridgeEvent — unit_tool_call', () => {
  it('forwards the unit and tool name to the local view', () => {
    const ctx = stubContext();
    dispatchBridgeEvent(ctx, {
      type: 'unit_tool_call',
      unit: 'MAIN',
      toolName: 'read_file',
      missionId: 'm1',
      cityId: 'repociv',
    } as BridgeEvent);
    expect(ctx.state.noteUnitActivity).toHaveBeenCalledWith('MAIN', 'read_file');
  });

  it('does not write a chat chunk', () => {
    // A tool call is not conversation. If this ever starts appending to chat,
    // the transcript fills with JSON noise.
    const ctx = stubContext();
    dispatchBridgeEvent(ctx, {
      type: 'unit_tool_call',
      unit: 'MAIN',
      toolName: 'bash',
    } as BridgeEvent);
    expect(ctx.appendChatChunk).not.toHaveBeenCalled();
  });

  it('does not log an event line per call', () => {
    // Tool calls fire many times a second; logging each one floods the log.
    const ctx = stubContext();
    dispatchBridgeEvent(ctx, {
      type: 'unit_tool_call',
      unit: 'MAIN',
      toolName: 'grep',
    } as BridgeEvent);
    expect(ctx.logEvent).not.toHaveBeenCalled();
  });
});
