import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPollRegistered,
  registerPoll,
  resetPollSchedulerForTests,
  unregisterPoll,
} from './pollScheduler.ts';

describe('pollScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
  });

  afterEach(() => {
    resetPollSchedulerForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs callback immediately on register by default', () => {
    const fn = vi.fn();
    registerPoll('test', fn, 5_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-runs callback after interval elapses', () => {
    const fn = vi.fn();
    registerPoll('test', fn, 3_000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects phaseMs when immediate is false', () => {
    const fn = vi.fn();
    registerPoll('test', fn, 5_000, { immediate: false, phaseMs: 2_500 });
    expect(fn).not.toHaveBeenCalled();
    // 1s tick granularity — first due tick after phaseMs is at 3s
    vi.advanceTimersByTime(3_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('skips ticks while document.hidden', () => {
    const fn = vi.fn();
    registerPoll('test', fn, 2_000);
    expect(fn).toHaveBeenCalledTimes(1);
    (document as { hidden: boolean }).hidden = true;
    vi.advanceTimersByTime(4_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('unregisters via returned handle and stops when empty', () => {
    const fn = vi.fn();
    const off = registerPoll('test', fn, 1_000);
    expect(isPollRegistered('test')).toBe(true);
    off();
    expect(isPollRegistered('test')).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('unregisterPoll removes a registration', () => {
    const fn = vi.fn();
    registerPoll('a', fn, 1_000);
    unregisterPoll('a');
    vi.advanceTimersByTime(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('supports multiple callbacks on one tick loop', () => {
    const a = vi.fn();
    const b = vi.fn();
    registerPoll('a', a, 2_000);
    registerPoll('b', b, 3_000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
