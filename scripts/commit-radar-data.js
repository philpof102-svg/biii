#!/usr/bin/env node
'use strict';
/**
 * commit-radar-data.js — get the observation database into git, safely, on a shared tree.
 * ======================================================================================
 * The radar writes `data/token-radar/*.json` every hour and commits nothing. Every commit of that data so
 * far has been a human one, made in passing alongside a code change — so the hosted node's freshness is
 * ACCIDENTAL, and the cost is measurable: a registry frozen 6h ago misses 20% of the rugs it could have
 * named, 38% at 12h, 41% at 24h.
 *
 * ═══ WHY THIS DEFAULTS TO DOING NOTHING ═══
 * This tree is shared. An unattended committer on a shared repository is how a half-finished change gets
 * published under someone else's name, so the default is a DRY RUN that prints what it would do and exits.
 * `--commit` is required to act, and `--push` separately, because reaching a remote is a different decision
 * from recording locally.
 *
 * ═══ WHAT IT REFUSES ═══
 *   - anything staged already            (someone is mid-commit; we are not joining their commit)
 *   - modified files outside the data     paths (that is code, and code is reviewed, never swept)
 *   - a detached HEAD or a rebase in      progress (an automated commit has no business there)
 *   - nothing to do                       (a no-op commit is noise in a history people read)
 *
 * Every path is passed EXPLICITLY. No `git add -A`, no `git add .`, no wildcard that could grow to include
 * a file nobody meant to publish — the rule exists because a sweeping add is how secrets travel.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* The only paths this script may ever touch. Adding one is a deliberate edit, which is the point. */
const DATA_PATHS = [
  'data/token-radar/tokens.json',
  'data/token-radar/scorecard.json',
  'data/agent-watch/registry.json',
  /* Ajoute le 2026-07-28 APRES lecture du contenu: un tableau de 631 octets, deux enregistrements de
   * TROUS D'OBSERVATION (from/to/hours/note) — aucune cle, aucune adresse, aucun secret. Il appartient au
   * meme lot que `tokens.json`: un chiffre tire d'observations ne veut rien dire sans la trace des
   * periodes ou l'on ne regardait pas. Son absence de cette liste bloquait TOUT le committeur. */
  'data/token-radar/blackouts.json',
  /* Ajoute le 2026-08-05 AVANT que le fichier existe, et c'est deliberé: `hermes/economy/note-refusal.sh`
   * ecrira ici la premiere fois qu'un wrapper de la flotte refusera de tourner. Sans cette ligne, ce
   * journal rejouerait mot pour mot l'incident du 28/07 — un quatrieme fichier de donnees apparu sans
   * etre epingle a bloque TOUT le committeur, de facon permanente, et 172 observations sont restees en
   * base sans jamais partir.
   *
   * Contenu: trois champs par ligne — horodatage UTC, nom du job, raison du refus. Aucune cle, aucune
   * adresse, aucun secret. Borne a 500 lignes par le script lui-meme (un volume plein a deja corrompu
   * une base ici le 07/06). Il appartient au meme lot que `blackouts.json`: tous deux enregistrent des
   * periodes ou l'on ne regardait PAS, et un chiffre tire d'observations ne vaut rien sans elles. */
  'data/fleet-refusals.log',
];

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
/* `git status --porcelain` is a FIXED-COLUMN format: two status characters, a space, then the path. Trimming
 * it eats the leading space of the first line and shifts every field by one, which turned
 * " M data/token-radar/scorecard.json" into a status of "M " and a path of "ata/token-radar/scorecard.json"
 * — a file outside the allowed list, so the script refused to run for a reason that did not exist. Column
 * formats get read raw. */
const gitRaw = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const argv = process.argv.slice(2);
const wantCommit = argv.includes('--commit');
const wantPush = argv.includes('--push');

function refuse(why) {
  console.log('REFUSED — ' + why);
  console.log('Nothing was staged, committed or pushed.');
  process.exit(1);
}

/* Exporte AVANT le flux, et le flux ne s'execute qu'en lancement direct. Un `return` au niveau module est
 * legal en CommonJS (le module est enveloppe dans une fonction), donc requerir ce fichier depuis un test
 * ne lance AUCUNE commande git — ce qui est la seule facon de tester un committeur sans en devenir un. */
module.exports = { classer, DATA_PATHS };
if (require.main !== module) return;

// ── 1. is the tree in a state an unattended script may act on? ─────────────────
let branch;
try { branch = git('rev-parse', '--abbrev-ref', 'HEAD'); } catch (e) { refuse('not a git tree here (' + e.message + ')'); }
if (branch === 'HEAD') refuse('HEAD is detached — an automated commit has no business on a detached head');

const staged = git('diff', '--cached', '--name-only');
if (staged) refuse('something is already staged, so someone is mid-commit:\n         ' + staged.split('\n').join('\n         '));

// ── 2. is anything OUTSIDE the data paths modified? ───────────────────────────
const dirty = gitRaw('status', '--porcelain').split('\n').filter((l) => l.length > 3)
  .map((l) => ({ code: l.slice(0, 2), file: l.slice(3).replace(/^"|"$/g, '').replace(/\r$/, '') }));
const tracked = dirty.filter((d) => !d.code.includes('?'));
/**
 * classer — trie les fichiers modifies en trois: du CODE, une nouvelle DONNEE hors liste, et ce qu'on a
 * le droit de commiter. Extrait pur, parce que ce script n'exportait rien et qu'aucun test ne pouvait
 * l'atteindre — le meme « lecteur qui n'existe pas » corrige ailleurs aujourd'hui.
 */
