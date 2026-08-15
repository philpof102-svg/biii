#!/usr/bin/env node
'use strict';
/**
 * Le garde-fou du test qui ne tourne jamais.
 *
 * Le 2026-07-26, ONZE fichiers de test vivaient dans test/ sans etre references par `npm test` — dont
 * `scorecard.test.js` et `radar-scope.test.js`, ecrits le soir meme en croyant les avoir branches. Ils
 * passaient : je les lancais a la main. Mais la suite annoncait "280 passed, 0 failed" sans les avoir vus,
 * et ce chiffre etait donc vrai ET incomplet — la pire combinaison, parce qu'il n'y a rien a remarquer.
 *
 * Un fichier de test non lance n'est pas un test faible, c'est un fichier de commentaires. Et il pourrit
 * en silence : le code qu'il protege peut deriver pendant des semaines sans qu'une seule ligne rougisse.
 *
 * Trois d'entre eux etaient invisibles pour une raison bete — ils ne finissaient pas par `.test.js`. D'ou
 * la verification sur TOUT fichier executable du dossier, pas sur un motif de nom.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test || '';

/* Exclusions DELIBEREES, nommees une par une avec leur raison. Une liste d'exclusion par motif se remplit
 * toute seule et finit par cacher exactement ce que ce test cherche ; une liste explicite oblige a justifier
 * chaque ligne.
 *
 * ⚠️ Etre exclu de `npm test` n'autorise PAS a n'etre lance par rien: c'est le probleme des orphelins sous un
 * autre nom. Chaque exclusion doit etre referencee par un AUTRE script de package.json, et le test ci-dessous
 * le verifie. */
const EXCLUS = new Map([
  ['suite-coverage.test.js', 'ce fichier — il est dans la suite, mais s\'auto-exclure evite un cycle de lecture'],
  ['e2e-real-chain.test.js',
    'depend d\'un VRAI RPC Base. Passe 2/2 en isolation, echoue par intermittence en fin de suite quand '
    + 'cinquante fichiers avant lui ont deja tape des RPC — donc rouge pour une raison qui n\'est pas le code. '
    + 'Une suite instable entraine a ignorer le rouge, ce qui est pire que de ne pas avoir le test. Lance '
    + 'deliberement par `npm run test:chain`.'],
  ['schema-drift.js',
    'va chercher le schema du registre MCP EN DIRECT. Meme raison que e2e-real-chain: une dependance reseau '
    + 'dans la suite la rend rouge pour des motifs qui ne sont pas le code. Son role est le contrepoids des '
    + 'contraintes FIGEES dans server-json.test.js, qui vieillissent en silence — il compare le fige au reel '
    + 'et sort en 1 s\'il y a derive. Lance par `npm run test:schema`, a faire tourner quand le registre '
    + 'annonce une version de schema ou apres un 422 inattendu.'],
  ['deploy-drift.js',
    'interroge le NOEUD PUBLIC en direct. Meme raison que e2e-real-chain et schema-drift: une dependance '
    + 'reseau dans la suite la rend rouge pour des motifs qui ne sont pas le code. Son role est de repondre '
    + 'a « ce qui tourne est-il ce que ce depot contient »: il demarre le serveur de CE depot en memoire, '
    + 'compare l\'ensemble des cles de /health a celui du distant, et sort en 1 s\'il manque un champ '
    + 'la-bas. Il existe parce que le `deployment.marker` prevu pour cette question n\'est PAS deploye — '
    + 'un marqueur ne peut rien dire tant qu\'il n\'est pas en ligne, une comparaison de FORME le peut des '
    + 'le premier jour. Trois codes: 0 meme forme, 1 derive, 2 sonde muette (une panne de sonde ne doit '
    + 'jamais se lire comme un vert). Lance par `npm run test:deploy`, a faire tourner AVANT et APRES '
    + 'chaque deploiement.'],
  ['suite-total.js',
    'lance `npm test` lui-meme pour en additionner les bilans: l\'inclure dans la suite ferait tourner la '
    + 'suite entiere a l\'interieur de la suite. Il repare le fait que le total etait compte a la main et '
    + 'publie faux deux fois le 2026-07-27 (une fois ecrit avant la mesure, une fois mesure avec un '
    + 'compteur aveugle a 13 suites sur 63). Lance par `npm run test:total`, a faire tourner avant '
    + 'd\'ecrire un nombre de tests ou que ce soit.'],
]);

