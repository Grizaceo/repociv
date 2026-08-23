// ─── RepoCiv — Bot Mode spawner for the command bar ──────────────────────────
// Adds a "➕ Bot" control to #hero-bar-spawn that lists the REAL bots from the
// user's Bot Mode (~/.hermes/profiles/*) and spawns them onto the hex grid.
//
// Red-team invariants (from @cobalt):
//   🔒 #1  Every bot name / label is rendered with textContent — NEVER innerHTML.
//          The roster is a remote source; a bot could carry a malicious name.
//   🔒 #3  This module is strictly READ + SPAWN. It fetches
//          GET /api/harness-profiles?harness=hermes&with_identity=1 (read-only,
//          auth-gated 401) and then calls spawnFromProfile(), which only creates
//          a grid unit and writes RepoCiv-localStorage chat config. It NEVER
//          writes ~/.hermes/profiles/*, profile.yaml, or membership data.
//
// Identity comes straight from the enriched endpoint (avatar_kind / avatar_url /
// pet / face_url) and is mapped through resolveBotIdentity() — the SAME resolver
// the hex renderer and the assembly scene use, so a spawned bot looks identical
// everywhere.
import { type Renderer } from '../renderer.ts';
import { type GameState } from '../game.ts';
import { type BridgeEvents } from '../bridge.ts';
import { type RepoCivProfile } from '../agentProfile.ts';
import { bridgeUrl, bridgeHeaders } from '../bridgeEnv.ts';
import { type RosterEntry, type AvatarKind, type RosterPet, resolveBotIdentity } from '../avatarClient.ts';
import { spawnFromProfile } from './hudWiring/spawn.ts';
import { logEvent } from './hud.ts';

let _menuEl: HTMLElement | null = null;

/** Shape of a single bot in the enriched harness-profiles payload. */
interface BotModeIdentity {
  name: string;
  avatar_kind: AvatarKind;
  avatar_url: string | null;
  pet: RosterPet | null;
  face_url: string | null;
}

/**
 * READ (single request, auth-gated). Pulls the real Bot Mode bots with their
 * identity already resolved by the bridge (reuses get_roster server-side, so the
 * same source / slug-confine / no-profile.yaml guarantees apply).
 */
async function fetchBotModeBots(): Promise<RosterEntry[]> {
  const resp = await fetch(
    bridgeUrl('/api/harness-profiles?harness=hermes&with_identity=1'),
    { headers: bridgeHeaders() },
  );
  if (!resp.ok) throw new Error(`GET /api/harness-profiles → ${resp.status}`);
  const data = (await resp.json()) as {
    profiles?: BotModeIdentity[];
    identity?: BotModeIdentity[];
  };
  const list = data.profiles ?? data.identity ?? [];
  return list.map((b) => ({
    name: b.name,
    is_bot: true,
    avatar_kind: b.avatar_kind,
    avatar_url: b.avatar_url,
    pet: b.pet,
    face_url: b.face_url,
  }));
}

/** Build a RepoCivProfile for a Bot Mode bot and spawn it onto the grid. */
function spawnBotModeBot(name: string, rosterLabel: string, state: GameState, renderer: Renderer, bridge: BridgeEvents): void {
  const profile: RepoCivProfile = {
    name,
    harness: 'hermes',
    harness_ref: name,
    display_name: rosterLabel || name,
    identity_mode: 'native',
  };
  // spawnFromProfile persists only RepoCiv-localStorage chat config and creates
  // the grid unit — it does NOT mutate ~/.hermes/profiles/*. (candado #3)
  spawnFromProfile(profile, state, renderer, bridge);
  logEvent(`➕ Spawneado bot de Bot Mode: ${rosterLabel || name}`, 'info');
}

/** Close the open dropdown (called on outside-click). */
function closeMenu(): void {
  if (_menuEl) {
    _menuEl.remove();
    _menuEl = null;
    document.removeEventListener('click', onOutsideClick, true);
  }
}

function onOutsideClick(e: Event): void {
  if (!_menuEl) return;
  if (_menuEl.contains(e.target as Node)) return;
  const trigger = document.getElementById('spawn-botmode');
  if (trigger && trigger.contains(e.target as Node)) return; // handled by toggle
  closeMenu();
}

/** Open (or rebuild) the Bot Mode dropdown listing real bots with identity. */
async function openBotModeMenu(state: GameState, renderer: Renderer, bridge: BridgeEvents): Promise<void> {
  if (_menuEl) {
    closeMenu();
    return;
  }

  // Build the menu immediately so the user sees feedback even on slow/error.
  const menu = document.createElement('div');
  menu.className = 'botmode-menu';

  const trigger = document.getElementById('spawn-botmode');
  if (trigger) {
    const rect = trigger.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 6}px`;
  }
  document.body.appendChild(menu);
  _menuEl = menu;
  // Defer so this same click doesn't immediately close it.
  setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);

  const loading = document.createElement('div');
  loading.className = 'botmode-item botmode-empty';
  loading.textContent = 'Cargando bots…';
  menu.appendChild(loading);

  let bots: RosterEntry[] = [];
  try {
    bots = await fetchBotModeBots();
  } catch (err) {
    // 🔒 visible error (candado de @cobalt): never silent — show the status.
    loading.remove();
    const errItem = document.createElement('div');
    errItem.className = 'botmode-item botmode-error';
    // textContent only — never innerHTML (candado #1).
    errItem.textContent = `⚠ ${String(err)}`;
    errItem.title = 'Revisá que el bundle de Vite tenga el token (Ctrl+Shift+R)';
    menu.appendChild(errItem);
    return;
  }
  loading.remove();

  if (bots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'botmode-item botmode-empty';
    empty.textContent = 'No hay bots en Bot Mode';
    menu.appendChild(empty);
  }

  for (const entry of bots) {
    const identity = resolveBotIdentity(entry);
    const label = identity.label || entry.name;

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'botmode-item';
    // 🔒 #1: textContent only — never innerHTML. The name comes from the bridge.
    item.textContent = label;
    item.title = `Spawnear ${label} en el tablero (Bot Mode)`;

    // Small kind badge (pet/face) — drawn as text, not HTML.
    const badge = document.createElement('span');
    badge.className = 'botmode-kind';
    badge.textContent = identity.kind === 'pet' ? '🐾' : identity.kind === 'face' ? '👤' : '?';
    item.appendChild(badge);

    item.addEventListener('click', () => {
      spawnBotModeBot(entry.name, label, state, renderer, bridge);
      closeMenu();
    });
    menu.appendChild(item);
  }
}

/**
 * Wire the "➕ Bot" button. Safe to call once during startup.
 */
export function initBotModeSpawner(state: GameState, renderer: Renderer, bridge: BridgeEvents): void {
  const btn = document.getElementById('spawn-botmode');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    void openBotModeMenu(state, renderer, bridge).catch((err) => {
      logEvent(`⚠ No se pudo abrir Bot Mode: ${String(err)}`, 'error');
      closeMenu();
    });
  });
}
