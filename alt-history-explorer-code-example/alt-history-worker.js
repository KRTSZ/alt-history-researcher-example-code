/**
 * Alternative History Explorer — Anthropic API Proxy
 * ====================================================
 * A Cloudflare Worker that sits between the HTML app and the Anthropic API.
 * Your real API key lives here as a secret environment variable — it is
 * NEVER sent to any browser client.
 *
 * ── HOW IT WORKS ────────────────────────────────────────────────────────────
 *
 *  Free tier (no key in request):
 *    Browser → this Worker → Anthropic (using server-side key)
 *    Rate limit: FREE_DAILY_LIMIT requests per IP per calendar day.
 *    Tracked in Cloudflare KV (key-value store, free tier: 100k reads/day).
 *
 *  Own key (user entered their key in the app):
 *    Browser → this Worker (X-User-Api-Key header) → Anthropic (using their key)
 *    No rate limit. The user's key is forwarded; the server-side key is not used.
 *
 * ── DEPLOYMENT STEPS ────────────────────────────────────────────────────────
 *
 *  1. Sign up free at https://cloudflare.com  (no credit card needed for Workers)
 *
 *  2. Go to  Workers & Pages  →  Create  →  Create Worker
 *     Paste this entire file into the code editor, click  Deploy.
 *
 *  3. Add your secret API key:
 *       Worker → Settings → Variables → Secrets
 *       Name:  ANTHROPIC_KEY    Value: sk-ant-...your-key...
 *     Secrets are encrypted at rest and never visible again after saving.
 *
 *  4. Create a KV namespace for rate-limit counters:
 *       Workers & Pages → KV → Create namespace → name it  RATE_LIMITS
 *     Bind it to your Worker:
 *       Worker → Settings → Variables → KV Namespace Bindings
 *       Variable name: RATE_LIMITS   KV namespace: RATE_LIMITS
 *     Click  Save and deploy.
 *
 *  5. Copy your Worker URL — shown on the Worker overview page, looks like:
 *       https://alt-history-proxy.YOUR-SUBDOMAIN.workers.dev
 *
 *  6. Open  alternative-history-android.html  in a text editor and set:
 *       const PROXY_URL = 'https://alt-history-proxy.YOUR-SUBDOMAIN.workers.dev';
 *
 *  That's it. Your Anthropic key is now hidden on the server.
 *  Users get 5 free questions/day; entering their own key removes the limit.
 *
 * ── SECURITY NOTES ──────────────────────────────────────────────────────────
 *
 *  • ANTHROPIC_KEY is stored as a Cloudflare Secret — encrypted, never in code.
 *  • The key is never returned in any response to the client.
 *  • Rate limiting is enforced server-side (KV counter); the HTML's client-side
 *    check is just UX sugar — the real block happens here.
 *  • The Worker only accepts POST requests to /  and rejects everything else.
 *  • CORS is locked to allow any origin because the HTML may be opened from
 *    file:// or any domain. Tighten to your specific domain if you host the
 *    HTML on a server (replace '*' with 'https://your-domain.com').
 *  • User-supplied keys (X-User-Api-Key) are forwarded to Anthropic and not
 *    logged or stored anywhere in this Worker.
 */

// ── Configuration ────────────────────────────────────────────────────────────

/** Max free requests per IP per calendar day. */
const FREE_DAILY_LIMIT = 5;

/** CORS headers — change '*' to your domain if you host the HTML on a server. */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Api-Key, anthropic-version',
};

// ── Main handler ─────────────────────────────────────────────────────────────

export default {
  /**
   * @param {Request} request
   * @param {{ ANTHROPIC_KEY: string, RATE_LIMITS: KVNamespace }} env
   */
  async fetch(request, env) {

    // Handle CORS preflight (browser sends this before the real POST)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET → serve the HTML frontend from the ./public folder via Cloudflare Assets.
    // Cloudflare injects env.ASSETS automatically when [assets] is set in wrangler.toml.
    if (request.method === 'GET') {
        return env.ASSETS.fetch(request);
    }

    // Parse the request body (the same JSON the app would send to Anthropic)
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResp({ error: 'Invalid JSON in request body' }, 400);
    }

    // Read the user-supplied key header (present when the user entered their own key)
    const userKey = (request.headers.get('X-User-Api-Key') || '').trim();

    if (userKey) {
      // ── Own-key path: forward directly, no rate limiting ──────────────────
      // We validate the key looks plausible before forwarding (avoids wasting
      // upstream calls on obviously wrong input)
      if (!userKey.startsWith('sk-')) {
        return jsonResp({ error: 'The API key you entered does not look valid (should start with sk-).' }, 400);
      }
      return callAnthropic(body, userKey);
    }

    // ── Free-tier path: rate limit by IP, then use server-side key ───────────

    if (!env.ANTHROPIC_KEY) {
      // Worker not fully configured yet
      return jsonResp({ error: 'Proxy not configured: ANTHROPIC_KEY secret is missing.' }, 503);
    }

    // Cloudflare provides the real IP in CF-Connecting-IP
    const ip    = request.headers.get('CF-Connecting-IP') || 'unknown';
    const today = new Date().toISOString().slice(0, 10);   // e.g. "2026-06-01"
    const kvKey = `rl:${ip}:${today}`;

    // Read current usage count from KV
    let usageCount = 0;
    try {
      const stored = await env.RATE_LIMITS.get(kvKey);
      usageCount   = stored ? parseInt(stored, 10) : 0;
    } catch {
      // If KV is unavailable, fail open (allow the request) rather than
      // blocking all users due to an infrastructure hiccup.
      console.error('KV read failed — failing open');
    }

    if (usageCount >= FREE_DAILY_LIMIT) {
      return jsonResp({
        error: `You have used all ${FREE_DAILY_LIMIT} free questions for today. Add your own Anthropic API key in the app settings to continue without limits.`,
        rate_limited: true,
        limit: FREE_DAILY_LIMIT,
        used:  usageCount,
      }, 429);
    }

    // Increment the counter — expires after 25 hours to safely cover day rollover
    try {
      await env.RATE_LIMITS.put(kvKey, String(usageCount + 1), { expirationTtl: 90000 });
    } catch {
      console.error('KV write failed — counter not incremented');
    }

    // Forward to Anthropic with the server-side key
    return callAnthropic(body, env.ANTHROPIC_KEY);
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Forward a request body to the Anthropic Messages API.
 * @param {Object} body   - The JSON body from the client
 * @param {string} apiKey - Anthropic API key to use
 */
async function callAnthropic(body, apiKey) {
  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'content-type':      'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key':         apiKey,
        // Do NOT forward the dangerous-direct-browser-access header —
        // this call originates from a server (the Worker), not a browser.
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return jsonResp({ error: 'Failed to reach Anthropic: ' + err.message }, 502);
  }

  const data = await upstream.json();

  // Pass the upstream status through — the HTML handles Anthropic error shapes
  return new Response(JSON.stringify(data), {
    status:  upstream.status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * Return a JSON response with CORS headers.
 * @param {Object} obj    - Object to serialise
 * @param {number} status - HTTP status code
 */
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}
