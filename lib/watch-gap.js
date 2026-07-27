'use strict';
/**
 * watch-gap.js — the hours nobody was looking.
 * ============================================
 * A harvest only ever shows pools that exist RIGHT NOW. So a token that launched and died while the radar
 * was down was never seen, was never counted as a rug, and never can be — the evidence is gone with the pool.
 *
 * On 2026-07-27 this radar had not run for 9.3 hours: the machine slept and the Hermes gateway restarted.
 * Nothing anywhere said so, and `rugsObserved` read like a complete count of the period when it was a count
 * of what happened to still be visible on the way back.
 *
 * That is the same failure this project keeps finding in other clothes — a throttled API read as a quiet
 * market, an unanswered call read as a clean result — pointed at the observation record itself. An unwatched
 * hour is indistinguishable from a calm one unless something writes it down.
 *
 * Pure: takes two timestamps, returns a gap or null. The threshold is injected so the schedule can change
 * without editing this file, and `now` is a parameter so a test can place a gap at any size.
 */

/** Hourly schedule: a late run is not a blackout, so nothing under this is reported. */
const DEFAULT_MAX_QUIET_H = 2;

/**
 * detectGap — was there a stretch with no observation worth recording?
 *
 * @param lastSeenMs  epoch ms of the newest observation before this run, or 0/null if there is none
 * @param nowMs       epoch ms of this run
 * @param maxQuietH   hours of silence tolerated before it counts as a gap
 * @returns { from, to, hours } or null
 */
function detectGap(lastSeenMs, nowMs, maxQuietH = DEFAULT_MAX_QUIET_H) {
  const last = Number(lastSeenMs);
  const now = Number(nowMs);
  // No prior observation is a FIRST RUN, not a blackout. Reporting one would invent a gap that never
  // happened, and a false gap teaches the reader to discount the real ones.
  if (!Number.isFinite(last) || last <= 0) return null;
  if (!Number.isFinite(now)) return null;

  const hours = (now - last) / 3600000;
  // A clock that moved backwards (sleep, NTP correction) is not a gap either; it is an unreadable interval,
  // and inventing a negative one would silently subtract from the total.
  if (!(hours > maxQuietH)) return null;

  return { from: new Date(last).toISOString(), to: new Date(now).toISOString(), hours: +hours.toFixed(1) };
}

/** Newest observation in a token database, as epoch ms. 0 when there is none. */
function newestObservation(db) {
  const rows = Array.isArray(db) ? db : Object.values(db || {});
  return rows.reduce((m, t) => {
    const v = Date.parse((t && (t.lastSeen || t.firstSeen)) || 0) || 0;
    return v > m ? v : m;
  }, 0);
}

/** Append a gap to a bounded log. Bounded because this file is committed every hour. */
function appendGap(log, gap, cap = 200) {
  const out = Array.isArray(log) ? log.slice() : [];
  if (gap) out.push(gap);
  return out.slice(-cap);
}

module.exports = { detectGap, newestObservation, appendGap, DEFAULT_MAX_QUIET_H };
