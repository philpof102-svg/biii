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

/**
 * ⚠️ CE FICHIER A ETE ROUGE 5 JOURS SUR LA MACHINE QUI LANCE LA PASSE DE NUIT (2026-08-05 -> 08-10).
 * Mesure du 2026-08-10: `bash` y resout vers C:\Windows\system32\bash.exe, c'est-a-dire WSL, qui
 * n'adresse pas `D:\...` du tout. Les cinq cas rendaient donc 127 (« No such file or directory »)
 * et la suite entiere s'arretait la — 17 fichiers de test n'ont JAMAIS tourne pendant ce temps.
 *
 * C'est le motif que ce depot traque, applique a son propre portillon: un echec a LANCER le sujet
 * est indiscernable d'un echec DU sujet. Cinq lignes rouges affirmaient « le journal de refus est
 * casse » alors que rien du journal de refus n'avait ete mesure — le script, lance avec un chemin
 * traduit, rend 0 et ecrit sa ligne parfaitement.
 *
 * D'ou la resolution ci-dessous. Elle distingue TROIS etats, pas deux:
 *   - un bash utilisable existe            -> on mesure vraiment
 *   - un bash utilisable existe et le sujet est casse -> rouge, et c'est le sujet
 *   - AUCUN bash utilisable                -> rouge AUSSI, mais en le DISANT: « pas mesure ici ».
 * Le troisieme etat ne doit jamais se lire comme un vert. Un `return` silencieux ici rendrait
 * « 0 passed, 0 failed » — exactement la forme de succes vide condamnee ailleurs dans ce depot.
 */
const posix = (prefixe) => (p) =>
  p.replace(/^([A-Za-z]):[\\/]/, (_, d) => prefixe + d.toLowerCase() + '/').replace(/\\/g, '/');

/**
 * ⚠️ `env` n'est PAS decoratif — c'est le troisieme etage du meme defaut, trouve en instrumentant.
 * WSL n'herite AUCUNE variable d'environnement Windows sauf celles nommees dans WSLENV. Sans lui,
 * `execFileSync(..., { env: { NOTE_REFUSAL_LOG } })` rend 0, n'ecrit rien a l'endroit demande — le
 * script retombe sur son journal par defaut, a l'interieur de WSL — et le succes est parfaitement
 * imite. Mesure du 2026-08-10, avec temoin oppose: WSLENV pose -> journal relu cote Node; WSLENV
 * retire -> fichier absent. On passe des chemins DEJA traduits, donc surtout pas le drapeau `/p`.
 */
const RUNNERS = [
  // Linux/CI: pas de lettre de lecteur, les trois traductions coincident et celle-ci gagne d'abord.
  { nom: 'posix', chemin: (p) => p, env: (e) => e },
  { nom: 'gitbash', chemin: posix('/'), env: (e) => e },
  {
    nom: 'wsl',
    chemin: posix('/mnt/'),
    env: (e) => ({
      ...e,
      WSLENV: (e.WSLENV ? e.WSLENV + ':' : '') + 'NOTE_REFUSAL_LOG:NOTE_REFUSAL_MAX',
    }),
  },
];

/**
 * Choisit un bash en le faisant TRAVAILLER, pas en testant l'existence du fichier.
 * Le temoin est un aller-retour COMPLET: le script ecrit via le namespace de bash, et la ligne
 * doit revenir lisible cote Node. Un `test -x` ne suffirait pas — un runner peut tres bien lancer
 * le script et ecrire son journal la ou Node ne regarde pas, ce qui ferait echouer les assertions
 * de contenu en accusant le sujet. Le prober porterait alors le defaut qu'il est cense surveiller.
 */
