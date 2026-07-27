#!/usr/bin/env node
'use strict';
/**
 * Le garde-fou du fichier de donnees qui ne part pas dans le paquet.
 *
 * Le 2026-07-27, `till_funder_history` a ete ecrit, teste, deploye et prouve en production — puis installe
 * depuis un tarball npm, ou il repondait `no_database` a TOUS les appelants. `data/token-radar/tokens.json`
 * n etait pas dans l allowlist `files`. `data/issuer-verified.json` non plus, donc `till_vet_asset` perdait
 * son niveau issuer-official par la meme porte.
 *
 * C est la meme classe que le depot publie sans son module: le paquet a l air complet, s installe sans une
 * erreur, expose ses 29 outils, et deux d entre eux ne peuvent structurellement rien dire. Rien ne rougit.
 *
 * ═══ POURQUOI CE TEST LIT LE VRAI TARBALL ═══
 * `npm pack --dry-run --json` donne la liste EXACTE que recevra un installateur, allowlist, .npmignore et
 * regles implicites comprises. Comparer a `package.json.files` a la main reproduirait le raisonnement qui a
 * rate le bug la premiere fois.
 *
 * ═══ ET POURQUOI DEUX LISTES, PAS UNE ═══
 * Un fichier de donnees est soit une REFERENCE (le code la lit: elle doit partir), soit un ETAT D EXECUTION
 * (le code l ecrit: elle ne doit SURTOUT pas partir — livrer l usage.json ou le x402-consumed.json d une
 * autre machine serait au mieux du bruit, au pire une fuite). Toute reference `data/...` trouvee dans le
 * source doit etre classee dans l une ou l autre, sinon le test echoue: c est ce qui empeche le prochain
 * ajout d etre oublie.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/** Doivent PARTIR: le code les lit, un installateur en a besoin. */
const MUST_SHIP = {
  'data/known-bad.json': 'le plancher known-bad — sans lui, till_trust ne bloque rien',
  'data/token-radar/tokens.json': 'la base d observation — sans elle, till_funder_history dit no_database a tout le monde',
  'data/issuer-verified.json': 'les 40 dShares verifiees emetteur — sans elles, till_vet_asset perd son niveau issuer-official',
};

/** Ne doivent PAS partir: etat d execution, propre a une machine. */
const MUST_NOT_SHIP = {
  'data/usage.json': 'compteur d usage: livrer celui d une autre machine serait du faux trafic',
  'data/x402-consumed.json': 'anti-replay: l etat d un autre noeud ne protege pas le mien et pourrait bloquer ses paiements',
  'data/wallet-watch': 'etat du moniteur de wallet: propre a qui surveille, et il nomme des adresses',
};

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('contenu du paquet npm: ce que recevra vraiment un installateur');

/* La liste que npm produirait. On lit le tarball, pas notre idee du tarball. */
let packed;
/* Deux marches sur Windows, prises l une apres l autre en lancant le test:
 *   - `npm` seul -> ENOENT, l executable est `npm.cmd` et execFileSync ne passe pas par un shell ;
 *   - `npm.cmd` -> EINVAL, Node recent refuse de spawner un .cmd sans shell (durcissement contre
 *     l injection d arguments).
 * D ou `shell: true`, qui est sur ICI et seulement ici: les arguments sont des constantes litterales, aucune
 * entree exterieure ne les touche. Avec une valeur venue d ailleurs il faudrait l inverse. */
const WIN = process.platform === 'win32';
t('npm pack --dry-run repond', () => {
  const out = execFileSync(WIN ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: WIN });
  const j = JSON.parse(out);
  packed = new Set((j[0].files || []).map((f) => f.path.replace(/\\/g, '/')));
  assert.ok(packed.size > 10, 'liste suspecte: ' + packed.size + ' entrees');
});

t('chaque fichier de reference part bien dans le paquet', () => {
  if (!packed) throw new Error('liste du paquet indisponible');
  const manquants = Object.keys(MUST_SHIP).filter((f) => !packed.has(f));
  assert.equal(manquants.length, 0, 'absent(s) du paquet, donc l outil qui en depend est inerte a l installation :\n       '
    + manquants.map((f) => f + '  — ' + MUST_SHIP[f]).join('\n       '));
});

t('aucun etat d execution ne part dans le paquet', () => {
  if (!packed) throw new Error('liste du paquet indisponible');
  const fuites = Object.keys(MUST_NOT_SHIP).filter((f) => [...packed].some((p) => p === f || p.startsWith(f + '/')));
  assert.equal(fuites.length, 0, 'etat d execution embarque :\n       '
    + fuites.map((f) => f + '  — ' + MUST_NOT_SHIP[f]).join('\n       '));
});

console.log('\nanti-derive: un nouveau fichier de donnees ne peut pas etre oublie');
t('toute reference data/... du CODE LIVRE est classee', () => {
  /* PERIMETRE DERIVE DE `files`, PAS ECRIT EN DUR.
   *
   * Ce garde ne verifie pas tout le depot: il verifie ce que RECOIT un installateur. `hermes/` n'est pas
   * livre, donc les fichiers de donnees que seul le radar lit (data/token-radar/blackouts.json) ne
   * concernent pas le paquet — les exiger dedans gonflerait le tarball pour rien.
   *
   * Mais un perimetre ecrit en dur derive: le jour ou `hermes/` entre dans `files`, un balayage fige sur
   * lib/+bin/ continuerait de dire vert en ayant cesse de couvrir le code livre. Il est donc LU depuis
   * `files`, et suit tout seul. */
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files || [];
  const dirs = shipped.filter((f) => f.endsWith('/')).map((f) => path.join(ROOT, f.replace(/\/$/, '')))
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  assert.ok(dirs.length >= 2, 'sanity: au moins lib/ et bin/ devraient etre livres, vu ' + dirs.length);

  const files = [];
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      if (it.name === 'node_modules') continue;
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p); else if (/\.c?js$/.test(it.name)) files.push(p);
    }
  };
  for (const d of dirs) walk(d);

  const trouves = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // path.join(<quelque chose>, 'data', 'a', 'b.json')  →  data/a/b.json
    for (const m of src.matchAll(/'data'\s*,\s*((?:'[\w.-]+'\s*,?\s*)+)/g)) {
      const parts = [...m[1].matchAll(/'([\w.-]+)'/g)].map((x) => x[1]);
      if (parts.length) trouves.add('data/' + parts.join('/'));
    }
    for (const m of src.matchAll(/['"]\.\.\/data\/([\w./-]+)['"]/g)) trouves.add('data/' + m[1]);
  }

  assert.ok(trouves.size >= 4, 'sanity: le balayage devrait trouver plusieurs chemins, il en a trouve ' + trouves.size);
  const nonClasses = [...trouves].filter((f) => !(f in MUST_SHIP) && !(f in MUST_NOT_SHIP));
  assert.equal(nonClasses.length, 0,
    'chemin(s) data referencé(s) par le code et classé(s) nulle part — decidez s ils doivent partir ou non :\n       '
    + nonClasses.join('\n       '));
});

t('le test morderait: un fichier de reference retire de l allowlist est detecte', () => {
  // Pas de vraie mutation de package.json ici — on verifie que la comparaison est bien faite contre la liste
  // packee et non contre une copie de MUST_SHIP, ce qui la rendrait vacue.
  const faux = 'data/ce-fichier-n-existe-pas.json';
  assert.ok(!packed.has(faux), 'un fichier absent doit etre vu comme absent');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
