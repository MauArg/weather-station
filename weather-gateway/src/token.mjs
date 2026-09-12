const encoder = new TextEncoder();
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const b64url = bytes => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (b64url(bytes) !== value) throw new Error('Noncanonical encoding');
  return bytes;
}
async function key(secret) {
  if (!/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('Missing signing key');
  // The 64-character hex string is used as UTF-8, NOT decoded into 32 bytes.
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signLink(claims, secret) {
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode('weather-link-v1.' + payload));
  return payload + '.' + b64url(new Uint8Array(signature));
}
export async function verifyLink(token, secret, audience, now = nowSeconds()) {
  if (typeof token !== 'string' || token.length > 1500) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const signingKey = await key(secret);
  try {
    const [payload, signature] = parts;
    const sig = decode(signature);
    if (sig.length !== 32 || !await crypto.subtle.verify('HMAC', signingKey, sig, encoder.encode('weather-link-v1.' + payload))) return null;
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(payload)));
    if (!claims || claims.v !== 1 || claims.aud !== audience || claims.scope !== 'weather:read' ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
        claims.iat > now || claims.exp <= now || claims.exp <= claims.iat ||
        claims.exp - claims.iat > 600 || !/^[a-f0-9]{64}$/.test(claims.jti)) return null;
    return claims;
  } catch { return null; }
}
export function randomSession() { return b64url(crypto.getRandomValues(new Uint8Array(32))); }
export async function hashSession(value) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
