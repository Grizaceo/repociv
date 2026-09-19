import { describe, expect, it, vi } from 'vitest';
import {
  isSameOriginUpgrade,
  parseWonderProxies,
  stripWonderPrefix,
  wonderProxyConfig,
} from './wonderProxy.ts';

describe('parseWonderProxies', () => {
  it('parses id=loopback-url pairs', () => {
    expect(
      parseWonderProxies(
        ' ghostdesk=http://127.0.0.1:6080 , other=http://localhost:9000/,v6=http://[::1]:7000',
      ),
    ).toEqual({
      ghostdesk: 'http://127.0.0.1:6080',
      other: 'http://localhost:9000',
      v6: 'http://[::1]:7000',
    });
  });

  it('is empty when unset', () => {
    expect(parseWonderProxies(undefined)).toEqual({});
    expect(parseWonderProxies('')).toEqual({});
  });

  it('rejects non-loopback targets, bad ids and odd URLs', () => {
    const warn = vi.fn();
    const out = parseWonderProxies(
      [
        'lan=http://192.168.1.5:6080',
        'ts=http://omarchy-1:6080',
        'Bad Id=http://127.0.0.1:1',
        '../x=http://127.0.0.1:1',
        'ftp=ftp://127.0.0.1:21',
        'path=http://127.0.0.1:1/sub',
        'q=http://127.0.0.1:1/?a=1',
        'creds=http://u:p@127.0.0.1:1',
        'noeq',
        '=http://127.0.0.1:1',
        'junk=not a url',
      ].join(','),
      warn,
    );
    expect(out).toEqual({});
    expect(warn).toHaveBeenCalledTimes(11);
  });
});

describe('wonderProxyConfig', () => {
  it('builds an anchored ws-capable entry per wonder', () => {
    const cfg = wonderProxyConfig('ghostdesk=http://127.0.0.1:6080');
    const [key] = Object.keys(cfg);
    const entry = cfg[key!]!;
    expect(entry).toMatchObject({ target: 'http://127.0.0.1:6080', ws: true, changeOrigin: true });
    const re = new RegExp(key!);
    expect(re.test('/wonder-proxy/ghostdesk/vnc.html')).toBe(true);
    expect(re.test('/wonder-proxy/ghostdesk?auto=1')).toBe(true);
    expect(re.test('/wonder-proxy/ghostdesk')).toBe(true);
    expect(re.test('/wonder-proxy/ghostdesk2/x')).toBe(false);
    expect(re.test('/x/wonder-proxy/ghostdesk/')).toBe(false);
    expect(entry.rewrite!('/wonder-proxy/ghostdesk/websockify')).toBe('/websockify');
  });

  it('strips the prefix keeping a leading slash', () => {
    expect(stripWonderPrefix('/wonder-proxy/g/a/b?c=1', 'g')).toBe('/a/b?c=1');
    expect(stripWonderPrefix('/wonder-proxy/g?auto=1', 'g')).toBe('/?auto=1');
    expect(stripWonderPrefix('/wonder-proxy/g', 'g')).toBe('/');
  });
});

describe('isSameOriginUpgrade', () => {
  it('accepts only same-origin browser upgrades', () => {
    expect(isSameOriginUpgrade('http://omarchy-1:5273', 'omarchy-1:5273')).toBe(true);
    expect(isSameOriginUpgrade('http://127.0.0.1:5273', '127.0.0.1:5273')).toBe(true);
    expect(isSameOriginUpgrade('https://evil.example', 'omarchy-1:5273')).toBe(false);
    expect(isSameOriginUpgrade('http://omarchy-1:5274', 'omarchy-1:5273')).toBe(false);
    expect(isSameOriginUpgrade('null', 'omarchy-1:5273')).toBe(false);
    expect(isSameOriginUpgrade(undefined, 'omarchy-1:5273')).toBe(false);
    expect(isSameOriginUpgrade('http://omarchy-1:5273', undefined)).toBe(false);
  });
});
