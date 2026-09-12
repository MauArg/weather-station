import { DurableObject } from 'cloudflare:workers';
import { AuthStore } from './store.mjs';
import { handle } from './gateway.mjs';

export class WeatherAuth extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new AuthStore(ctx.storage);
  }
  redeem(claims, sessionHash) { return this.store.redeem(claims, sessionHash); }
  check(sessionHash) { return this.store.check(sessionHash); }
  revoke(sessionHash) { return this.store.revoke(sessionHash); }
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch {
      // Never log tokens, cookies, credentials, request URLs or request bodies.
      return new Response('Gateway unavailable. Please try again later.', {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
      });
    }
  },
};
