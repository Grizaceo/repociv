// ─── Pure formatters for the observability panel (plan C3) ────────────────────
// Kept DOM-free so they're unit-testable in the node test environment; the
// panel itself stays a thin renderer over these.

/** Command success rate as a percentage, or null when there's no completed/
 *  failed data yet (avoids a misleading 0%/100% on an empty ledger). */
export function successRatePct(completed: number, failed: number): number | null {
  const total = completed + failed;
  if (total <= 0) return null;
  return Math.round((completed / total) * 100);
}

/** Compact token count: 950 → "950", 12_300 → "12.3k", 4_500_000 → "4.5M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Cost estimate in USD: 0.4231 → "$0.42", 0 → "$0.00". */
export function formatCostUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  return `$${n.toFixed(2)}`;
}