/* HELPERS partages : requis par d'autres fichiers de test, jamais lances seuls.
 *
 * ⚠️ Cette categorie est NEE d'un manque, le 2026-08-14. `test/bash-runner.js` a ete extrait parce que
 * DEUX fichiers avaient, a cinq jours d'ecart, appele `bash -n` avec un chemin que le bash local ne sait
 * pas ouvrir — et publiaient « script shell invalide » sur des fichiers jamais lus. Le helper n'est ni un
 * test (rien ne l'a lance) ni un exclu (aucun script npm ne le lance): il est REQUIS. Le modele du garde
 * n'avait pas ce troisieme etat, et l'aplatir sur l'un des deux autres etait exactement le defaut que ce
 * fichier surveille.
 *
 * ⛔ Le mettre dans un sous-dossier pour echapper au `readdirSync` aurait « repare » le rouge en creant
 * une zone que plus rien ne regarde — un vrai orphelin pourrait s'y cacher. Une categorie VERIFIEE vaut
 * mieux qu'un angle mort: chaque ligne ci-dessous doit prouver qu'un fichier REELLEMENT lance la requiert. */
const HELPERS = new Map([
  ['bash-runner.js',
    'comment on adresse ce depot depuis `bash` (WSL /mnt/, Git Bash /d/, POSIX). Requis par '
    + 'note-refusal.test.js et runner-reachability.test.js, tous deux dans la suite. Son propre '
    + 'comportement est epingle par bash-runner.test.js, qui est lance, lui.'],
]);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('couverture de la suite : tout fichier de test est-il reellement lance ?');

const fichiers = fs.readdirSync(__dirname)
  .filter((f) => /\.(c?js|mjs)$/.test(f) && !EXCLUS.has(f) && !HELPERS.has(f));

t('chaque HELPER declare est vraiment requis par un fichier que la suite lance', () => {
  const orphelins = [];
  for (const [f, raison] of HELPERS) {
    const base = f.replace(/\.(c?js|mjs)$/, '');
    /* La relation est VERIFIEE, pas declaree: on cherche un `require('./<base>')` dans un fichier que
     * `npm test` lance vraiment. Un helper que plus personne n'importe est un orphelin sous un autre
     * nom — la faute meme que l'exclusion ci-dessus refuse de laisser passer. */
    const requerants = fs.readdirSync(__dirname)
      .filter((x) => x !== f && /\.(c?js|mjs)$/.test(x) && script.includes('test/' + x))
      .filter((x) => new RegExp(`require\\((['"])\\./${base}\\1\\)`)
        .test(fs.readFileSync(path.join(__dirname, x), 'utf8')));
    if (!requerants.length) orphelins.push(f + '  — declare helper parce que: ' + raison);
  }
  assert.equal(orphelins.length, 0,
    'helper(s) que PLUS AUCUN fichier lance ne requiert — donc lance par rien et requis par rien :\n       '
    + orphelins.join('\n       '));
  /* Temoin de non-vacuite: une liste vide ferait passer ce cas sans rien verifier. */
  assert.ok(HELPERS.size > 0, 'succes vide: aucun helper declare, ce cas ne mesure rien');
});

t('un HELPER n\'est pas un test deguise — aucun n\'est lance par la suite', () => {
  /* Cas oppose: si un helper etait AUSSI dans la chaine, il devrait etre un test tout court et sa ligne
   * d'exception n'a pas lieu d'etre. Sans ce controle, la liste ci-dessus pourrait tout absorber. */
  const deguises = [...HELPERS.keys()].filter((f) => script.includes('test/' + f));
  assert.deepStrictEqual(deguises, [],
    'declare(s) helper mais lance(s) par npm test: retirer leur ligne, ce sont des tests : ' + deguises.join(', '));
});

