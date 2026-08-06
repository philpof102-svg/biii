#!/usr/bin/env node
'use strict';
/**
 * Ce que la lecture SAIT d'elle-meme doit atteindre le disque.
 *
 * `traceFeeder` renvoie, a cote du compte de freres, des temoins qui disent COMMENT il a ete obtenu:
 * combien de pages ont ete lues, quel etait le plafond, pourquoi le balayage s'est arrete, et sur
 * combien de transactions il a porte. Sans eux, deux lignes de la base portent le meme nom de champ
 * pour deux instruments differents et rien ne permet de s'en apercevoir.
 *
 * ⛔ CE N'EST PAS THEORIQUE. `siblingTxScanned` etait renvoye depuis lib/feeder.js et jete par
 * token-radar.js, a trois lignes des trois temoins qu'on prenait soin de garder. Il porte pourtant le
 * denominateur de la DENSITE, et la densite vaut 93,4 points: parmi les tokens dont le vrai compte
 * franchit 20, ceux qui le franchissent des la premiere page ruggent a 97,1 % (106 tokens) et ceux qui
 * ne le franchissent qu'en profondeur a 3,7 % (27 tokens). Zero ligne sur 1912 le portait.
 *
 * ⚠️ ET LA PERTE EST DEFINITIVE. Les pages de l'explorateur bougent: une relecture demain ne redonne
 * pas le balayage d'aujourd'hui. Un temoin non ecrit a l'instant de la lecture n'est pas rattrapable.
 *
 * La porte ne demande pas d'ecrire un champ PRECIS — elle demande que rien de ce que la trace renvoie
 * sous `sibling*` ne soit silencieusement abandonne. Un temoin qu'on decide volontairement de ne pas
 * garder doit etre retire de `traceFeeder`, pas laisse tomber a l'arrivee.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { codeOnly } = require('../lib/code-only');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const RACINE = path.join(__dirname, '..');
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8');

/* ⛔ Le texte passe par `codeOnly` AVANT toute recherche. Une porte qui scanne du texte lit sinon sa
 * propre documentation comme du code et s'accuse elle-meme — c'est arrive quatre fois dans ce depot. */
const temoinsRendus = (src) => [...new Set([...codeOnly(src).matchAll(/^[ \t]*(sibling[A-Za-z]*)[ \t]*:/gm)].map((m) => m[1]))].sort();
const temoinsPersistes = (src) => [...new Set([...codeOnly(src).matchAll(/db\[c\.addr\]\.(sibling[A-Za-z]*)[ \t]*=/g)].map((m) => m[1]))].sort();

console.log('la trace ecrit-elle tout ce qu elle sait ?');

t('★ AUCUN temoin `sibling*` renvoye par traceFeeder n est abandonne par le radar', () => {
  const rendus = temoinsRendus(lire('lib/feeder.js'));
  const persistes = temoinsPersistes(lire('hermes/economy/token-radar.js'));
  assert.ok(rendus.length >= 4,
    'succes VIDE: ' + rendus.length + ' temoin(s) trouve(s) dans lib/feeder.js — la porte ne lit plus rien');
  assert.ok(persistes.length >= 4,
    'succes VIDE: ' + persistes.length + ' champ(s) persiste(s) trouve(s) — la porte ne lit plus rien');
  const perdus = rendus.filter((k) => !persistes.includes(k));
  assert.deepStrictEqual(perdus, [],
    'temoin(s) renvoye(s) par traceFeeder et jete(s) par token-radar.js: ' + JSON.stringify(perdus)
    + '\n       Les pages de l explorateur bougent — ce qui n est pas ecrit maintenant ne se rattrape pas.');
});

t('★ le denominateur de la DENSITE est nomme explicitement, parce que c est lui qui est tombe', () => {
  const persistes = temoinsPersistes(lire('hermes/economy/token-radar.js'));
  assert.ok(persistes.includes('siblingTxScanned'),
    'siblingTxScanned doit etre persiste: sans lui `siblingCount` seul ne distingue plus une rafale '
    + 'de vingt portefeuilles payes d affilee d un portefeuille chaud vivant depuis longtemps');
});

t('★ la porte MORD — un temoin retire du radar est detecte', () => {
  /* Le cas oppose, sur une COPIE en memoire: le fichier reel n est pas touche. Sans ce cas, une porte
   * qui ne trouve jamais rien passerait exactement comme une porte qui fonctionne. */
  const rendus = temoinsRendus(lire('lib/feeder.js'));
  const radar = lire('hermes/economy/token-radar.js');
  const ampute = radar.replace('db[c.addr].siblingTxScanned = f.siblingTxScanned;', '');
  assert.notStrictEqual(ampute, radar, 'la mutation ne s est pas appliquee — le test ne prouverait rien');
  const perdus = rendus.filter((k) => !temoinsPersistes(ampute).includes(k));
  assert.deepStrictEqual(perdus, ['siblingTxScanned'], 'la porte doit nommer le temoin manquant');
});

t('un commentaire qui MENTIONNE un temoin ne suffit pas a le declarer persiste', () => {
  const faux = 'const x = 1;\n/* db[c.addr].siblingInvente = f.siblingInvente; */\n';
  assert.deepStrictEqual(temoinsPersistes(faux), [],
    'un champ cite en commentaire ne doit pas compter comme ecrit');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
