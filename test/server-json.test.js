#!/usr/bin/env node
'use strict';
/**
 * server.json — la fiche que lit le registre MCP, validee AVANT d'y toucher.
 *
 * CE QUI S'EST PASSE LE 2026-07-27
 * Premiere publication reelle au registre. Onze etapes vertes — la suite de tests, le demarrage du MCP
 * stdio, la garde fail-closed sur l'existence du paquet npm, l'installation de mcp-publisher, et jusqu'au
 * LOGIN OIDC. Puis la douzieme:
 *
 *     422 Unprocessable Entity
 *     {"message":"expected length <= 100","location":"body.description","value":"Safe-to-pay & token-…"}
 *
 * 245 caracteres pour une limite de 100. Un champ trop long, decouvert au terme d'un pipeline de quatre
 * minutes, apres une authentification reussie a un service tiers. Aucun fichier de test ne referencait
 * server.json — c'est exactement pour ca qu'il est parti casse.
 *
 * POURQUOI CE TEST EST AU BON ENDROIT
 * Le workflow lance `npm test` AVANT l'etape de publication. Cette classe d'erreur echoue donc desormais
 * au portail de tests, en local et gratuitement, au lieu d'echouer au douzieme pas.
 *
 * ═══ LES CONTRAINTES VIENNENT DU SCHEMA, PAS DU MESSAGE D'ERREUR ═══
 * Se contenter de "100" parce qu'une erreur l'a dit reproduirait le raisonnement qui a rate le coup: on
 * ne saurait rien des AUTRES champs, et le prochain a grandir passerait pareil. Elles ont donc ete lues
 * dans https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json (definitions.ServerDetail),
 * relevees le 2026-07-27:
 *
 *     requis      : name, description, version
 *     name        : min 3   MAX 200   + pattern
 *     description : min 1   MAX 100
 *     title       : min 1   MAX 100
 *     version     :         MAX 255
 *
 * Elles sont figees ici plutot que retelechargees a chaque run: un test qui depend du reseau devient
 * rouge pour des raisons qui ne sont pas le code, et une suite instable entraine a ignorer le rouge.
 * `npm run test:schema` va rechercher le schema en direct et signale toute derive — a lancer quand le
 * registre annonce une version de schema.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8'));

/* Releve du schema 2025-12-11. Chaque entree porte sa contrainte, pas une valeur devinee. */
const REGLES = {
  name: { requis: true, min: 3, max: 200 },
  description: { requis: true, min: 1, max: 100 },
  version: { requis: true, max: 255 },
  title: { requis: false, min: 1, max: 100 },
};

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('server.json: valide avant de parler au registre, pas apres');

t('les trois champs REQUIS sont presents', () => {
  for (const [champ, r] of Object.entries(REGLES)) {
    if (!r.requis) continue;
    assert.ok(typeof S[champ] === 'string' && S[champ].length, 'champ requis manquant ou vide: ' + champ);
  }
});

t('aucun champ ne depasse la longueur MAXIMALE du schema', () => {
  /* Le test qui aurait attrape le 422 avant de bruler quatre minutes de CI et un login OIDC. */
  const trop = [];
  for (const [champ, r] of Object.entries(REGLES)) {
    const v = S[champ];
    if (typeof v !== 'string') continue;
    if (r.max != null && v.length > r.max) trop.push(champ + ': ' + v.length + ' caracteres pour un maximum de ' + r.max);
  }
  assert.equal(trop.length, 0, 'le registre rendra 422 sur :\n       ' + trop.join('\n       '));
});

t('aucun champ ne passe sous la longueur MINIMALE', () => {
  const court = [];
  for (const [champ, r] of Object.entries(REGLES)) {
    const v = S[champ];
    if (typeof v !== 'string' || r.min == null) continue;
    if (v.length < r.min) court.push(champ + ': ' + v.length + ' caracteres pour un minimum de ' + r.min);
  }
  assert.equal(court.length, 0, court.join('\n       '));
});

t('le nom respecte l espace de noms prouve par OIDC', () => {
  /* `mcp-publisher login github-oidc` prouve la propriete du compte GitHub, et le registre n accepte
   * alors QUE le namespace correspondant. Un nom qui ne colle pas fait echouer la publication apres une
   * authentification pourtant reussie — le meme piege, une etape plus loin. */
  assert.match(S.name, /^io\.github\.[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'nom hors forme io.github.<compte>/<serveur>');
  const compte = S.name.split('/')[0].replace('io.github.', '');
  assert.equal(compte, 'philpof102-svg', 'le namespace doit etre celui que l OIDC du depot peut prouver');
});

console.log('\ncoherence interne: ce qui est annonce doit exister');

t('la version de server.json suit celle de package.json', () => {
  /* Deux versions qui derivent produisent une fiche de registre pointant sur un paquet npm different de
   * celui qui vient d etre publie — et l installation echoue chez l appelant, pas chez nous. */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(S.version, pkg.version, 'server.json ' + S.version + ' vs package.json ' + pkg.version);
});

t('le package npm annonce porte le bon nom ET la bonne version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const npmPkg = (S.packages || []).find((p) => p.registryType === 'npm');
  if (!npmPkg) { console.log('       (aucun package npm declare — rien a verifier)'); return; }
  assert.equal(npmPkg.identifier, pkg.name, 'identifier != nom du paquet');
  assert.equal(npmPkg.version, pkg.version, 'version annoncee != version du paquet');
});

t('chaque remote declare une URL https absolue', () => {
  for (const r of (S.remotes || [])) {
    assert.match(String(r.url), /^https:\/\/[^\s]+$/, 'remote non-https ou relatif: ' + r.url);
  }
});

t('le depot declare pointe bien sur ce depot', () => {
  if (!S.repository) { console.log('       (aucun repository declare)'); return; }
  assert.match(String(S.repository.url), /github\.com\/philpof102-svg\/biii/, 'url de depot inattendue');
});

console.log('\nanti-derive de la description');

t('la description reste factuelle: aucun superlatif', () => {
  /* Regle maison, pas une regle du registre. La copy publique ne porte que des capacites verifiees —
   * une fiche de registre est lue par des agents qui choisissent qui appeler, et un superlatif y coute
   * la credibilite qu on essaie justement de vendre. */
  const interdits = /\b(best|leading|world.?class|revolutionary|ultimate|unmatched|guaranteed|100% secure|bulletproof)\b/i;
  assert.ok(!interdits.test(S.description), 'superlatif dans la description: ' + S.description);
  assert.ok(!interdits.test(S.title || ''), 'superlatif dans le titre');
});

t('la description nomme ce que le serveur FAIT, pas ce qu il est', () => {
  // Un garde faible mais reel: elle doit mentionner la chaine et au moins un verdict concret.
  assert.match(S.description, /Base/i, 'la chaine doit etre nommee');
  assert.ok(S.description.length >= 40, 'trop courte pour dire quoi que ce soit d utile: ' + S.description.length);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
