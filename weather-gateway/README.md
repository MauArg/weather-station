# Weather gateway

Custom Telegram magic-link authentication in front of the existing Cloudflare
Access-protected origin. Source belongs to the root deployment repository.
No live deployment is performed by creating these files.

## Current infrastructure (user verified 2026-09-12)

- Public Worker: weather-gateway, custom domain https://weather.astronet.com.ar.
- Origin: https://weather-origin.astronet.com.ar, local tunnel to nginx on Pi port 80.
- Access policy: Service Auth restricted to weather-worker-origin service token.
- cloudflared validates Access JWTs with teamName momochis and the application's AUD.
- Unauthenticated browser received Access 403; authenticated /api/v1/version returned 1.11.0.
- Secrets already entered in Worker dashboard: ORIGIN_CLIENT_ID,
  ORIGIN_CLIENT_SECRET, LINK_SIGNING_SECRET. Never put their values in source.
- Origin Access's session duration does NOT control gateway sessions.

## Implementation

Signed links can be redeemed for up to 600 seconds after issuance. A successful,
explicit POST consumes the nonce atomically and creates a separate 600-second
session. Cookie: __Host-weather_session; Secure; HttpOnly; SameSite=Strict; Path=/.
Only session hashes are persisted. Expiration is enforced server-side per request.
Logout revokes the stored session. Expired data is cleaned during next redemption.
No background cleanup service is required for this personal-use deployment.

One named SQLite Durable Object serializes consumption globally. Do not replace
it with eventually consistent Workers KV. Do not delete/recreate/restore its
storage while links remain valid: doing so could make previously redeemed links
usable again. Rotate the signing secret if replay state must be reset.

The token travels in /login#TOKEN, which HTTP does not send to the server.
The page removes the fragment from history immediately, retains it only in
memory, and submits it on an explicit click. This prevents ordinary preview GETs
from consuming it; possession of the link still authorizes whoever redeems first.
No analytics, third-party resources, or request/body logging on the login page.
Session expiry prevents further reads, but cannot erase data already downloaded.

The origin proxy constructs its own headers, fixes the destination, does not
follow redirects, does not forward cookies, and disables response caching.
It allows only root/index, narrowly matched assets, favicon and these GET/HEAD APIs:
- /api/v1/version
- /api/v1/weather/current
- /api/v1/weather/stats/daily
- /api/v1/weather/history/recent
- /api/v1/weather/history/day
- /api/v1/weather/history/year

All maintenance/log routes, including SSE, are blocked even after authentication.
No browser service token is issued. Service credentials stay inside the Worker.

## Local tests

Node >=22.13 (node:sqlite emits an experimental warning on Node 22):

    npm test

Seven tests use real in-memory SQLite with a storage adapter. An eighth uses
workerd through Miniflare and verifies the actual Durable Object binding,
concurrent redemption, proxy credentials and logout. All eight pass.
Wrangler 4.131.1 dry build passes. Live deployment/migration, domain routing and
real origin credentials still require production validation.

## Deployment preparation

Dependencies are installed and package-lock.json is committed. On a fresh checkout,
run npm ci. Authenticate with the account that owns the existing Worker:

    npx wrangler login

Use Wrangler to deploy the Durable Object class and its SQLite migration together;
pasting just index.mjs into the dashboard is insufficient. package-lock.json
pins the locally tested dependencies.

wrangler.jsonc intentionally omits routes so existing dashboard-managed custom
domain configuration stays owned by the dashboard. keep_vars preserves
dashboard variables; the two explicit URL vars are defined in the file.
workers.dev and version preview URLs are disabled; the handler also rejects all
hostnames other than PUBLIC_ORIGIN. Secrets already configured on the existing
weather-gateway Worker must remain present.

Before production deployment:
1. Run tests and a Wrangler dry build (npx wrangler deploy --dry-run).
2. Test using the Workers runtime, including two concurrent redemption requests.
3. Review deployment diff: only weather-gateway and its new auth storage.
4. Deploy with npx wrangler deploy, preserving the existing custom domain.
5. Verify missing and forged credentials fail, origin still rejects anonymous
   requests, a valid link works once, and maintenance APIs remain blocked.

## Smoke-test link (before connecting n8n)

On a Bash machine with Node, from this folder:

    read -r -s -p "Signing secret: " LINK_SIGNING_SECRET
    printf '\n'
    export LINK_SIGNING_SECRET
    node scripts/mint-link.mjs
    unset LINK_SIGNING_SECRET

The output is a live bearer credential; open it yourself and do not share it.
The script uses the literal 64-character secret as UTF-8, not hex-decoded bytes.

## n8n integration contract (not yet wired)

Reuse the existing Telegram workflow. Require BOTH an explicit numeric sender
ID allowlist and a private chat before signing. Reply only to that verified
private chat. Disable previews. Do not save successful/error/manual execution
data containing tokens; configure pruning and avoid pinned test data with secrets.
The exact n8n credential/signing mechanism depends on installed version and
whether Code nodes can import crypto; do not hardcode secrets in exported nodes.

Claims, JSON-encoded then UTF-8 base64url without padding:
{v:1, aud:"https://weather.astronet.com.ar", scope:"weather:read",
 iat:UNIX_SECONDS, exp:UNIX_SECONDS_PLUS_600, jti:RANDOM_32_BYTES_HEX}

Signature: base64url(HMAC-SHA256(secret_as_UTF8,
"weather-link-v1." + encoded_payload)).
Token: encoded_payload + "." + signature.
URL: https://weather.astronet.com.ar/login#TOKEN

Use a cryptographic RNG for jti and synchronize the Pi clock.
A valid signature is checked before touching storage. The signing secret authorizes
read links only; the proxy does not accept scope expansion.

## Outstanding before complete rollout

- Local tests and dry build pass; deployment and real-origin validation remain.
- Frontend remote view mode: hide maintenance button, disable retained-command
  polling, and handle session expiry visibly. The current gateway is secure
  without that UI change, but existing maintenance controls would show errors.
- Wire and validate n8n signing/private sender checks without retaining secrets
  or live login tokens in workflow execution history.
- Validate cached responses, session expiry and simultaneous replay in production.
- Origin/service credentials and network segmentation remain separate controls;
  this gateway does not isolate a compromised Pi from the rest of the LAN.
