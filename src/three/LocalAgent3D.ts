// ─── Local view: agent figurines (LocalUnit + LocalNpc) ────────────────────
// Manages 3D figurines for agents in the local view. Reuses the GLB worker
// figurine from UnitProps3D.ts with per-agent tinted shirt, or falls back to
// a procedural cone+sphere. Mirrors UnitMesh3D patterns: incremental
// add/remove, spawn/despawn tweens, idle pulse, walking hop.

import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

import type { LocalUnit, LocalNpc } from '../types.ts';
import { areUnitPropsReady, getUnitPropParts } from './UnitProps3D.ts';
import { localGridToWorld3D } from './LocalCamera3D.ts';
import { HEX_SIZE } from '../constants.ts';

const HERO_TYPES = new Set(['hero', 'lexo', 'claude', 'codex', 'cursor', 'openclaw']);

type AgentLifeState = 'spawning' | 'alive' | 'despawning';

interface AgentEntry {
  group: Group;
  unitId: string;
  lifeState: AgentLifeState;
  /** Tween progress 0->1 for spawn, 1->0 for despawn. */
  tween: number;
  /** Per-unit phase offset for idle pulse. */
  idlePhase: number;
  /** Current hop height (0 when grounded). */
  hopY: number;
  /** Whether this agent is currently moving (drives hop animation). */
  moving: boolean;
  /** Current interpolated world position. */
  currentPos: Vector3;
  /** Path for movement tween (grid coords). */
  path: Array<{ x: number; y: number }>;
  /** Current step in path. */
  pathIndex: number;
  /** Progress between path steps (0-1). */
  pathProgress: number;
  /** Despawn fade alpha (1.0 = visible, 0.0 = invisible). */
  fadeAlpha: number;
}

/** Manages all local agent figurines (LocalUnits + LocalNpcs).
 *  Reuses the UnitMesh3D pattern: incremental add/remove, spawn/despawn tweens,
 *  idle pulse, per-step walking hop. */
export class LocalAgent3D {
  private group: Group;
  private entries = new Map<string, AgentEntry>();
  private lastSignature = '';

  constructor() {
    this.group = new Group();
    this.group.name = 'local-agents';
  }

  getGroup(): Group {
    return this.group;
  }

  /** Incremental add/remove/update. Called from render() with dirty flag. */
  update(units: LocalUnit[], npcs: LocalNpc[] = [], dt: number): void {
    const sig = this.computeSignature(units, npcs);
    const dirty = sig !== this.lastSignature;
    this.lastSignature = sig;

    if (dirty) {
      this.reconcile(units, npcs);
    }

    // Per-frame animations (always run, independent of dirty flag)
    this.tickAnimations(units, npcs, dt);
  }

  private computeSignature(units: LocalUnit[], npcs: LocalNpc[]): string {
    return [
      units.length,
      npcs.length,
      units.map(u => `${u.id}:${u.gridX},${u.gridY}:${u.state}:${u.despawning ? 'd' : 'a'}`).join('|'),
      npcs.map(n => `${n.id}:${n.gridX},${n.gridY}`).join('|'),
    ].join('#');
  }

  private reconcile(units: LocalUnit[], npcs: LocalNpc[]): void {
    const currentIds = new Set<string>();
    for (const u of units) currentIds.add(u.id);
    for (const n of npcs) currentIds.add(n.id);

    // Despawn removed units (start despawn tween, remove when complete)
    for (const [id, entry] of this.entries) {
      if (!currentIds.has(id) && entry.lifeState !== 'despawning') {
        entry.lifeState = 'despawning';
        entry.tween = 1.0;
      }
    }

    // Spawn new units
    for (const unit of units) {
      if (!this.entries.has(unit.id)) {
        this.spawnAgent(unit.id, unit.color, HERO_TYPES.has(unit.unitType));
      }
    }
    for (const npc of npcs) {
      if (!this.entries.has(npc.id)) {
        this.spawnAgent(npc.id, npc.color, false);
      }
    }
  }

