'use strict';
/**
 * funder-history.js — the impure half: read the observation database off disk and say how old it is.
 * ==================================================================================================
 * `funder-registry.js` is pure on purpose — it folds records into history and judges, with no clock and no
 * disk, so its logic is testable offline. This is the thin layer that feeds it, and it exists separately
 * because everything hard about serving this data is a FRESHNESS problem, not a logic one.
 *
 * ═══ WHY FRESHNESS IS THE WHOLE PROBLEM HERE ═══
 * The radar that fills this database runs on a local machine, not on the hosted node. A deployed server
 * therefore answers from the snapshot committed at build time, and that snapshot ages silently: the file
 * loads, the lookup succeeds, the verdict reads exactly as confident on a week-old database as on a fresh
 * one. A stale "this payer has never killed" is precisely the sentence that gets someone hurt, because a
 * payer's first kill is the observation that changes it.
 *
 * So every answer carries `asOf`, `ageHours` and `stale`, in the same discipline `till_trust` already uses
 * for the known-bad list. Beyond STALE_HOURS the verdict is DOWNGRADED rather than merely annotated — a
 * warning nobody reads is not a control, and the difference between "clean so far" and "we cannot say" is
 * the difference between an answer and a guess.
 */

const fs = require('node:fs');
const path = require('node:path');
const { build, assess } = require('./funder-registry');

/* Twelve hours. Derived from the thing being measured rather than picked: rugs resolve at a p95 of about
 * four hours in this dataset, so a database older than roughly three of those windows can have missed an
 * entire generation of launches and their outcomes. */
const STALE_HOURS = 12;

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'token-radar', 'tokens.json');

let cache = null;   // { mtimeMs, registry, newest, count }

/** Load and fold, re-reading only when the file actually changed. */
/* ⚠️ ABSENT ET ILLISIBLE NE SONT PAS LA MEME CHOSE, et cette fonction rendait `null` pour les deux.
 * Mesure du 2026-07-28 — fichier absent, JSON tronque et fichier de zero octet produisaient tous les
 * trois la phrase « this node has no observation database ». Deux de ces trois affirmations sont FAUSSES:
 * le noeud a une base, elle ne se lit pas.
 *
 * La distinction est operationnelle, pas cosmetique. « Pas de base » est l'etat NORMAL d'un noeud neuf et
 * n'appelle aucune action. « Base illisible » veut dire que quelque chose a casse — et ce n'est pas
 * theorique ici: un volume plein a deja corrompu une base dans ce projet, et un fichier de zero octet en
 * est la signature exacte. La confondre avec un demarrage a froid, c'est effacer l'incident. */
function loadRegistry(dbPath = DEFAULT_DB) {
  let st;
  try { st = fs.statSync(dbPath); } catch { return null; }        // absent = we say so, never "nothing known"
  if (cache && cache.path === dbPath && cache.mtimeMs === st.mtimeMs) return cache;

  let rows;
  try { rows = Object.values(JSON.parse(fs.readFileSync(dbPath, 'utf8'))); } catch (e) {
    /* Objet TRUTHY et volontairement depourvu de `registry`: un appelant qui l'utiliserait sans brancher
     * casserait bruyamment au lieu de juger sur du vide. On ne met PAS ce cas en cache — le fichier peut
     * etre repare a la seconde suivante, et cacher une panne la fait durer. */
    return { unreadable: true, path: dbPath, bytes: st.size,
      detail: (e && e.name === 'SyntaxError') ? 'the file is not parseable JSON' : 'the file could not be read',
      code: e && e.code ? String(e.code) : null };
  }
  const newest = rows.reduce((m, t) => {
    const v = Date.parse(t.lastSeen || t.firstSeen || 0);
    return Number.isFinite(v) && v > m ? v : m;
  }, 0);
  cache = { path: dbPath, mtimeMs: st.mtimeMs, registry: build(rows), newest, count: rows.length };
  return cache;
}

/**
 * lookup — what our own history says about the wallet that paid for a launch.
 *
 * @param funder   the payer address, or null when the trace could not find one
 * @param opts.now injected so freshness is testable; defaults to the clock
 * @param opts.dbPath override for tests
 */
function lookup(funder, opts = {}) {
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const loaded = loadRegistry(opts.dbPath || DEFAULT_DB);

  if (!loaded) {
    return {
      verdict: 'no_database',
      reason: 'this node has no observation database, so it has nothing to say about any payer. That is an '
        + 'absence of evidence and never a clearance.',
      asOf: null, ageHours: null, stale: true, observedTokens: 0,
    };
  }

  /* Le troisieme etat. Il ne dit pas la meme chose que `no_database` et n'appelle pas la meme action:
   * l'un est l'etat normal d'un noeud neuf, l'autre est une PANNE a regarder. Ni l'un ni l'autre n'est un
   * blanc-seing — c'est le point commun, et c'est tout ce qu'ils ont en commun. */
  if (loaded.unreadable) {
    return {
      verdict: 'database_unreadable',
      reason: 'an observation database EXISTS at ' + loaded.path + ' (' + loaded.bytes + ' bytes) but '
        + loaded.detail + (loaded.code ? ' (' + loaded.code + ')' : '') + '. This is NOT "no database": '
        + 'something broke, and a zero-byte or truncated file is what a full disk leaves behind. Nothing '
        + 'here is a clearance — but unlike a cold start, this one needs someone to look at it.',
      asOf: null, ageHours: null, stale: true, observedTokens: 0,
    };
  }

  const ageHours = loaded.newest ? (now - loaded.newest) / 3600000 : null;
  const stale = ageHours == null || ageHours > STALE_HOURS;
  const base = assess(loaded.registry, funder);

  /* A stale database may not hand out the reassuring verdict. `funder_has_killed` still stands when stale —
   * a kill already observed does not un-happen, and suppressing it would fail OPEN. But "clean so far" and
   * "never seen" both mean "no bad record HERE", and on an old file that sentence is about our file rather
   * than about the payer. */
  if (stale && (base.verdict === 'funder_clean_so_far' || base.verdict === 'funder_unseen')) {
    return {
      ...base,
      verdict: 'unknown_stale',
      reason: 'the observation database was last updated ' + (ageHours == null ? 'at an unreadable time'
        : Math.round(ageHours) + 'h ago') + ', past the ' + STALE_HOURS + 'h freshness bar, so "no bad record" '
        + 'describes this file rather than this payer. Its first kill is exactly the observation we would be '
        + 'missing. Original reading, kept for context: ' + base.reason,
      asOf: loaded.newest ? new Date(loaded.newest).toISOString() : null,
      ageHours: ageHours == null ? null : +ageHours.toFixed(1),
      stale: true,
      observedTokens: loaded.count,
    };
  }

  return {
    ...base,
    asOf: loaded.newest ? new Date(loaded.newest).toISOString() : null,
    ageHours: ageHours == null ? null : +ageHours.toFixed(1),
    stale,
    observedTokens: loaded.count,
    knownFunders: loaded.registry.size,
  };
}

/** Reset between tests — the cache is keyed on mtime, which a test writing twice in one millisecond defeats. */
function _clearCache() { cache = null; }

module.exports = { lookup, loadRegistry, STALE_HOURS, _clearCache };
