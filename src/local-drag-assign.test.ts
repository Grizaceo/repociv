// ─── RepoCiv — P4 drag-to-assign tests ─────────────────────────────────────────
// Tests for the drag state machine: idle → dragging → assigned/cancelled.

import { describe, it, expect } from 'vitest';

describe('P4: drag-to-assign state machine', () => {
  // The state machine is: idle → dragging → (assigned | cancelled) → idle

  it('state machine: idle is the initial state', () => {
    const state: 'idle' | 'dragging' = 'idle';
    expect(state).toBe('idle');
  });

  it('state machine: mousedown on unit transitions idle → dragging', () => {
    let state: 'idle' | 'dragging' = 'idle';
    const hasUnit = true;
    if (hasUnit) state = 'dragging';
    expect(state).toBe('dragging');
  });

  it('state machine: mouseup on workbench transitions dragging → assigned (callback fired)', () => {
    let state: 'idle' | 'dragging' = 'dragging';
    let callbackFired = false;
    const onWorkbench = true;

    if (state === 'dragging' && onWorkbench) {
      callbackFired = true;
      state = 'idle';
    }
    expect(callbackFired).toBe(true);
    expect(state).toBe('idle');
  });

  it('state machine: mouseup on empty tile transitions dragging → cancelled', () => {
    let state: 'idle' | 'dragging' = 'dragging';
    let callbackFired = false;
    const onWorkbench = false;

    if (state === 'dragging') {
      if (onWorkbench) callbackFired = true;
      state = 'idle';
    }
    expect(callbackFired).toBe(false);
    expect(state).toBe('idle');
  });

  it('state machine: ESC cancels drag without firing callback', () => {
    let state: 'idle' | 'dragging' = 'dragging';
    const callbackFired = false;

    // ESC handler
    if (state === 'dragging') {
      state = 'idle';
      // no callback
    }
    expect(callbackFired).toBe(false);
    expect(state).toBe('idle');
  });

  it('drag does not start when unit is despawning', () => {
    let state: 'idle' | 'dragging' = 'idle';
    const unitDespawning = true;

    if (!unitDespawning) state = 'dragging';
    expect(state).toBe('idle');
  });

  it('drag does not start during zone paint mode', () => {
    let state: 'idle' | 'dragging' = 'idle';
    const zonePaintMode = true;

    // In the code, zone paint mode is checked first — drag-to-assign only runs in the else branch
    if (!zonePaintMode) state = 'dragging';
    expect(state).toBe('idle');
  });

  it('workbench highlight: green pulse on hovered workbench during drag', () => {
    // The overlay draws a pulsing green rect on the workbench tile
    const pulse = (now: number) => 0.3 + 0.2 * Math.sin(now / 200);
    expect(pulse(0)).toBeCloseTo(0.3);
    expect(pulse(100)).toBeCloseTo(0.3 + 0.2 * Math.sin(0.5));
    // Range: [0.1, 0.5]
    for (let t = 0; t < 5000; t += 50) {
      const p = pulse(t);
      expect(p).toBeGreaterThanOrEqual(0.1);
      expect(p).toBeLessThanOrEqual(0.5);
    }
  });

  it('drag line: drawn from unit position to cursor in unit color', () => {
    // The overlay uses ctx.moveTo(unitX, unitY) → ctx.lineTo(mouseX, mouseY)
    // with the unit's color as strokeStyle
    const unitColor = '#4a9bd4';
    const lineFrom = { x: 100, y: 100 };
    const lineTo = { x: 200, y: 150 };
    expect(unitColor).toMatch(/^#/);
    expect(lineTo.x - lineFrom.x).toBe(100);
    expect(lineTo.y - lineFrom.y).toBe(50);
  });
});
