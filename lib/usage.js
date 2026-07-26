'use strict';
/**
 * usage.js — does anyone actually call this?
 * ==========================================
 * Twenty-nine tools are served and nothing counts a single call. So the one question that decides whether
 * any of the work matters — has a stranger ever used it — has no answer, and a distribution push would be
 * shouting into a room with no way to hear a reply.
 *
 * This project's own Key Learnings put it plainly: MainStreet had 612 external callers and almost no payers,
 * and the make-or-break was distribution to a NAMED human. You cannot notice either condition without a
 * counter.
 *
 * ═══ WHAT IT DELIBERATELY DOES NOT RECORD ═══
 * Tool ARGUMENTS are never touched. They carry merchant addresses, wallet addresses, file paths from the
 * seed and key scanners, and whole deliverables — a usage log that captured them would be a more dangerous
 * artifact than anything this server protects against. Only the tool NAME, the day, and whether the caller
 * looked internal.
 *
 * Distinct callers are counted WITHOUT keeping an identifier: the key is a truncated hash of the caller hint
 * salted with the DAY, so it cannot be linked across days and no address survives anywhere. The count is the
 * product; the identity is not kept even in memory beyond the day.
 *
 * ═══ INTERNAL CALLS ARE EXCLUDED, AND SAID ═══
 * Our own probes would otherwise become the evidence that people use it — the exact self-deception this
 * project keeps finding in its own metrics. A caller sending `x-ms-monitor: 1` is counted separately and
 * never mixed in, following the convention already used on the sibling service.
 *
 * ═══ WHAT IT CANNOT SEE, STATED IN THE OUTPUT ═══
 * A caller running the package over stdio (`npx biii-mcp`) never touches this process, so hosted counts are
 * a FLOOR on real usage and are labelled as such. An undercount presented as a total is how a live product
 * gets declared dead.
 *
 * Bounded on purpose: a fixed number of days retained, a cap on distinct callers held per day. This service
 * once filled its volume and corrupted its database; a metrics file that grows without limit is the same
 * accident with a friendlier name.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STORE = process.env.BIII_USAGE || path.join(__dirname, '..', 'data', 'usage.json');
const RETAIN_DAYS = 30;          // a month is enough to see a trend; more is hoarding
const MAX_CALLERS_PER_DAY = 5000; // a hard ceiling so a flood cannot grow the file without bound

const state = { days: {} };      // day -> { tools: {name: n}, callers: Set, internal: n, flooded: bool }
let loaded = false;
let dirty = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    for (const [day, d] of Object.entries(raw.days || {})) {
      state.days[day] = { tools: d.tools || {}, callers: new Set(d.callers || []), internal: d.internal || 0, flooded: !!d.flooded };
    }
  } catch { /* no prior file — a first run is not an error */ }
}

function persist() {
  if (!dirty) return;
  const out = { days: {} };
  for (const [day, d] of Object.entries(state.days)) {
    out.days[day] = { tools: d.tools, callers: [...d.callers], internal: d.internal, flooded: d.flooded };
  }
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(out));
    dirty = false;
  } catch { /* best effort: losing a count is acceptable, crashing a payment server for one is not */ }
}

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

/** Salted with the day so the same caller is unlinkable across days, and truncated so it is not a handle. */
function callerKey(hint, day) {
  if (!hint) return null;
  return crypto.createHash('sha256').update(day + '|' + String(hint)).digest('hex').slice(0, 16);
}

function prune() {
  const days = Object.keys(state.days).sort();
  while (days.length > RETAIN_DAYS) { delete state.days[days.shift()]; dirty = true; }
}

/**
 * record — one tool call.
 *
 * @param tool      the tool NAME. Arguments are never passed in and never stored.
 * @param opts.internal  true when the caller identified itself as ours (x-ms-monitor)
 * @param opts.callerHint an opaque per-caller string (e.g. an address). Hashed with the day, never kept.
 * @param opts.now  injected for tests
 */
function record(tool, opts = {}) {
  if (!tool) return;
  load();
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const day = dayOf(now);
  const d = state.days[day] || (state.days[day] = { tools: {}, callers: new Set(), internal: 0, flooded: false });

  if (opts.internal) { d.internal++; dirty = true; return; }   // ours, counted apart, never mixed in

  d.tools[tool] = (d.tools[tool] || 0) + 1;
  const key = callerKey(opts.callerHint, day);
  if (key) {
    if (d.callers.size < MAX_CALLERS_PER_DAY) d.callers.add(key);
    else d.flooded = true;      // the ceiling was hit: say so rather than report a capped number as a total
  }
  dirty = true;
  prune();
}

/**
 * report — what the counter knows, with what it cannot know attached.
 */
function report(opts = {}) {
  load();
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const days = Object.keys(state.days).sort();
  const tools = {};
  let external = 0, internal = 0, flooded = false;
  const callersToday = state.days[dayOf(now)] ? state.days[dayOf(now)].callers.size : 0;

  for (const day of days) {
    const d = state.days[day];
    internal += d.internal;
    if (d.flooded) flooded = true;
    for (const [t, n] of Object.entries(d.tools)) { tools[t] = (tools[t] || 0) + n; external += n; }
  }

  const ranked = Object.entries(tools).sort((a, b) => b[1] - a[1]);
  return {
    externalCalls: external,
    internalCalls: internal,
    distinctCallersToday: callersToday,
    callerCeilingHit: flooded,
    daysCovered: days.length,
    since: days[0] || null,
    toolsEverCalled: ranked.length,
    byTool: Object.fromEntries(ranked),
    /* The two sentences that keep this number honest. */
    floorNotTotal: 'These are HOSTED calls only. A caller running the package over stdio (npx) never reaches '
      + 'this process, so this is a FLOOR on real usage, never a total.',
    internalExcluded: 'Calls marked x-ms-monitor are ours and are counted separately (' + internal + '), never '
      + 'mixed into externalCalls — our own probes must not become the evidence that people use it.',
    neverRecorded: 'Tool arguments are never stored. Distinct callers are counted via a day-salted truncated '
      + 'hash, so no identifier is retained and nothing links a caller across days.',
  };
}

/** Flush to disk. Called on an interval and at shutdown by the server, not on every request. */
function flush() { load(); persist(); }
function _reset() { state.days = {}; loaded = false; dirty = false; }

module.exports = { record, report, flush, _reset, RETAIN_DAYS, MAX_CALLERS_PER_DAY, STORE };
