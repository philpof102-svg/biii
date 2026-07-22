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
const WINDOW_MS = Number(process.env.BIII_RL_WINDOW_MS || 60_000);
const MAX = Number(process.env.BIII_RL_MAX || 120);            // 120 req / min / IP — generous for the caisse; caps abuse
const hits = new Map();                                        // ip -> { count, resetAt }

const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || (req.socket && req.socket.remoteAddress) || 'unknown';

function rateLimit(req, nowMs = Date.now(), { max = MAX, windowMs = WINDOW_MS } = {}) {
  const ip = clientIp(req);
  let e = hits.get(ip);
  if (!e || nowMs >= e.resetAt) { e = { count: 0, resetAt: nowMs + windowMs }; hits.set(ip, e); }
  e.count += 1;
  if (hits.size > 10_000) for (const [k, v] of hits) if (nowMs >= v.resetAt) hits.delete(k);   // bound memory
  return { allowed: e.count <= max, limit: max, remaining: Math.max(0, max - e.count), retryAfterSec: Math.ceil((e.resetAt - nowMs) / 1000) };
}

module.exports = { rateLimit, clientIp, _hits: hits };
