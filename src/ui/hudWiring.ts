// ─── RepoCiv — HUD orchestrator (barrel) ────────────────────────────────────
// Split en submodulos en src/ui/hudWiring/. Aqui solo el entry point + re-export.
import { type Renderer } from '../renderer.ts';
import { type GameState } from '../game.ts';
import { type BridgeEvents } from '../bridge.ts';
import { wireHotkeys } from './hudWiring/hotkeys.ts';
import { wireInputs } from './hudWiring/inputs.ts';

export { selectHero } from './hudWiring/spawn.ts';

export function wireHUD(
  renderer: Renderer,
  state: GameState,
  bridge: BridgeEvents,
  toggleView: () => void,
): void {
  wireHotkeys(renderer, state, bridge, toggleView);
  wireInputs(renderer, state, bridge);
}
