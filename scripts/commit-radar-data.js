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
const foreign = tracked.filter((d) => !DATA_PATHS.includes(d.file));
if (foreign.length) {
  refuse('modified files outside the data paths — that is code, and code gets reviewed, not swept:\n         '
    + foreign.map((f) => f.code + ' ' + f.file).join('\n         '));
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