  private spawnAgent(id: string, color: string, isHero: boolean): void {
    const group = this.buildFigurine(isHero, new Color(color));
    group.castShadow = true;
    const entry: AgentEntry = {
      group,
      unitId: id,
      lifeState: 'spawning',
      tween: 0,
      idlePhase: Math.random() * Math.PI * 2,
      hopY: 0,
      moving: false,
      currentPos: new Vector3(),
      path: [],
      pathIndex: 0,
      pathProgress: 0,
      fadeAlpha: 1.0,
    };
    this.entries.set(id, entry);
    this.group.add(group);
  }

  /** Build a figurine: GLB if loaded, procedural fallback otherwise.
   *  Reuses the exact pattern from UnitMesh3D.buildGlbFigurine. */
  private buildFigurine(isHero: boolean, col: Color): Group {
    if (areUnitPropsReady()) {
      const group = new Group();
      const parts = getUnitPropParts()!;
      parts.forEach((part, i) => {
        const mat = (part.material as MeshStandardMaterial).clone();
        if (i === 1) {
          mat.color.lerp(col, 0.55);
          mat.emissive.copy(col);
          mat.emissiveIntensity = isHero ? 0.4 : 0.22;
        }
        const mesh = new Mesh(part.geometry, mat);
        mesh.applyMatrix4(part.matrix);
        mesh.userData.sharedGeometry = true;
        mesh.castShadow = true;
        group.add(mesh);
      });
      const s = HEX_SIZE * (isHero ? 0.44 : 0.38);
      group.scale.setScalar(s);
      const wrapper = new Group();
      wrapper.add(group);
      return wrapper;
    }

    // Procedural fallback: cone + sphere
    const group = new Group();
    const bodyMat = new MeshStandardMaterial({
      color: col,
      emissive: col,
      emissiveIntensity: isHero ? 0.45 : 0.25,
      roughness: 0.55,
      metalness: isHero ? 0.35 : 0.1,
    });
    const base = new Mesh(new CylinderGeometry(HEX_SIZE * 0.1, HEX_SIZE * 0.13, HEX_SIZE * 0.04, 8), bodyMat);
    base.position.y = HEX_SIZE * 0.02;
    base.castShadow = true;
    group.add(base);
    const body = new Mesh(new ConeGeometry(HEX_SIZE * 0.065, HEX_SIZE * 0.22, 8), bodyMat);
    body.position.y = HEX_SIZE * 0.15;
    body.castShadow = true;
    group.add(body);
    const headR = HEX_SIZE * (isHero ? 0.072 : 0.058);
    const head = new Mesh(new SphereGeometry(headR, 8, 6), bodyMat);
    head.position.y = HEX_SIZE * 0.04 + HEX_SIZE * 0.22 + headR;
    head.castShadow = true;
    group.add(head);
    return group;
  }

  /** Per-frame: advance spawn/despawn tweens, idle pulse, walking hop,
   *  position interpolation. Mirrors UnitMesh3D.tickUnits. */
  private tickAnimations(units: LocalUnit[], npcs: LocalNpc[], dt: number): void {
    type AgentAnim = {
      id: string;
      gridX: number;
      gridY: number;
      path: Array<{ x: number; y: number }>;
      pathIndex: number;
      pathProgress: number;
      moving: boolean;
      fadeAlpha: number;
      despawning: boolean;
    };
    const allAgents: AgentAnim[] = [
      ...units.map(u => ({
        id: u.id,
        gridX: u.gridX,
        gridY: u.gridY,
        path: u.path,
        pathIndex: u.pathIndex,
        pathProgress: u.pathProgress,
        moving: u.state === 'walking_to_workbench' || u.state === 'walking_to_room',
        fadeAlpha: u.fadeAlpha ?? 1.0,
        despawning: u.despawning ?? false,
      })),
      ...npcs.map(n => ({
        id: n.id,
        gridX: n.gridX,
        gridY: n.gridY,
        path: [],
        pathIndex: 0,
        pathProgress: 0,
        moving: false,
        fadeAlpha: 1.0,
        despawning: false,
      })),
    ];

    for (const agent of allAgents) {
      const entry = this.entries.get(agent.id);
      if (!entry) continue;

      this.tickOne(agent, entry, dt);
    }

    // Tick despawning agents that are no longer in the input arrays.
    // They exist only in this.entries with lifeState 'despawning' and need
    // their tween to complete so they can be removed.
    for (const [id, entry] of this.entries) {
      if (entry.lifeState !== 'despawning') continue;
      if (allAgents.some(a => a.id === id)) continue;
      // Advance despawn tween only; no path/moving/idle needed.
      entry.tween -= dt * 5;
      if (entry.tween <= 0) {
        this.group.remove(entry.group);
        this.entries.delete(id);
        continue;
      }
      entry.group.scale.setScalar(entry.tween);
    }
  }

