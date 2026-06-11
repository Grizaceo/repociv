// ─── Canonical HTML-escape helper ────────────────────────────────────────────
// Single source of truth — UI submodules re-export this to keep import paths
// stable. Always escape untrusted text (agent output, repo names, bridge data)
// before interpolating into innerHTML.

export function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
