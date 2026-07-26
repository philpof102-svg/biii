#!/usr/bin/env node
'use strict';
/**
 * Le garde-fou d'une classe de panne qu'aucun test de comportement n'attrape.
 *
 * token-radar.js a porte pendant des semaines un `lines.push(...)` ecrit DANS une fonction de niveau
 * module, alors que `lines` est declare dans la closure du run. Syntaxiquement valide. `node --check`
 * passe. Tous les runs passent — parce que la ligne vit dans la branche qui ecarte un pool annoncant
 * une grosse liquidite sans volume, et qu'aucun pool pareil n'etait apparu.
 *
 * Le premier qui est apparu a tue le radar entier avec une ReferenceError. Un garde ecrit pour IGNORER
 * proprement un cas a la place fait tomber le cron. Le rayon d'explosion d'une ligne de LOG etait une
 * tache planifiee complete.
 *
 * On ne peut pas provoquer la branche a volonte (elle depend du marche), donc on verifie la propriete
 * STRUCTURELLE dont elle depend : rien n'ecrit dans `lines` avant que `lines` n'existe.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const FILE = path.join(__dirname, '..', 'hermes', 'economy', 'token-radar.js');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split(/\r?\n/);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const declIdx = lines.findIndex((l) => /^\s*const lines\s*=\s*\[\]/.test(l));

console.log('token-radar: portee du collecteur de digest');

t('le tableau `lines` est bien declare une seule fois', () => {
  const all = lines.filter((l) => /^\s*const lines\s*=\s*\[\]/.test(l));
  assert.equal(all.length, 1, 'plusieurs declarations rendraient ce test ambigu');
  assert.ok(declIdx > 0, 'declaration introuvable');
});

t('aucun `lines.push` AVANT la declaration — c\'est exactement le crash de 2026-07-26', () => {
  const early = [];
  for (let i = 0; i < declIdx; i++) {
    if (/(^|[^.\w])lines\s*\.\s*push\s*\(/.test(lines[i])) early.push('L' + (i + 1) + ': ' + lines[i].trim().slice(0, 90));
  }
  assert.equal(early.length, 0,
    'ecriture dans `lines` hors de sa portee — ReferenceError garantie des que la branche s\'execute :\n       ' + early.join('\n       '));
});

t('les notes de recolte passent par HARVEST_NOTES, qui EXISTE au niveau module', () => {
  const decl = lines.findIndex((l) => /^\s*const HARVEST_NOTES\s*=\s*\[\]/.test(l));
  assert.ok(decl >= 0, 'HARVEST_NOTES doit etre declare au niveau module');
  assert.ok(decl < declIdx, 'et avant la closure du run, sinon le probleme est simplement deplace');
  assert.ok(/for \(const n of HARVEST_NOTES\) lines\.push\(n\)/.test(src),
    'les notes doivent etre VIDEES dans le digest : un pool ecarte en silence ressemble a un pool qui n\'a jamais existe');
});

t('le test mordrait vraiment — verifie sur le defaut reinjecte', () => {
  // Un test qu'on n'a jamais vu echouer n'a rien demontre. On rejoue le fichier tel qu'il etait.
  const broken = lines.slice();
  broken.splice(Math.max(1, declIdx - 5), 0, "      lines.push('regression volontaire');");
  const brokenDecl = broken.findIndex((l) => /^\s*const lines\s*=\s*\[\]/.test(l));
  let found = 0;
  for (let i = 0; i < brokenDecl; i++) if (/(^|[^.\w])lines\s*\.\s*push\s*\(/.test(broken[i])) found++;
  assert.equal(found, 1, 'le detecteur doit voir un push injecte avant la declaration');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
