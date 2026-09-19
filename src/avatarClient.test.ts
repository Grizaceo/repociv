import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAvatarImages,
  findRosterEntry,
  getAvatarImage,
  getRosterMap,
  invalidateRosterCache,
} from './avatarClient.ts';
import { nativeProfileFor } from './agentProfile.ts';

describe('getRosterMap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateRosterCache();
  });

  it('reads the `bots` array the bridge returns', async () => {
    const cobalt = {
      name: 'cobalt',
      is_bot: true,
      avatar_kind: 'face',
      avatar_url: '/api/roster/asset/cobalt/avatar.png',
      pet: null,
      face_url: '/api/roster/asset/cobalt/avatar.png',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ harness: 'hermes', bots: [cobalt] }),
      }),
    );
    const map = await getRosterMap();
    expect(map.size).toBe(1);
    expect(findRosterEntry(map, 'COBALT')).toEqual(cobalt);
  });
});

describe('nativeProfileFor', () => {
  it('maps a Hermes bot to its own profile dir, like the bridge does', () => {
    expect(nativeProfileFor({ name: 'cobalt', harness: 'hermes', harness_ref: 'cobalt' })).toBe(
      '~/.hermes/profiles/cobalt',
    );
    expect(
      nativeProfileFor({ name: 'x', harness: 'hermes', harness_ref: 'x', profile_path: '/p/x' }),
    ).toBe('/p/x');
    expect(nativeProfileFor({ name: 'main', harness: 'hermes', harness_ref: 'default' })).toBe('');
    expect(nativeProfileFor({ name: 'main', harness: 'hermes' })).toBe('');
    expect(nativeProfileFor({ name: 'c', harness: 'claude', harness_ref: 'c' })).toBe('');
  });
});

describe('getAvatarImage', () => {
  afterEach(() => {
    clearAvatarImages();
    vi.unstubAllGlobals();
  });

  it('fetches the token-gated asset and loads it through an object URL', async () => {
    const created: FakeImage[] = [];
    class FakeImage {
      src = '';
      complete = true;
      naturalWidth = 0;
      onerror: (() => void) | null = null;
      constructor() {
        created.push(this);
      }
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['png'])),
    });
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:avatar-1', revokeObjectURL: vi.fn() });

    const url = '/bridge/api/roster/asset/cobalt/avatar.png';
    expect(getAvatarImage(url)).toBeNull(); // not loaded yet
    await vi.waitFor(() => expect(created[0]?.src).toBe('blob:avatar-1'));
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    created[0]!.naturalWidth = 64; // the browser decoded it
    expect(getAvatarImage(url)).toBe(created[0]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached, no refetch
  });

  it('gives up on a 401 and does not retry every frame', async () => {
    class FakeImage {
      src = '';
      complete = true;
      naturalWidth = 0;
      onerror: (() => void) | null = null;
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('fetch', fetchMock);
    const url = '/bridge/api/roster/asset/nobody/avatar.png';
    getAvatarImage(url);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    getAvatarImage(url);
    getAvatarImage(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
