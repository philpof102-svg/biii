#!/usr/bin/env node
'use strict';
/**
 * Un refus doit laisser une trace LISIBLE la ou le diagnostic se fait.
 *
 * Mesure du 2026-08-05, payee 4 heures: les quatre wrappers de la flotte refusent par
 * `verify_payload … || exit 1` (et deux y ajoutent l'allowlist d'egress), soit SIX chemins de refus
 * dont AUCUN n'ecrit dans le depot. Les messages partent dans le log du cron Hermes, a l'interieur de
 * WSL, hors d'atteinte de la machine Windows d'ou l'on diagnostique. « A refuse » et « n'a jamais
 * tourne » y sont donc identiques.
 *
 * Pire: seul `token-radar` laisse une trace de SUCCES (il commite sa base). Les trois autres
 * n'ecrivent jamais rien, dans aucun etat — « tout va bien » y est indistinguable de « rien ne tourne
 * depuis trois semaines ».
 *
 * ⚠️ LA PROPRIETE LA PLUS IMPORTANTE N'EST PAS D'ECRIRE, C'EST DE NE JAMAIS CASSER SON APPELANT.
 * Un journal qui fait echouer le job qu'il observe est pire que pas de journal: il transforme une
 * panne diagnosticable en deux pannes. Les cas ci-dessous exercent donc surtout les chemins ou
 * l'ecriture est IMPOSSIBLE, et exigent malgre tout un code de sortie 0.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const SH = path.join(__dirname, '..', 'hermes', 'economy', 'note-refusal.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'note-refusal-'));

/** Lance le script avec un journal isole. Rend { code, contenu }. */
function lancer(args, env = {}) {
  const journal = path.join(tmp, 'refus-' + Math.abs(args.join('').length) + '-' + args[0] + '.log');
  let code = 0;
  try {
    execFileSync('bash', [SH, ...args], {
      env: { ...process.env, NOTE_REFUSAL_LOG: journal, ...env }, stdio: 'pipe',
    });
  } catch (e) { code = e.status == null ? -1 : e.status; }
  const contenu = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : null;
  return { code, contenu, journal };
}

console.log('note-refusal: un refus laisse une trace, et ne casse jamais son appelant');

t('★ un refus ecrit une ligne datee, avec le job et la raison', () => {
  const r = lancer(['token-radar', 'payload non epingle']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.contenu, 'aucun journal ecrit');
  const l = r.contenu.trim().split('\n').pop().split('\t');
  assert.strictEqual(l.length, 3, 'trois champs attendus: date, job, raison — ' + JSON.stringify(l));
  assert.match(l[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'horodatage UTC ISO attendu: ' + l[0]);
  assert.strictEqual(l[1], 'token-radar');
  assert.strictEqual(l[2], 'payload non epingle');
});

/* Les cas qui comptent le plus: l'ecriture est impossible, et le script doit QUAND MEME rendre 0.
 * Un journal qui casse le job qu'il observe transforme une panne en deux. */
t('★ journal dans un repertoire impossible -> sortie 0 quand meme', () => {
  // Un composant de chemin qui est un FICHIER rend le mkdir -p impossible.
  const fichier = path.join(tmp, 'je-suis-un-fichier');
  fs.writeFileSync(fichier, 'x');
  const r = lancer(['meme-scan', 'egress non appliquee'], { NOTE_REFUSAL_LOG: path.join(fichier, 'sous', 'refus.log') });
  assert.strictEqual(r.code, 0, 'un echec d ecriture ne doit JAMAIS remonter a l appelant');
});

t('★ aucun argument -> sortie 0, et la ligne dit « inconnu » plutot que de mentir', () => {
  const r = lancer([]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.contenu && /inconnu/.test(r.contenu), 'un job non nomme doit se dire, pas disparaitre');
});

t('★ le journal est BORNE — un volume plein a deja corrompu une base ici', () => {
  const journal = path.join(tmp, 'borne.log');
  fs.writeFileSync(journal, Array.from({ length: 40 }, (_, i) => `vieux\t${i}\tx`).join('\n') + '\n');
  execFileSync('bash', [SH, 'wallet-watch', 'test'], {
    env: { ...process.env, NOTE_REFUSAL_LOG: journal, NOTE_REFUSAL_MAX: '10' }, stdio: 'pipe',
  });
  const lignes = fs.readFileSync(journal, 'utf8').trim().split('\n');
  assert.ok(lignes.length <= 10, 'le journal doit etre tronque a NOTE_REFUSAL_MAX — ' + lignes.length + ' lignes');
  assert.ok(/wallet-watch/.test(lignes[lignes.length - 1]), 'la ligne la plus RECENTE doit survivre a la troncature');
});

t('les refus s empilent — un second refus ne remplace pas le premier', () => {
  const journal = path.join(tmp, 'empile.log');
  for (const j of ['agent-watch', 'meme-scan']) {
    execFileSync('bash', [SH, j, 'r'], { env: { ...process.env, NOTE_REFUSAL_LOG: journal }, stdio: 'pipe' });
  }
  const lignes = fs.readFileSync(journal, 'utf8').trim().split('\n');
  assert.strictEqual(lignes.length, 2, 'deux refus, deux lignes');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
