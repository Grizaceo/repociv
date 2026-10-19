// Shared font fallback for isometric rendering; empty strings are intentional.
export function monoFont(state: { tokens: Record<string, string> }): string {
  return state.tokens.fontMono ?? "'JetBrains Mono', monospace";
}
