import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  decideAccess,
  isLoopbackHost,
  parseTailnetUsers,
} from './accessGate.ts';

describe('access gate', () => {
  const allowed = parseTailnetUsers(' Owner@Example.com , ,ops@example.com');

  it('parses the tailnet allowlist case-insensitively', () => {
    expect(allowed).toEqual(['owner@example.com', 'ops@example.com']);
  });

  it('recognizes loopback hosts with and without ports', () => {
    for (const host of ['localhost', 'localhost:5273', '127.0.0.1:5273', '[::1]:5273']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    expect(isLoopbackHost('omarchy-1.tail7b473b.ts.net:5273')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });

  it('lets the local operator through', () => {
    expect(decideAccess({ host: '127.0.0.1:5273' }, allowed)).toEqual({ ok: true });
  });

  it('admits listed tailnet users only', () => {
    const host = 'omarchy-1.tail7b473b.ts.net:5273';
    expect(decideAccess({ host, 'tailscale-user-login': 'OWNER@example.com' }, allowed).ok).toBe(
      true,
    );
    expect(decideAccess({ host, 'tailscale-user-login': 'friend@example.com' }, allowed)).toEqual({
      ok: false,
      reason: 'tailnet user not listed in REPOCIV_TAILNET_USERS',
    });
    // Tagged devices carry no identity header.
    expect(decideAccess({ host }, allowed).ok).toBe(false);
  });

  it('treats an identity header on a loopback Host as tailnet traffic', () => {
    expect(
      decideAccess({ host: 'localhost', 'tailscale-user-login': 'friend@example.com' }, allowed).ok,
    ).toBe(false);
  });

  it('keeps legacy behavior when no allowlist is configured', () => {
    expect(decideAccess({ host: 'omarchy-1.tail7b473b.ts.net' }, []).ok).toBe(true);
  });
});

describe('content security policy', () => {
  it('forbids inline and foreign scripts while permitting blob: for GLTFLoader textures', () => {
    const csp = contentSecurityPolicy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("connect-src 'self' blob:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it('adds a direct bridge origin to connect-src when configured', () => {
    expect(contentSecurityPolicy(['http://bridge.local:5274'])).toContain(
      'http://bridge.local:5274',
    );
  });
});
