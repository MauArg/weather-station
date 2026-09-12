import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { AuthStore } from '../src/store.mjs';
import { handle } from '../src/gateway.mjs';
import { signLink, verifyLink, nowSeconds } from '../src/token.mjs';

const publicOrigin = 'https://weather.astronet.com.ar';
const secret = 'a'.repeat(64); // Synthetic test key only.
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = nowSeconds();
  const storage = {
    sql: { exec: (query, ...args) => ({ toArray: () => db.prepare(query).all(...args) }) },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  // Cloudflare's sql.exec executes immediately; emulate that with real SQLite.
  storage.sql.exec = (query, ...args) => {
    const rows = db.prepare(query).all(...args);
    return { toArray: () => rows };
  };
  const auth = new AuthStore(storage, () => now);
  const env = {
    PUBLIC_ORIGIN: publicOrigin, ORIGIN_URL: 'https://weather-origin.astronet.com.ar',
    LINK_SIGNING_SECRET: secret, ORIGIN_CLIENT_ID: 'test-id',
    ORIGIN_CLIENT_SECRET: 'test-origin-secret',
    AUTH: { idFromName: name => name, get: () => auth },
  };
  const claims = { v: 1, aud: publicOrigin, scope: 'weather:read', iat: now, exp: now + 600, jti: 'b'.repeat(64) };
  const req = (path, init) => new Request(publicOrigin + path, init);
  const redeem = token => handle(req('/auth/redeem', {
    method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }), env);
  const login = async () => {
    const result = await redeem(await signLink(claims, secret));
    assert.equal(result.status, 204);
    return result.headers.get('Set-Cookie').split(';')[0];
  };
  return { db, auth, env, claims, req, redeem, login, advance: seconds => { now += seconds; } };
}

test('HMAC format interoperates with Node/n8n crypto; forged, expired and overscoped claims fail', async () => {
  const now = nowSeconds();
  const claims = { v: 1, aud: publicOrigin, scope: 'weather:read', iat: now, exp: now + 600, jti: 'b'.repeat(64) };
  const token = await signLink(claims, secret);
  const [payload, signature] = token.split('.');
  assert.equal(signature, createHmac('sha256', secret).update('weather-link-v1.' + payload).digest('base64url'));
  assert.deepEqual(await verifyLink(token, secret, publicOrigin, now), claims);
  assert.equal(await verifyLink(token, secret, publicOrigin, now + 600), null);
  assert.equal(await verifyLink(token, 'c'.repeat(64), publicOrigin, now), null);
  for (const changes of [{ aud: 'https://other.example' }, { scope: 'admin' }, { exp: now + 601 }, { iat: now + 1 }, { jti: 'short' }]) {
    assert.equal(await verifyLink(await signLink({ ...claims, ...changes }, secret), secret, publicOrigin, now), null);
  }
  assert.equal(await verifyLink(payload + '.' + signature + '=', secret, publicOrigin, now), null);
  for (const malformed of ['', '.', 'not-a-token', null, 'a'.repeat(2000)]) {
    assert.equal(await verifyLink(malformed, secret, publicOrigin, now), null);
  }
});

test('concurrent redemption succeeds exactly once and stores only a session hash', async t => {
  const f = fixture(t);
  const token = await signLink(f.claims, secret);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.redeem(token)));
  assert.equal(results.filter(r => r.status === 204).length, 1);
  assert.equal(results.filter(r => r.status === 401).length, 11);
  const cookie = results.find(r => r.status === 204).headers.get('Set-Cookie');
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=']) assert.ok(cookie.includes(flag));
  const row = f.db.prepare('SELECT hash FROM sessions').get();
  assert.notEqual(row.hash, cookie.split(';')[0].split('=')[1]);
});

test('missing sessions never call origin; service and log routes remain forbidden after login', async t => {
  const f = fixture(t);
  const noFetch = () => { assert.fail('Origin must not be contacted'); };
  assert.equal((await handle(f.req('/'), f.env, noFetch)).status, 303);
  assert.equal((await handle(f.req('/api/v1/weather/current'), f.env, noFetch)).status, 401);
  const cookie = await f.login();
  for (const path of ['/api/v1/service/state', '/api/v1/service/stream', '/api/v1/logs/capture', '/api/v1/weather/new-api', '/unknown']) {
    assert.equal((await handle(f.req(path, { headers: { Cookie: cookie } }), f.env, noFetch)).status, 403);
  }
  assert.equal((await handle(f.req('/api/v1/service/command', { method: 'POST', headers: { Cookie: cookie } }), f.env, noFetch)).status, 405);
});

