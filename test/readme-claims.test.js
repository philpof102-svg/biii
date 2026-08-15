'use strict';
/**
 * readme-claims.test.js — le README cite des chiffres; ce test les recalcule.
 * ================================================================================================
 * ⛔ CE QUE CE FICHIER EMPECHE DE REVENIR. Le 2026-08-05, TROIS chiffres sur trois etaient perimes:
 *
 *     entrees issuer-verified      annonce 147   reel 183
 *     chaines distinctes           annonce   9   reel  11
 *     outils MCP                   annonce  15   reel  28
 *     assertions / fichiers        annonce 226 / 35   reel 1248 / 94
 *     cas du harnais eval          annonce  17   reel  22
 *
 * ⚠️ ET TOUTES LES DERIVES ALLAIENT DANS LE MEME SENS: le README SOUS-ESTIMAIT. La regle anti-hype de
 * ce depot attrape d'habitude la surenchere; ici il n'y en avait aucune, et le defaut est le meme. Un
 * lecteur qui verifie trouve un ecart, et un chiffre faux par modestie coute la meme credibilite
 * qu'un chiffre faux par vantardise.
 *
 * Aucun de ces nombres n'etait faux le jour ou il a ete ecrit. Ils n'ont simplement pas suivi — et
 * c'est precisement pour ca que la garde doit etre une MACHINE et pas une intention de relire.
 *
 * Portee: verifie que le README porte les valeurs COURANTES. Ne verifie pas que ces valeurs sont
 * elles-memes justes — la source fait foi, ce test ne fait que refuser qu'elle et le texte divergent.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.join(__dirname, '..');
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8');
const README = lire('README.md');

const cas = [];
const t = (nom, fn) => cas.push([nom, fn]);

t('le nombre d entrees issuer-verified annonce est celui du registre', () => {
  const reg = JSON.parse(lire('data/issuer-verified.json'));
  const entrees = Array.isArray(reg) ? reg : (reg.entries || reg.assets || Object.values(reg).find(Array.isArray) || []);
  assert.ok(entrees.length > 0, 'registre vide: le test ne peut rien affirmer');
  assert.ok(README.includes(`**${entrees.length} entries across`),
    `le README n annonce pas « ${entrees.length} entries across » — le registre a bouge, le texte non`);
});

t('le nombre de chaines annonce est celui du registre', () => {
  const reg = JSON.parse(lire('data/issuer-verified.json'));
  const entrees = Array.isArray(reg) ? reg : (reg.entries || reg.assets || Object.values(reg).find(Array.isArray) || []);
  const chaines = new Set(entrees.map((e) => e.chainId));
  assert.ok(README.includes(`${chaines.size} chains**`),
    `le README n annonce pas « ${chaines.size} chains » — ${[...chaines].sort((a, b) => a - b).join(', ')}`);
});

/* ⛔ 2026-08-15 — CES DEUX CAS COMPTAIENT PAR REGEX SUR LE SOURCE, ET SE SONT
 * TROMPES UNE DEUXIEME FOIS. Le motif `/name:\s*'(till_[a-z_]+)'/` n'admet PAS
 * de chiffre: sur `till_b20_authentic` il s'arrete a `till_b`, n'y trouve pas le
 * guillemet fermant, et abandonne l'outil ENTIER. Comptage 28, serveur 29,
 * README 28, suite VERTE.
 *
 * La correction du 11/08 avait remplace un SUR-comptage (`till_b` pris pour un
 * outil) par un SOUS-comptage. Deux fois un README faux, deux fois du vert.
 *
 * 💎 La cause n'est pas le motif, c'est la METHODE: ce cas s'appelle « celui du
 * serveur » et ne demandait rien au serveur. `bin/biii-mcp.js` EXPORTE `TOOLS`.
 * On compte donc la liste que le serveur sert vraiment — plus de motif a tenir
 * a jour, plus de forme de source a deviner. Verifie: 29, et le README corrige. */
const { TOOLS } = require('../bin/biii-mcp.js');
const nbOutils = () => {
  assert.ok(Array.isArray(TOOLS) && TOOLS.length > 0, 'TOOLS n est plus exporte: ce test redeviendrait aveugle');
  return new Set(TOOLS.map((o) => o.name)).size;
};

t('le nombre d outils MCP annonce est celui du serveur', () => {
  const n = nbOutils();
  assert.ok(README.includes(`**${n} tools**`), `le README n annonce pas « ${n} tools »`);
});

