// ─── RepoCiv — Imperial Era Progression ───────────────────────────────────

export function getStoredEraLabel(): string {
  try {
    return localStorage.getItem('repociv:eraLabel') ?? 'ERA I — FUNDACIÓN';
  } catch {
    return 'ERA I — FUNDACIÓN';
  }
}