test('session expires on the server and logout revokes it', async t => {
  const f = fixture(t);
  const cookie = await f.login();
  const request = () => f.req('/api/v1/version', { headers: { Cookie: cookie } });
  assert.equal((await handle(request(), f.env, async () => new Response('{}'))).status, 200);
  f.advance(600);
  assert.equal((await handle(request(), f.env, () => assert.fail('expired'))).status, 401);
  const g = fixture(t);
  const cookie2 = await g.login();
  const logout = await handle(g.req('/auth/logout', { method: 'POST', headers: { Origin: publicOrigin, Cookie: cookie2 } }), g.env);
  assert.equal(logout.status, 204);
  assert.equal((await handle(g.req('/api/v1/version', { headers: { Cookie: cookie2 } }), g.env)).status, 401);
});

test('login previews do not consume a token; wrong origins and oversized bodies cannot redeem', async t => {
  const f = fixture(t);
  assert.equal((await handle(f.req('/login'), f.env)).status, 200);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM redeemed').get().n, 0);
  const token = await signLink(f.claims, secret);
  for (const origin of ['https://evil.example', 'null', '']) {
    assert.equal((await handle(f.req('/auth/redeem', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }), f.env)).status, 403);
  }
  assert.equal((await handle(f.req('/auth/redeem', { method: 'POST',
    headers: { Origin: publicOrigin, 'Content-Type': 'application/json' }, body: 'x'.repeat(3000) }), f.env)).status, 401);
  assert.equal((await f.redeem(token)).status, 204);
  const wrongHost = new Request('https://weather-gateway.example.workers.dev/login');
  assert.equal((await handle(wrongHost, f.env)).status, 404);
});

test('proxy injects only server credentials, strips origin cookies, blocks redirects and caching', async t => {
  const f = fixture(t);
  const cookie = await f.login();
  let called = false;
  const request = f.req('/api/v1/weather/history/recent?hours=24', { headers: {
    Cookie: cookie, Authorization: 'attacker', 'CF-Access-Client-Id': 'attacker',
    'CF-Access-Client-Secret': 'attacker', 'Cf-Access-Jwt-Assertion': 'attacker',
  } });
  const result = await handle(request, f.env, async (url, init) => {
    called = true;
    assert.equal(url, f.env.ORIGIN_URL + '/api/v1/weather/history/recent?hours=24');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.get('CF-Access-Client-Id'), 'test-id');
    assert.equal(init.headers.get('CF-Access-Client-Secret'), 'test-origin-secret');
    assert.equal(init.headers.get('Cookie'), null);
    assert.equal(init.headers.get('Authorization'), null);
    assert.equal(init.headers.get('Cf-Access-Jwt-Assertion'), null);
    return new Response('[]', { headers: { 'Set-Cookie': 'leaked=secret', 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'application/json' } });
  });
  assert.ok(called);
  assert.equal(result.headers.get('Set-Cookie'), null);
  assert.match(result.headers.get('Cache-Control'), /no-store/);
  assert.equal(await result.text(), '[]');
  const redirect = await handle(request, f.env, async () => new Response(null, {
    status: 302, headers: { Location: 'https://evil.example' },
  }));
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.get('Location'), null);
});

test('failed session creation rolls back redemption, and storage rejects expiry at redemption time', t => {
  const f = fixture(t);
  assert.ok(f.auth.redeem(f.claims, 'existing-hash'));
  const next = { ...f.claims, jti: 'c'.repeat(64) };
  assert.throws(() => f.auth.redeem(next, 'existing-hash'));
  assert.ok(f.auth.redeem(next, 'new-hash'));
  f.advance(600);
  assert.equal(f.auth.redeem({ ...next, jti: 'd'.repeat(64) }, 'another-hash'), null);
});
