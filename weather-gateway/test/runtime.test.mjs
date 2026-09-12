import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { signLink, nowSeconds } from '../src/token.mjs';

test('Workers runtime: SQLite migration binding, one-use redemption, proxy and logout', async () => {
  const audience = 'https://weather.astronet.com.ar';
  const secret = 'a'.repeat(64);
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'weather-gateway',
    modulesRoot: fileURLToPath(new URL('../src/', import.meta.url)),
    modules: ['index.mjs', 'store.mjs', 'token.mjs', 'gateway.mjs'].map(name => ({
      type: 'ESModule', path: fileURLToPath(new URL('../src/' + name, import.meta.url)),
    })),
    compatibilityDate: '2026-09-12',
    durableObjects: { AUTH: { className: 'WeatherAuth', useSQLite: true } },
    bindings: {
      PUBLIC_ORIGIN: audience, ORIGIN_URL: 'https://origin.test',
      LINK_SIGNING_SECRET: secret, ORIGIN_CLIENT_ID: 'test-id', ORIGIN_CLIENT_SECRET: 'test-secret',
    },
    outboundService: async request => {
      assert.equal(new URL(request.url).origin, 'https://origin.test');
      assert.equal(request.headers.get('CF-Access-Client-Id'), 'test-id');
      assert.equal(request.headers.get('CF-Access-Client-Secret'), 'test-secret');
      assert.equal(request.headers.get('Cookie'), null);
      return new Response('{"version":"test"}', { headers: { 'Content-Type': 'application/json' } });
    },
  }] }));
  try {
    assert.equal((await mf.dispatchFetch(audience + '/api/v1/version')).status, 401);
    const now = nowSeconds();
    const token = await signLink({ v: 1, aud: audience, scope: 'weather:read',
      iat: now, exp: now + 600, jti: 'b'.repeat(64) }, secret);
    const redeem = () => mf.dispatchFetch(audience + '/auth/redeem', {
      method: 'POST', headers: { Origin: audience, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const pair = await Promise.all([redeem(), redeem()]);
    assert.deepEqual(pair.map(r => r.status).sort(), [204, 401]);
    const cookie = pair.find(r => r.status === 204).headers.get('Set-Cookie').split(';')[0];
    const result = await mf.dispatchFetch(audience + '/api/v1/version', { headers: { Cookie: cookie } });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { version: 'test' });
    assert.equal((await mf.dispatchFetch(audience + '/api/v1/service/stream', { headers: { Cookie: cookie } })).status, 403);
    const logout = await mf.dispatchFetch(audience + '/auth/logout', {
      method: 'POST', headers: { Origin: audience, Cookie: cookie },
    });
    assert.equal(logout.status, 204);
    assert.equal((await mf.dispatchFetch(audience + '/api/v1/version', { headers: { Cookie: cookie } })).status, 401);
  } finally { await mf.dispose(); }
});
