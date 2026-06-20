import { describe, it, expect } from 'vitest';
import { successRatePct, formatTokens, formatCostUsd } from './observabilityFormat.ts';

describe('successRatePct', () => {
  it('returns null with no data (avoids misleading 0/100%)', () => {
    expect(successRatePct(0, 0)).toBeNull();
  });
  it('computes a rounded percentage', () => {
    expect(successRatePct(9, 1)).toBe(90);
    expect(successRatePct(2, 1)).toBe(67);
    expect(successRatePct(5, 0)).toBe(100);
  });
});

describe('formatTokens', () => {
  it('formats by magnitude', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(4_500_000)).toBe('4.5M');
  });
  it('guards bad input', () => {
    expect(formatTokens(-1)).toBe('—');
    expect(formatTokens(NaN)).toBe('—');
  });
});

describe('formatCostUsd', () => {
  it('formats to 2 decimals', () => {
    expect(formatCostUsd(0.4231)).toBe('$0.42');
    expect(formatCostUsd(0)).toBe('$0.00');
  });
  it('guards bad input', () => {
    expect(formatCostUsd(-2)).toBe('—');
  });
});