t('chaque fichier EXCLU de la suite est lance par un autre script', () => {
  const tous = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {};
  const orphelins = [];
  for (const [f, raison] of EXCLUS) {
    if (f === 'suite-coverage.test.js') continue;      // celui-la EST dans la suite, il s'exclut de sa propre lecture
    const lance = Object.entries(tous).some(([nom, cmd]) => nom !== 'test' && cmd.includes('test/' + f));
    if (!lance) orphelins.push(f + '  — exclu parce que: ' + raison);
  }
  assert.equal(orphelins.length, 0,
    'exclu de `npm test` ET lance par rien = orphelin sous un autre nom :\n       ' + orphelins.join('\n       '));
});

t('aucun fichier de test n\'est orphelin', () => {
  const orphelins = fichiers.filter((f) => !script.includes('test/' + f));
  assert.equal(orphelins.length, 0,
    orphelins.length + ' fichier(s) dans test/ que `npm test` ne lance pas — ils ne protegent rien :\n       '
    + orphelins.join('\n       '));
});

t('le script ne reference pas un fichier qui n\'existe plus', () => {
  const cites = [...script.matchAll(/node\s+test\/([\w.-]+)/g)].map((m) => m[1]);
  const fantomes = cites.filter((f) => !fs.existsSync(path.join(__dirname, f)));
  assert.equal(fantomes.length, 0, 'reference(s) morte(s) : ' + fantomes.join(', '));
});

t('la detection ne depend PAS du suffixe .test.js', () => {
  // Trois des onze orphelins s'appelaient agent-vet-gate.js, lure-ask.js, seed-exposure.js. Un garde base
  // sur le nom les aurait rates exactement comme le script les ratait.
  const sansSuffixe = fichiers.filter((f) => !/\.test\.(c?js)$/.test(f));
  assert.ok(sansSuffixe.length > 0, 'sanity : il existe bien des tests sans le suffixe, sinon cette regle ne prouve rien');
  for (const f of sansSuffixe) {
    assert.ok(script.includes('test/' + f), f + ' n\'est pas lance et ne porte pas le suffixe — le cas exact du 26/07');
  }
});

t('le test mordrait vraiment — verifie sur un orphelin simule', () => {
  const faux = 'orphelin-imaginaire.test.js';
  assert.ok(!script.includes('test/' + faux), 'un fichier absent du script doit etre detecte comme orphelin');
});

/* ── UN HARNAIS SYNCHRONE REND TOUT TEST `async` INCAPABLE D'ECHOUER ────────────────────────────────
 * Constate le 2026-07-27 dans test/invoice.test.js:
 *
 *     const t = (n, fn) => { try { fn(); pass++; } catch (e) { fail++; } };
 *
 * Un corps `async` ne jette JAMAIS de facon synchrone — il rend une promesse rejetee. Le `catch` ne voit
 * rien, `pass++` s'execute toujours. Trois cas ecrits ce jour-la pour couvrir la chaine MCP des factures
 * passaient donc inconditionnellement; ils sont restes verts a travers QUATRE mutations qui cassaient
 * exactement ce qu'ils pretendaient couvrir.
 *
 * Sans le mutation-test, trois tests verts auraient garanti un chemin non couvert. C'est le pire genre
 * de test: il ne manque pas, il rassure.
 *
 * Cette garde compare, par fichier, la definition du harnais et la forme des corps de test. */
