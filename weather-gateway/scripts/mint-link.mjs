// Local smoke-test signer. Read the secret from the environment, never argv.
import { randomBytes } from 'node:crypto';
import { signLink, nowSeconds } from '../src/token.mjs';
const audience = 'https://weather.astronet.com.ar';
const now = nowSeconds();
const claims = { v: 1, aud: audience, scope: 'weather:read', iat: now, exp: now + 600, jti: randomBytes(32).toString('hex') };
const token = await signLink(claims, process.env.LINK_SIGNING_SECRET);
process.stdout.write(audience + '/login#' + token + '\n');
