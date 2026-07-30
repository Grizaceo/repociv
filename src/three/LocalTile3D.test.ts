import { describe, it, expect } from 'vitest';
import { LocalTile3D } from './LocalTile3D.ts';
import type { LocalWorld, LocalTile, LocalRoom, Workbench } from '../types.ts';

function makeTile(x: number, y: number, type: LocalTile['type'], extra: Partial<LocalTile> = {}): LocalTile {
  return { x, y, type, roomId: extra.roomId ?? null, workbench: extra.workbench ?? null, ...extra };
}

function makeWorld(opts: {
  width?: number;
  height?: number;
  grid?: LocalTile[][];
  rooms?: LocalRoom[];
  workbenches?: Workbench[];
}): LocalWorld {
  const width = opts.width ?? (opts.grid?.[0]?.length ?? 0);
  const height = opts.height ?? (opts.grid?.length ?? 0);
  return {
    repoId: 'test-repo',
    grid: opts.grid ?? [],
    rooms: opts.rooms ?? [],
    width,
    height,
    workbenches: opts.workbenches ?? [],
    deskAssignments: new Map(),
  };
}

describe('LocalTile3D', () => {
  it('constructs with empty group', () => {
    const lt = new LocalTile3D();
    const g = lt.getGroup();
    expect(g.name).toBe('local-tiles');
    expect(g.children.length).toBe(0);
  });

  it('rebuild returns true on first call, false on identical second call', () => {
    const grid: LocalTile[][] = [
      [makeTile(0, 0, 'floor'), makeTile(1, 0, 'floor')],
      [makeTile(0, 1, 'wall'), makeTile(1, 1, 'floor')],
    ];
    const world = makeWorld({ grid, width: 2, height: 2 });
    const opts = { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false };

    const lt = new LocalTile3D();
    expect(lt.rebuild(world, opts)).toBe(true);
    expect(lt.rebuild(world, opts)).toBe(false);
  });

  it('rebuild returns true when world changes', () => {
    const grid1: LocalTile[][] = [[makeTile(0, 0, 'floor')]];
    const world1 = makeWorld({ grid: grid1, width: 1, height: 1 });
    const grid2: LocalTile[][] = [[makeTile(0, 0, 'wall')]];
    const world2 = makeWorld({ grid: grid2, width: 1, height: 1 });
    const opts = { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false };

    const lt = new LocalTile3D();
    expect(lt.rebuild(world1, opts)).toBe(true);
    expect(lt.rebuild(world2, opts)).toBe(true);
  });

  it('creates floor mesh for floor tiles', () => {
    const grid: LocalTile[][] = [
      [makeTile(0, 0, 'floor'), makeTile(1, 0, 'path')],
    ];
    const world = makeWorld({ grid, width: 2, height: 1 });
    const opts = { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false };

    const lt = new LocalTile3D();
    lt.rebuild(world, opts);
    const g = lt.getGroup();
    expect(g.children.length).toBeGreaterThanOrEqual(1);
  });

  it('creates wall and door meshes', () => {
    const grid: LocalTile[][] = [
      [makeTile(0, 0, 'wall'), makeTile(1, 0, 'door'), makeTile(2, 0, 'floor')],
    ];
    const world = makeWorld({ grid, width: 3, height: 1 });
    const opts = { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false };

    const lt = new LocalTile3D();
    lt.rebuild(world, opts);
    const g = lt.getGroup();
    // at least 2 meshes (wall + door)
    expect(g.children.length).toBeGreaterThanOrEqual(2);
  });

  it('creates workbench mesh with extension color', () => {
    const wb: Workbench = {
      id: '1', filePath: '/test.ts', fileName: 'test.ts', extension: 'ts',
      isTest: false, repoPath: 'test',
    };
    const grid: LocalTile[][] = [
      [makeTile(0, 0, 'workbench', { workbench: wb })],
    ];
    const world = makeWorld({ grid, width: 1, height: 1, workbenches: [wb] });
    const opts = { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false };

    const lt = new LocalTile3D();
    lt.rebuild(world, opts);
    const g = lt.getGroup();
    expect(g.children.length).toBeGreaterThanOrEqual(1);
  });

  it('creates furniture meshes for various types', () => {
    const types: LocalTile['type'][] = [
      'chair', 'planter', 'whiteboard', 'server_rack', 'sofa',
      'meeting_room', 'phone_booth', 'break_area', 'reception',
      'standing_desk', 'watercooler', 'cubicle_partition',
    ];
    const grid: LocalTile[][] = [types.map((t, i) => makeTile(i, 0, t))];
    const world = makeWorld({ grid, width: types.length, height: 1 });
    const opts = { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false };

    const lt = new LocalTile3D();
    lt.rebuild(world, opts);
    const g = lt.getGroup();
    expect(g.children.length).toBe(types.length);
  });

  it('dispose clears all meshes and allows re-rebuild', () => {
    const grid: LocalTile[][] = [[makeTile(0, 0, 'floor')]];
    const world = makeWorld({ grid, width: 1, height: 1 });
    const opts = { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false };

    const lt = new LocalTile3D();
    lt.rebuild(world, opts);
    lt.dispose();
    expect(lt.getGroup().children.length).toBe(0);
    // should be able to rebuild after dispose
    expect(lt.rebuild(world, opts)).toBe(true);
  });

  it('empty world produces no meshes', () => {
    const world = makeWorld({ grid: [], width: 0, height: 0 });
    const opts = { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false };

    const lt = new LocalTile3D();
    lt.rebuild(world, opts);
    expect(lt.getGroup().children.length).toBe(0);
  });

  it('overlay flag changes trigger rebuild', () => {
    const grid: LocalTile[][] = [[makeTile(0, 0, 'floor')]];
    const world = makeWorld({ grid, width: 1, height: 1 });
    const opts1 = { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false };
    const opts2 = { workbenchLabelOverlay: true, powerOverlay: false, temperatureOverlay: false };

    const lt = new LocalTile3D();
    lt.rebuild(world, opts1);
    expect(lt.rebuild(world, opts2)).toBe(true);
  });
});
