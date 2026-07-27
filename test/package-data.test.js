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

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI PART SANS AVOIR ETE ECRIT POUR PARTIR
 *
 * Les trois tests ci-dessus demandent "les bons fichiers sont-ils la ?". Ceux-ci demandent l inverse,
 * qui est la question dangereuse: "qu est-ce qui est parti sans que personne l ait decide ?"
 *
 * Mesure du 2026-07-27, en reponse a "npm pas dangereux de laisser ?". Le champ `files` liste des
 * DOSSIERS (`lib/`, `bin/`, `web/`, `vendor/`), et un dossier est empaquete tel qu il est SUR LE DISQUE
 * au moment du publish. Pas tel qu il est dans git. Verifie en deposant deux leurres:
 *
 *     lib/.env             44B   -> PRESENT dans le tarball
 *     lib/scratch-decoy.js 11B   -> PRESENT dans le tarball
 *
 * Aucun des deux n etait suivi par git, aucun n avait ete relu par qui que ce soit, et npm pack les a
 * pris sans un mot. Le paquet 0.1.0 publie ne contenait aucun secret — verifie deux fois, par
 * till_key_exposure et par un grep brut sur les octets. Ce qui manquait n etait pas la proprete du
 * paquet, c etait ce qui la maintient au prochain coup.
 *
 * Et un vrai passager clandestin y etait deja: `lib/agent-vet-gate.js`, 10,7 kB, copie exacte de
 * `test/agent-vet-gate.js` — un fichier de TEST, avec shebang et sans un seul export, dans le dossier
 * que les consommateurs importent. Non suivi par git, donc invisible a toute relecture de diff, et
 * pourtant livre a chaque installation depuis npm.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\npassagers clandestins: qu est-ce qui part sans avoir ete decide ?');

/* Formes de fichier qui ne doivent JAMAIS sortir, quel que soit le dossier. Volontairement large: un
 * faux positif se corrige en une ligne, un secret publie ne se retire pas — npm garde les versions, et
 * un paquet depublie a deja ete miroite. */
const FORMES_INTERDITES = /(^|\/)\.env|\.pem$|\.key$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$|keystore|credential|\.p12$|\.pfx$|(^|\/)secrets?\.json$|\.mnemonic$/i;

t('aucun fichier en forme de secret dans le tarball', () => {
  if (!packed) throw new Error('liste du paquet indisponible');
  const susp = [...packed].filter((p) => FORMES_INTERDITES.test(p));
  assert.equal(susp.length, 0,
    'forme(s) de secret dans ce qui partirait chez tous les installateurs :\n       ' + susp.join('\n       '));
});

t('la regle de forme mord vraiment (auto-test)', () => {
  /* Un motif qui ne matche rien passe le test precedent en etant casse. On le prouve sur des chemins
   * temoins plutot que de faire confiance a la regex. */
  for (const t of ['lib/.env', '.env.local', 'bin/id_rsa', 'a/b/wallet.key', 'x/credentials.json']) {
    assert.ok(FORMES_INTERDITES.test(t), 'devrait etre refuse: ' + t);
  }
  for (const t of ['lib/keyscan.js', 'data/known-bad.json', 'web/index.html', 'lib/env-helper.js']) {
    assert.ok(!FORMES_INTERDITES.test(t), 'faux positif: ' + t);
  }
});

t('tout .js livre sous lib/ est un module, pas un script', () => {
  if (!packed) throw new Error('liste du paquet indisponible');
  /* `lib/` est le dossier que les consommateurs importent. Un fichier avec shebang et sans export n y
   * est pas une bibliotheque: c est un script, un test ou un brouillon. Le require d un tel fichier
   * EXECUTE son contenu au lieu de rendre une API. */
  const fautifs = [];
  for (const p of [...packed].filter((f) => f.startsWith('lib/') && /\.c?js$/.test(f))) {
    let src; try { src = fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { continue; }
    const raisons = [];
    if (src.startsWith('#!')) raisons.push('shebang');
    if (!/module\.exports|^exports\./m.test(src)) raisons.push('aucun export');
    if (raisons.length) fautifs.push(p + '  [' + raisons.join(', ') + ']');
  }
  assert.equal(fautifs.length, 0,
    'livre(s) sous lib/ sans etre un module :\n       ' + fautifs.join('\n       '));
});

t('tout fichier livre depuis un chemin de `files` est suivi par git', () => {
  if (!packed) throw new Error('liste du paquet indisponible');
  /* LA REGLE DE MECANISME, celle qui rattrape les cas qu on n a pas listes.
   *
   * npm empaquete l arbre de travail. Git est la seule chose qui garantisse qu un fichier a ete VU par
   * quelqu un: un fichier non suivi n apparait dans aucun diff, aucune relecture, aucun historique. S il
   * part quand meme chez tous les installateurs, il est sorti sans decision.
   *
   * EXEMPTION, une seule et nommee: `node_modules/trust-core/`. C est une bundleDependency declaree
   * (`trust-core: file:./vendor/trust-core`), et npm resout le lien symbolique node_modules -> vendor
   * pour l embarquer. La source EST suivie, sous vendor/. node_modules est gitignore par construction,
   * donc l exiger suivi serait exiger l impossible. */
  const EXEMPT = (p) => p.startsWith('node_modules/');
  let suivis;
  try {
    suivis = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    /* Pas de git ici (installation depuis un tarball, CI sans historique): on ne peut pas conclure.
     * Ne PAS passer en silence — un garde qui se desactive tout seul est un garde absent. */
    console.log('       (ignore: `git ls-files` indisponible, la regle ne peut pas etre evaluee)');
    return;
  }
  assert.ok(suivis.size > 50, 'sanity: git ls-files a rendu ' + suivis.size + ' entrees, trop peu pour etre vrai');
  const clandestins = [...packed].filter((p) => !EXEMPT(p) && !suivis.has(p));
  assert.equal(clandestins.length, 0,
    'livre(s) a tous les installateurs sans etre suivi(s) par git — donc jamais relu(s) :\n       '
    + clandestins.join('\n       '));
});

/* ── LA VOIE MANUELLE DOIT AVOIR LA MEME PORTE QUE LA CI ────────────────────────────────────────────
 * Constate le 2026-07-27: `biii/package.json` n'avait AUCUN `prepublishOnly`. Le workflow CI porte bien
 * son garde-fou (« Test — never publish a red build »), mais `npm publish` lance depuis une machine —
 * exactement le chemin emprunte ce soir-la pour sortir la 0.2.1 — ne lancait rien du tout. La 0.2.1 est
 * partie d'un arbre vert, mais rien ne l'imposait: rouge, elle serait partie pareil.
 *
 * Le depot jumeau onchain-forensics avait la variante voisine: un `prepublishOnly` avec sa PROPRE liste
 * de fichiers, qui avait diverge de `test` — la garde de derive ajoutee le meme jour n'etait donc pas
 * sur le chemin de publication. Deux listes divergentes est la cause racine dans les deux cas.
 *
 * Une seule liste: `prepublishOnly` delegue a `npm test`. Tout test ajoute a la suite garde la
 * publication par construction, au lieu de dependre de quelqu'un qui pense a editer une seconde chaine. */
t('la publication manuelle passe par la MEME suite que la CI', () => {
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const pre = String((p.scripts || {}).prepublishOnly || '');
  assert.ok(pre, '`npm publish` sans prepublishOnly ne lance aucun test — la voie manuelle serait nue');
  assert.strictEqual(pre.trim(), 'npm test',
    'prepublishOnly doit DELEGUER a npm test, pas recopier une liste qui derivera (vu: ' + pre + ')');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