function choisirRunner() {
  const echecs = [];
  for (const r of RUNNERS) {
    const journal = path.join(tmp, 'temoin-' + r.nom + '.log');
    const marque = 'temoin-' + r.nom;
    try {
      execFileSync('bash', [r.chemin(SH), marque, 'aller-retour'], {
        env: r.env({ ...process.env, NOTE_REFUSAL_LOG: r.chemin(journal) }), stdio: 'pipe',
      });
    } catch (e) { echecs.push(r.nom + ': ' + String(e.message).split('\n')[0]); continue; }
    const vu = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : '';
    if (vu.includes(marque)) return { runner: r, echecs };
    echecs.push(r.nom + ': sortie 0 mais le journal n est pas relisible cote Node (namespace disjoint)');
  }
  return { runner: null, echecs };
}

const { runner: RUNNER, echecs: ECHECS_RUNNER } = choisirRunner();

/** Lance le script avec un journal isole. Rend { code, contenu }. */
function lancer(args, env = {}) {
  const defaut = path.join(tmp, 'refus-' + Math.abs(args.join('').length) + '-' + (args[0] || 'vide') + '.log');
  // Les appelants donnent des chemins WINDOWS. On traduit CELUI QUI GAGNE, apres la fusion: sinon un
  // NOTE_REFUSAL_LOG passe en surcharge ecraserait la version traduite par un chemin que bash ne sait
  // pas adresser, le script retomberait sur son journal par defaut, et le cas passerait au vert sans
  // avoir exerce ce qu'il pretend exercer.
  const brut = { ...process.env, NOTE_REFUSAL_LOG: defaut, ...env };
  const journal = brut.NOTE_REFUSAL_LOG;
  brut.NOTE_REFUSAL_LOG = RUNNER.chemin(journal);
  let code = 0;
  try {
    execFileSync('bash', [RUNNER.chemin(SH), ...args], { env: RUNNER.env(brut), stdio: 'pipe' });
  } catch (e) { code = e.status == null ? -1 : e.status; }
  const contenu = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : null;
  return { code, contenu, journal };
}

console.log('note-refusal: un refus laisse une trace, et ne casse jamais son appelant');

if (!RUNNER) {
  console.log('  PAS MESURE — aucun bash capable de lancer le script depuis ce systeme.');
  for (const e of ECHECS_RUNNER) console.log('    . ' + e);
  console.log('\n0 passed, 1 failed');
  console.log('Ceci n est PAS un echec du journal de refus: il n a pas ete exerce. Installer un bash');
  console.log('qui adresse ce depot (Git Bash, WSL avec /mnt/, ou Linux) puis relancer.');
  process.exitCode = 1;
  return;
}
console.log('  (bash retenu: ' + RUNNER.nom + ' — valide par aller-retour ecriture/lecture)');

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
  execFileSync('bash', [RUNNER.chemin(SH), 'wallet-watch', 'test'], {
    env: RUNNER.env({ ...process.env, NOTE_REFUSAL_LOG: RUNNER.chemin(journal), NOTE_REFUSAL_MAX: '10' }),
    stdio: 'pipe',
  });
  const lignes = fs.readFileSync(journal, 'utf8').trim().split('\n');
  assert.ok(lignes.length <= 10, 'le journal doit etre tronque a NOTE_REFUSAL_MAX — ' + lignes.length + ' lignes');
  assert.ok(/wallet-watch/.test(lignes[lignes.length - 1]), 'la ligne la plus RECENTE doit survivre a la troncature');
});

t('les refus s empilent — un second refus ne remplace pas le premier', () => {
  const journal = path.join(tmp, 'empile.log');
  for (const j of ['agent-watch', 'meme-scan']) {
    execFileSync('bash', [RUNNER.chemin(SH), j, 'r'], {
      env: RUNNER.env({ ...process.env, NOTE_REFUSAL_LOG: RUNNER.chemin(journal) }), stdio: 'pipe' });
  }
  const lignes = fs.readFileSync(journal, 'utf8').trim().split('\n');
  assert.strictEqual(lignes.length, 2, 'deux refus, deux lignes');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
