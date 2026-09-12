import { verifyLink, randomSession, hashSession, nowSeconds } from './token.mjs';
const COOKIE = '__Host-weather_session';
const API_PATHS = new Set([
  '/api/v1/version', '/api/v1/weather/current', '/api/v1/weather/stats/daily',
  '/api/v1/weather/history/recent', '/api/v1/weather/history/day', '/api/v1/weather/history/year',
]);
const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
function response(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...BASE_HEADERS, ...extra } });
}
function sessionCookie(value, maxAge) {
  return COOKIE + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + maxAge;
}
function cookieValue(request) {
  const values = (request.headers.get('Cookie') || '').split(';')
    .map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
async function readJSON(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2048) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}
const LOGIN_JS = `let token = location.hash.slice(1);
history.replaceState(null, '', '/login');
const button = document.querySelector('button');
const message = document.querySelector('#message');
button.disabled = !token;
if (!token) message.textContent = 'Request a new link using /weather in Telegram.';
button.addEventListener('click', async () => {
  button.disabled = true;
  message.textContent = 'Opening dashboard...';
  try {
    const result = await fetch('/auth/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }), credentials: 'same-origin',
    });
    token = '';
    if (result.ok) location.replace('/');
    else message.textContent = 'This link could not be used. Request a new link in Telegram.';
  } catch {
    token = '';
    message.textContent = 'Connection failed. Request a new link in Telegram and try again.';
  }
});`;
function loginPage() {
  return response(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weather Station login</title><main><h1>Weather Station</h1>
<p id="message">Open a view-only session for 10 minutes.</p>
<button type="button" disabled>Enter dashboard</button></main>
<script src="/auth/login.js" defer></script></html>`, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  });
}
function allowedPath(path) {
  return path === '/' || path === '/index.html' || path === '/favicon.png' ||
    /^\/assets\/[A-Za-z0-9_.-]+\.(js|css|png|svg|woff2?)$/.test(path) || API_PATHS.has(path);
}
export async function handle(request, env, originFetch = fetch) {
  const url = new URL(request.url);
  // Canonical hostname only: workers.dev and preview URLs cannot serve sessions.
  if (url.origin !== env.PUBLIC_ORIGIN) return response('Unknown host', 404);
  if (url.search.length > 2048) return response('Query too long', 414);
  if (url.pathname === '/login' && request.method === 'GET') return loginPage();
  if (url.pathname === '/auth/login.js' && request.method === 'GET') {
    return response(LOGIN_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  }

  const state = () => env.AUTH.get(env.AUTH.idFromName('weather-auth-v1'));
  if (url.pathname === '/auth/redeem') {
    if (request.method !== 'POST') return response('Method not allowed', 405);
    if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN) return response('Forbidden', 403);
    const body = await readJSON(request);
    const claims = await verifyLink(body?.token, env.LINK_SIGNING_SECRET, env.PUBLIC_ORIGIN);
    if (!claims) return response('Invalid or expired link', 401);
    const session = randomSession();
    const expires = await state().redeem(claims, await hashSession(session));
    if (!expires) return response('Link already used or expired', 401);
    return response(null, 204, { 'Set-Cookie': sessionCookie(session, Math.max(0, expires - nowSeconds())) });
  }
  if (url.pathname === '/auth/logout') {
    if (request.method !== 'POST') return response('Method not allowed', 405);
    if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN) return response('Forbidden', 403);
    const session = cookieValue(request);
    if (session) await state().revoke(await hashSession(session));
    return response(null, 204, { 'Set-Cookie': sessionCookie('', 0) });
  }

  // Fail closed for future APIs. GET alone does not imply permission.
  if (!['GET', 'HEAD'].includes(request.method)) return response('Method not allowed', 405);
  if (!allowedPath(url.pathname)) return response('Forbidden', 403);
  const session = cookieValue(request);
  if (!session || !await state().check(await hashSession(session))) {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return response(null, 303, { Location: '/login', 'Set-Cookie': sessionCookie('', 0) });
    }
    return response('Session expired. Request a new link in Telegram.', 401);
  }
  if (!env.ORIGIN_CLIENT_ID || !env.ORIGIN_CLIENT_SECRET) throw new Error('Origin credentials missing');
  const target = new URL(env.ORIGIN_URL);
  if (target.protocol !== 'https:' || target.origin === url.origin || target.username || target.password) throw new Error('Invalid origin');
  target.pathname = url.pathname;
  target.search = url.search;
  // Construct headers from scratch. Never forward client-supplied Access headers,
  // cookies, Authorization, Host, forwarding headers, or arbitrary destinations.
  const headers = new Headers({
    'CF-Access-Client-Id': env.ORIGIN_CLIENT_ID,
    'CF-Access-Client-Secret': env.ORIGIN_CLIENT_SECRET,
  });
  const upstream = await originFetch(target.href, {
    method: request.method, headers, redirect: 'manual', cache: 'no-store',
  });
  // A redirect could leak a credential to a different host if followed.
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    return response('Unexpected origin redirect', 502);
  }
  const outputHeaders = new Headers(BASE_HEADERS);
  for (const name of ['Content-Type', 'Content-Language']) {
    const value = upstream.headers.get(name);
    if (value) outputHeaders.set(name, value);
  }
  // No upstream cookies/CORS headers or cache directives cross this boundary.
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status, headers: outputHeaders,
  });
}
