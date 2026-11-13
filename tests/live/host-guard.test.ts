// Spec 7.2 tests: requests without the token and foreign Origins are refused (HTTP, /session, /tap).
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { makeSandbox, startHost, upgradeStatus, type HostRun, type Sandbox } from './helpers.ts';

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('host network guard', () => {
  let sb: Sandbox;
  let host: HostRun;

  beforeEach(async () => {
    sb = makeSandbox();
    host = await startHost(sb, ['--mode', 'gate', '--pack', 'A', '--tap', 'mock']);
  });

  afterEach(async () => {
    host.kill();
    await host.exited;
    sb.cleanup();
  });

  it('refuses HTTP requests without the token', async () => {
    const o = host.origin;
    expect((await fetch(`${o}/`)).status).toBe(403);
    expect((await fetch(`${o}/api/config`)).status).toBe(403);
    expect((await fetch(`${o}/assets/app.js`)).status).toBe(403);
    expect((await fetch(`${o}/api/narrator/listen.wav`)).status).toBe(403);
    expect((await fetch(`${o}/api/config?token=${'0'.repeat(64)}`)).status).toBe(403);
    expect((await fetch(`${o}/`, { headers: { Cookie: `ch_token=${'f'.repeat(64)}` } })).status).toBe(403);
  });

  it('serves the page with the token and sets the cookie, which then works alone', async () => {
    const res = await fetch(`${host.origin}/?token=${host.token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Copyholder');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toBe(`ch_token=${host.token}; HttpOnly; SameSite=Strict; Path=/`);
    const byCookie = await fetch(`${host.origin}/assets/app.js`, { headers: { Cookie: `ch_token=${host.token}` } });
    expect(byCookie.status).toBe(200);
    expect(byCookie.headers.get('content-type')).toContain('javascript');
    const cfg = await host.config();
    expect(cfg.sessionUrl).toBe(`ws://127.0.0.1:${host.port}/session?token=${host.token}`);
    expect(cfg.tapUrl).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:\\d+/tap\\?token=${host.token}$`));
    expect(cfg.consentText).toBe('live');
  });

  it('refuses a foreign Origin or Host on HTTP even with the token', async () => {
    const path = `/api/config?token=${host.token}`;
    expect(await rawGet(host.port, path, { Origin: 'http://evil.example' })).toBe(403);
    expect(await rawGet(host.port, path, { Host: `evil.example:${host.port}` })).toBe(403);
    expect(await rawGet(host.port, path, { Origin: host.origin })).toBe(200);
    expect(await rawGet(host.port, `/../../etc/passwd?token=${host.token}`, {})).toBe(404);
  });

  it('refuses /session without the token or with a foreign Origin', async () => {
    const base = `ws://127.0.0.1:${host.port}/session`;
    expect(await upgradeStatus(base, { Origin: host.origin })).toBe(403);
    expect(await upgradeStatus(`${base}?token=${'1'.repeat(64)}`, { Origin: host.origin })).toBe(403);
    expect(await upgradeStatus(`${base}?token=${host.token}`, { Origin: 'http://evil.example' })).toBe(403);
    expect(await upgradeStatus(`${base}?token=${host.token}`, { Origin: `http://localhost:${host.port}` })).toBe(403);
    expect(await upgradeStatus(`${base}?token=${host.token}`, {})).toBe(403);
    expect(await upgradeStatus(`ws://127.0.0.1:${host.port}/other?token=${host.token}`, { Origin: host.origin })).toBe(404);
    expect(await upgradeStatus(`${base}?token=${host.token}`, { Origin: host.origin })).toBe(101);
  });

  it('the mock tap refuses /tap without the token, with a foreign Origin, and a second client', async () => {
    const cfg = await host.config();
    const tapUrl = cfg.tapUrl ?? '';
    const bare = tapUrl.replace(/\?token=.*$/, '');
    expect(await upgradeStatus(bare, { Origin: host.origin })).toBe(403);
    expect(await upgradeStatus(tapUrl, { Origin: 'http://evil.example' })).toBe(403);
    expect(await upgradeStatus(tapUrl, {})).toBe(403);
    // the page's Origin with the token opens; one client at a time (spec 7.1)
    const first = new WebSocket(tapUrl, { headers: { Origin: host.origin } });
    await new Promise((resolve, reject) => {
      first.once('open', resolve);
      first.once('error', reject);
    });
    expect(await upgradeStatus(tapUrl, { Origin: host.origin })).toBe(409);
    first.close();
  });
});