  private tickOne(
    agent: { id: string; gridX: number; gridY: number; path: Array<{ x: number; y: number }>; pathIndex: number; pathProgress: number; moving: boolean; fadeAlpha: number; despawning: boolean },
    entry: AgentEntry,
    dt: number,
  ): void {
    let gx = agent.gridX;
    let gy = agent.gridY;
    if (agent.path.length > 0 && agent.pathIndex < agent.path.length) {
      const from = agent.path[agent.pathIndex]!;
      const to = agent.path[Math.min(agent.pathIndex + 1, agent.path.length - 1)]!;
      const t = agent.pathProgress;
      gx = from.x + (to.x - from.x) * t;
      gy = from.y + (to.y - from.y) * t;
    }
    const targetPos = localGridToWorld3D(gx, gy, 0);
    entry.currentPos.lerp(targetPos, Math.min(1, dt * 8));
    entry.group.position.copy(entry.currentPos);

    // Spawn tween (scale 0->1)
    if (entry.lifeState === 'spawning') {
      entry.tween += dt * 3.3;
      if (entry.tween >= 1) {
        entry.tween = 1;
        entry.lifeState = 'alive';
      }
      entry.group.scale.setScalar(entry.tween);
    }

    // Despawn tween (scale 1->0, then remove)
    if (entry.lifeState === 'despawning') {
      entry.tween -= dt * 5;
      if (entry.tween <= 0) {
        this.group.remove(entry.group);
        this.entries.delete(agent.id);
        return;
      }
      entry.group.scale.setScalar(entry.tween);
    }

    // Idle pulse (breathing)
    if (entry.lifeState === 'alive' && !agent.moving) {
      const pulse = 1 + Math.sin(performance.now() * 0.003 + entry.idlePhase) * 0.02;
      entry.group.scale.setScalar(pulse);
    }

    // Walking hop
    if (agent.moving) {
      entry.hopY = Math.abs(Math.sin(performance.now() * 0.012)) * HEX_SIZE * 0.06;
      entry.group.position.y = entry.currentPos.y + entry.hopY;
    } else {
      entry.hopY = 0;
    }

    // Fade alpha for despawning units
    if (agent.despawning && agent.fadeAlpha < 1.0) {
      entry.group.traverse((obj) => {
        const m = obj as Mesh;
        if (m.isMesh && m.material instanceof MeshStandardMaterial) {
          m.material.transparent = true;
          m.material.opacity = agent.fadeAlpha;
        }
      });
    }
  }

  dispose(): void {
    for (const [, entry] of this.entries) {
      entry.group.traverse((obj) => {
        const m = obj as Mesh;
        if (m.isMesh) {
          if (!m.userData.sharedGeometry) m.geometry.dispose();
          if (Array.isArray(m.material)) m.material.forEach(mt => mt.dispose());
          else m.material.dispose();
        }
      });
    }
    this.entries.clear();
    this.group.clear();
    this.lastSignature = '';
  }
}
