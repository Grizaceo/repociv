// ─── RepoCiv — Agent identity defaults ──────────────────────────────────────
// Single source of truth for the default user unit name in the TS client.
// Mirror of server/config_store.py:DEFAULT_UNIT_NAME.
//
// Camino A: the user can register any profile name. The bridge exposes
// /api/agents/capabilities which carries the registered profile names,
// but the *default* name (used when no profile is selected) is hardcoded
// to 'H' (Cristóbal's preference, msg 256384). If we later want this
// configurable from the TS side, fetch from /api/default-unit (TODO).
//
// The name is intentionally short ('H' = Hermes) to match the
// config_store default. The hotkey Q + spatial fallbacks use this so
// the shipped product surface stops carrying personal profile names.

export const DEFAULT_UNIT_NAME = 'H';
export const DEFAULT_HARNESS = 'hermes';