function classer(modifies, dataPaths) {
  const horsListe = modifies.filter((d) => !dataPaths.includes(d.file));
  return {
    duCode: horsListe.filter((f) => !String(f.file).startsWith('data/')),
    nouvellesDonnees: horsListe.filter((f) => String(f.file).startsWith('data/')),
    aCommiter: modifies.filter((d) => dataPaths.includes(d.file)).map((d) => d.file),
  };
}

/* ⚠️ UN SEUL MESSAGE POUR DEUX SITUATIONS OPPOSEES, ET LA DIFFERENCE EST CE QU'IL FAUT FAIRE.
 * Mesure du 2026-07-28: le committeur refusait en disant « modified files outside the data paths — that
 * is code » en listant `data/token-radar/blackouts.json`. Ce fichier n'est ni du code ni hors de `data/`:
 * c'est un QUATRIEME fichier de donnees que le radar s'est mis a ecrire, absent de la liste blanche.
 *
 * Le garde avait raison de refuser — une liste EXPLICITE sans joker est precisement ce qui empeche un
 * fichier que personne n'a voulu publier de partir avec le lot. C'est le message qui etait faux, et le
 * cout est reel: la base d'observations n'atteignait plus git. Au moment de la mesure, 609 lignes en base
 * contre 437 dans le dernier commit — 172 observations bloquees, et le blocage etait PERMANENT tant que
 * la liste n'etait pas mise a jour.
 *
 * On separe donc les deux, parce qu'elles n'appellent pas le meme geste:
 *   - sous `data/` mais hors liste  -> un nouveau fichier de donnees est apparu: l'AJOUTER volontairement
 *   - hors `data/`                  -> c'est du code, et le code se relit, il ne se balaie pas */
const { duCode, nouvellesDonnees } = classer(tracked, DATA_PATHS);
if (duCode.length || nouvellesDonnees.length) {
  const liste = (xs) => xs.map((f) => f.code + ' ' + f.file).join('\n         ');
  refuse([
    duCode.length ? 'modified files OUTSIDE data/ — that is code, and code gets reviewed, not swept:\n         ' + liste(duCode) : '',
    nouvellesDonnees.length ? 'data file(s) under data/ that are NOT on the explicit allow-list:\n         '
      + liste(nouvellesDonnees)
      + '\n         This is not code and not an intruder — the radar started writing a file nobody added to'
      + '\n         DATA_PATHS. Look at it, then add it there DELIBERATELY. Until you do, the observation'
      + '\n         database stops reaching git entirely, and nothing else will say so.' : '',
  ].filter(Boolean).join('\n\n       '));
}

const changed = tracked.filter((d) => DATA_PATHS.includes(d.file)).map((d) => d.file);
if (!changed.length) {
  console.log('nothing to do — the observation database is unchanged since the last commit.');
  process.exit(0);
}

// ── 3. describe the change in terms someone reading the log will understand ───
let summary = '';
try {
  const db = require(path.join(ROOT, 'data', 'token-radar', 'tokens.json'));
  const rows = Object.values(db);
  const rugs = rows.filter((r) => r.outcome === 'rugged').length;
  const funded = rows.filter((r) => r.funder).length;
  const newest = rows.reduce((m, r) => Math.max(m, Date.parse(r.lastSeen || 0) || 0), 0);
  summary = rows.length + ' tokens · ' + rugs + ' rugs · ' + funded + ' with a traced funder'
    + (newest ? ' · newest observation ' + new Date(newest).toISOString() : '');
} catch { summary = '(the database could not be summarised — committing the files as they are)'; }

console.log('branch      ' + branch);
console.log('changed     ' + changed.join(', '));
console.log('state       ' + summary);

if (!wantCommit) {
  console.log('\nDRY RUN. Nothing was done. Pass --commit to record it, and --push as a separate choice.');
  console.log('This default exists because the tree is shared: an unattended committer publishes whatever');
  console.log('happens to be lying around, and the person it lands on is not the one who ran it.');
  process.exit(0);
}

// ── 4. act, by explicit pathspec only ─────────────────────────────────────────
const msg = 'radar: observation database — ' + summary + '\n\n'
  + 'Recorded by scripts/commit-radar-data.js. Data only: the script refuses to run when anything outside\n'
  + 'data/token-radar and data/agent-watch has changed, so no code rides along with this.\n\n'
  + 'Freshness is the point. A registry frozen 6h ago misses 20% of the rugs it could have named, 38% at\n'
  + '12h, 41% at 24h — measured on this database, not estimated.';

git('add', ...changed);                                  // explicit pathspec, never -A
const out = execFileSync('git', ['commit', '-m', msg], { cwd: ROOT, encoding: 'utf8' });
console.log('\n' + out.trim().split('\n')[0]);

if (wantPush) {
  // Fast-forward only. If the remote moved, this stops rather than merging on someone's behalf.
  try {
    // A plain push is already fast-forward-only: git rejects a non-ff update rather than merging. No force
    // flag of any kind belongs in an unattended script.
    const res = execFileSync('git', ['push', 'origin', branch], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('pushed: ' + String(res).trim().split('\n').pop());
  } catch (e) {
    console.log('push FAILED (the commit is safe locally): ' + String(e.stderr || e.message).trim().split('\n').pop());
    console.log('Most likely the remote moved. Rebase and push by hand — an automated merge is not this script\'s call.');
    process.exit(2);
  }
} else {
  console.log('committed locally only. Pass --push to send it, which is a separate decision.');
}