t('aucun harnais synchrone ne pilote de test async', () => {
  const coupables = [];
  for (const f of fs.readdirSync(__dirname).filter((x) => /\.(c?js|mjs)$/.test(x))) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    /* La DECLARATION du harnais, dans sa forme fleche mono-ligne (celle qui piege). */
    const decl = (src.match(/^\s*const\s+(?:t|check|test)\s*=\s*\([^)]*\)\s*=>\s*\{.*$/m) || [])[0];
    if (!decl) continue;
    /* Un harnais sur — il empile (push) ou il attend (await/then/Promise). */
    const sur = /await|\.then\(|Promise|\.push\(/.test(decl);
    if (sur) continue;
    /* Des corps de test async pilotes par ce harnais — SUR UNE SEULE LIGNE.
     *
     * ⚠️ Premier jet: `[\s\S]*?` entre le nom et `async`. Ca traverse les retours a la ligne, donc un
     * `t('...')` synchrone en haut du fichier s appariait avec un `async` situe cent lignes plus bas,
     * dans un tout autre appel. Quatre faux positifs (erc8004, export, harden, rwa-registry) — dont
     * erc8004, qui pilote justement ses cas async par un SECOND harnais `tA`, correctement attendu.
     *
     * Une garde qui crie au loup se fait desactiver; c est pire que pas de garde. La classe de
     * caracteres exclut donc le saut de ligne. */
    const asyncs = (src.match(/^\s*(?:t|check|test)\(\s*(['"`])[^'"`\n]*\1\s*,\s*async\s/gm) || []).length;
    if (asyncs > 0) coupables.push(f + ' (' + asyncs + ' cas async)');
  }
  assert.deepStrictEqual(coupables, [],
    'harnais synchrone + corps async = des tests qui ne peuvent pas echouer: ' + JSON.stringify(coupables));
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * LE MIROIR DU GARDE PRECEDENT — et il fallait le mesurer pour le voir.
 *
 * Le cas ci-dessus attrape un harnais SYNCHRONE pilotant des corps async. Le defaut symetrique est un
 * harnais ASYNC, parfaitement ecrit, dont l'appelant n'attend jamais la promesse: `process.exit` part
 * avant la resolution et le cas n'est ni compte, ni execute, ni rapporte.
 *
 * Mesure du 2026-07-29 — les deux fichiers touches sont EXACTEMENT ceux que le garde precedent avait
 * du exclure comme faux positifs (voir son commentaire):
 *   test/harden.test.js        9 cas declares -> « 8 passed · 0 failed », exit 0
 *   test/rwa-registry.test.js  8 cas declares -> « 7 passed · 0 failed », exit 0
 * Les cas perdus etaient celui qui verifie le DESTINATAIRE d'un log de paiement, et le seul qui couvre
 * la pagination de fetchAll — dont la troncature silencieuse a effectivement survecu jusqu'a ce jour.
 * Un test mort est indiscernable d'un test vert: c'est le motif du depot, applique a l'instrument.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */
t('aucun harnais async ne voit ses cas perdus par une sortie synchrone', () => {
  const coupables = [];
  for (const f of fs.readdirSync(__dirname).filter((x) => /\.(c?js|mjs)$/.test(x))) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const decl = (src.match(/^\s*const\s+(\w+)\s*=\s*async\s*\(/m) || []);
    if (!decl.length) continue;
    const nom = decl[1];
    /* Un harnais sur COLLECTE ses promesses dans sa propre declaration (push) — la forme corrigee. */
    if (/\.push\(/.test(decl[0])) continue;
    /* Les appels en debut de ligne: c'est ainsi que les cas sont ecrits. `await NOM(` est sur. */
    const appels = (src.match(new RegExp('^' + nom + '\\(', 'gm')) || []).length;
    const attendus = (src.match(new RegExp('^\\s*await\\s+' + nom + '\\(', 'gm')) || []).length;
    /* Et la sortie: un process.exit en COLONNE 0 s'execute avant toute promesse en vol. */
    const sortieSync = /^process\.exit\(/m.test(src);
    if (appels > attendus && sortieSync) coupables.push(`${f} (${appels - attendus} cas \`${nom}\` perdu(s))`);
  }
  assert.deepStrictEqual(coupables, [],
    'harnais async + sortie synchrone = des cas qui ne s\'executent jamais, en vert: ' + JSON.stringify(coupables));
});

console.log('\n' + fichiers.length + ' fichier(s) de test verifie(s)');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