t('le comptage vient bien de la LISTE SERVIE, pas d un motif sur le source', () => {
  // Le garde du garde. Si quelqu un revient a une regex, elle doit au moins
  // retrouver le meme compte que la liste exportee — sinon on repart pour un
  // troisieme tour du meme bug.
  const mcp = lire('bin/biii-mcp.js');
  const parMotif = new Set([...mcp.matchAll(/name:\s*'(till_[a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.strictEqual(parMotif.size, nbOutils(),
    'un outil est declare sous une forme que le motif ne voit pas — compter la liste, pas le texte');
});

/* ⛔ 2026-08-11 — CE CAS EXISTE PARCE QUE LE GATE CI-DESSUS M'A LAISSE PASSER.
 * J'ai ajoute en tete du README un resume disant « 29 MCP tools », alors que le serveur en expose 28
 * (mon comptage avait pris `till_b`, un fragment tronque, pour un outil). La suite est restee VERTE:
 * `README.includes('**28 tools**')` verifie qu'un chiffre JUSTE est PRESENT, jamais qu'un chiffre
 * FAUX est ABSENT. Le README affirmait donc deux comptes contradictoires, sans un mot.
 * 💎 Une assertion de PRESENCE ne borne rien. Celle-ci borne: AUCUN autre compte d'outils n'est tolere. */
t('le README n annonce AUCUN autre compte d outils que le vrai', () => {
  const vrai = nbOutils();
  const annonces = [...new Set([...README.matchAll(/\*\*(\d+) tools\*\*/g)].map((m) => Number(m[1])))];
  assert.ok(annonces.length > 0, 'le README n annonce aucun compte d outils — le cas precedent doit deja echouer');
  const faux = annonces.filter((n) => n !== vrai);
  assert.deepEqual(faux, [],
    `le README porte ${annonces.length} compte(s) d outils distincts; ${faux.join(', ')} ne vaut/valent pas ${vrai}`);
});

/* ⛔ Les trois chiffres du resume d en-tete, RECOMPTES. Ils ont ete ajoutes le 11/08 et rien ne les
 * surveillait: exactement le « litteral gele » que ce fichier existe pour empecher. Un gate ne protege
 * que ce qu'il COMPTE. */
t('les trois volumes annonces en tete sont ceux de l arbre', () => {
  const compter = (dossier, garde) =>
    fs.readdirSync(path.join(RACINE, dossier)).filter(garde).length;
  const volumes = [
    [compter('lib', (f) => f.endsWith('.js')), 'modules'],
    [compter('test', (f) => f.endsWith('.js')), 'test files'],
    [compter(path.join('hermes', 'economy'), (f) => f.startsWith('probe-') && f.endsWith('.js')), 'probes'],
  ];
  for (const [n, mot] of volumes) {
    assert.ok(n > 0, `aucun ${mot} compte: l arborescence a change, ce test est aveugle`);
    assert.ok(README.includes(`**${n} ${mot}**`),
      `le README n annonce pas « ${n} ${mot} » — l arbre a bouge, le texte non`);
  }
});

t('chaque outil MCP existant est NOMME dans le README', () => {
  const mcp = lire('bin/biii-mcp.js');
  const outils = [...new Set([...mcp.matchAll(/name:\s*'(till_[a-z_]+)'/g)].map((m) => m[1]))];
  const absents = outils.filter((o) => !README.includes('`' + o + '`'));
  assert.deepEqual(absents, [],
    `outil(s) livre(s) mais jamais cite(s) au lecteur: ${absents.join(', ')}`);
});

t('le README ne cite aucun outil qui n existe plus', () => {
  const mcp = lire('bin/biii-mcp.js');
  const outils = new Set([...mcp.matchAll(/name:\s*'(till_[a-z_]+)'/g)].map((m) => m[1]));
  const cites = [...new Set([...README.matchAll(/`(till_[a-z_]+)`/g)].map((m) => m[1]))];
  const fantomes = cites.filter((o) => !outils.has(o));
  assert.deepEqual(fantomes, [],
    `le README promet un outil absent du serveur: ${fantomes.join(', ')}`);
});

let passed = 0, failed = 0;
for (const [nom, fn] of cas) {
  try { fn(); passed++; console.log(`  ok   ${nom}`); }
  catch (e) { failed++; console.log(`  FAIL ${nom}\n       ${e.message}`); }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
