'use strict';
/**
 * ratelimit — per-IP fixed-window limiter for the public BIII server.
 * ===================================================================
 * Several routes (/status, /receipt, /radar, and the paid /x402 path) make OUTBOUND Base-RPC calls.
 * With no cap, a public caller can hammer them and exhaust our RPC quota — a DoS of our own
 * availability. BIII is non-custodial (no funds at risk), but uptime is. Zero-dep, in-memory,
 * self-pruning. Behind a proxy (Railway) the client is the first `x-forwarded-for` hop.
 *
 * Tune with BIII_RL_MAX (req/window/IP, default 120) and BIII_RL_WINDOW_MS (default 60000).
 */
/**
 * `Number(process.env.X || N)` is the wrong shape and it bit here: a MISSPELT value is truthy, so the
 * fallback never fires and `Number('abc')` yields NaN. Measured 2026-08-06 with BIII_RL_MAX=abc —
 * `count <= NaN` is false, so EVERY request was denied from the first one, permanently, and the 429 body
 * carried `limit: null` (JSON has no NaN). With BIII_RL_WINDOW_MS=1min, `resetAt = now + NaN` and
 * `now >= NaN` is false, so the window could never elapse and `Retry-After: NaN` went out on the wire.
 * A typo in a tuning knob took the whole public surface down and the response could not say why.
 * A rejected value falls back to the documented default and is DISCLOSED — refusing all traffic over a
 * config typo is fail-closed pushed past the point where it still informs anyone.
 */
const envRejects = [];
function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {                         // NaN, Infinity, 0 and negatives are all unusable
    envRejects.push(`${name}=${JSON.stringify(raw)} is not a positive finite number — using ${fallback}`);
    return fallback;
  }
  return n;
}
const WINDOW_MS = envNum('BIII_RL_WINDOW_MS', 60_000);
const MAX = envNum('BIII_RL_MAX', 120);                        // 120 req / min / IP — generous for the caisse; caps abuse
const hits = new Map();                                        // bucket key -> { count, resetAt }

/**
 * Who is calling — and, just as load-bearing, WHETHER WE COULD TELL.
 *
 * The previous version returned the bare string `'unknown'` when it could not read the client. That is the
 * same string a caller gets by sending `x-forwarded-for: unknown` (a real legacy XFF token, and it survives
 * as the first hop even when the proxy appends behind it). Measured 2026-08-06: ONE spoofed request at
 * max:1 denied a genuinely unreadable caller. A failed read rendered exactly what a successful read
 * renders, so anyone could climb into the unreadable bucket and burn it for everybody in it.
 *
 * The key therefore carries its PROVENANCE. Caller-supplied text lands under `xff:`, so no header value can
 * reach the bare `unreadable` sentinel — that is structural, not a blacklist of bad strings.
 *
 * ⚠️ RESIDUAL, DELIBERATELY LEFT: all unreadable callers still share one bucket, so one of them can still
 * exhaust it for the others. There is no identity to key on, so every alternative (deny them all / exempt
 * them all) is a deployment policy decision, not a bug fix. It is disclosed via `identitySource` instead of
 * being decided here. Trusting `x-forwarded-for` at all is the same kind of call: a caller can rotate the
 * header to get a fresh bucket, but keying on the socket instead would put every caller behind Railway's
 * proxy into ONE bucket. Left as-is on purpose.
 */
function clientIdentity(req) {
  const headers = (req && req.headers) || {};                  // a req without headers is unreadable, not a throw
  const xff = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return { id: xff, source: 'xff', key: 'xff:' + xff };
  const sock = (req && req.socket && req.socket.remoteAddress) || '';
  if (sock) return { id: sock, source: 'socket', key: 'sock:' + sock };
  return { id: null, source: 'unreadable', key: 'unreadable' };
}

function rateLimit(req, nowMs = Date.now(), { max = MAX, windowMs = WINDOW_MS } = {}) {
  // Same guard on the option path: an override is as capable of carrying NaN as an env var is.
  if (!Number.isFinite(max) || max <= 0) max = MAX;
  if (!Number.isFinite(windowMs) || windowMs <= 0) windowMs = WINDOW_MS;
  const who = clientIdentity(req);
  let e = hits.get(who.key);
  if (!e || nowMs >= e.resetAt) { e = { count: 0, resetAt: nowMs + windowMs }; hits.set(who.key, e); }
  e.count += 1;
  if (hits.size > 10_000) for (const [k, v] of hits) if (nowMs >= v.resetAt) hits.delete(k);   // bound memory
  return {
    allowed: e.count <= max,
    limit: max,
    remaining: Math.max(0, max - e.count),
    retryAfterSec: Math.ceil((e.resetAt - nowMs) / 1000),
    identitySource: who.source,                                // 'xff' | 'socket' | 'unreadable' — never collapse the third into the others
    configWarnings: envRejects.slice(),                        // empty is a measurement here: envNum ran and rejected nothing
  };
}

// `clientIp` is deliberately NOT exported any more: it returned a bare string that could not distinguish an
// unread client from a caller-supplied one. A consumer that still reaches for it now fails loudly instead of
// silently receiving the ambiguous value. (Measured before removal: no consumer outside this file.)
module.exports = { rateLimit, clientIdentity, _hits: hits };
