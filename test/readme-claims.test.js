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

t('le nombre d outils MCP annonce est celui du serveur', () => {
  const mcp = lire('bin/biii-mcp.js');
  const outils = [...new Set([...mcp.matchAll(/name:\s*'(till_[a-z_]+)'/g)].map((m) => m[1]))];
  assert.ok(outils.length > 0, 'aucun outil trouve: la forme du source a change, ce test est aveugle');
  assert.ok(README.includes(`**${outils.length} tools**`),
    `le README n annonce pas « ${outils.length} tools »`);
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
