#!/usr/bin/env node
'use strict';
/**
 * Derive du schema du registre MCP — hors suite, lance a la demande.
 *
 * `server-json.test.js` fige les contraintes relevees le 2026-07-27, parce qu'un test qui depend du
 * reseau devient rouge pour des raisons qui ne sont pas le code, et qu'une suite instable entraine a
 * ignorer le rouge. Le prix de ce choix est qu'il vieillit en silence: le jour ou le registre resserre
 * `description` a 80, notre garde continuera de dire vert.
 *
 * Ce fichier est le contrepoids. Il va chercher le schema EN DIRECT et compare, champ par champ, avec ce
 * qui est fige. A lancer quand le registre annonce une version de schema, ou apres un 422 inattendu.
 *
 *   npm run test:schema
 *
 * Il ne fait pas partie de `npm test` deliberement, et l'exclusion est nommee dans suite-coverage.test.js.
 */
const https = require('node:https');

/* Doit rester le miroir exact de REGLES dans server-json.test.js. Si les deux divergent, ce fichier
 * mesure autre chose que ce que la suite protege. */
const FIGE = {
  name: { min: 3, max: 200 },
  description: { min: 1, max: 100 },
  version: { max: 255 },
  title: { min: 1, max: 100 },
};

const URL_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

const get = (url) => new Promise((resolve, reject) => {
  https.get(url, { headers: { accept: 'application/json' } }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
    let d = ''; res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

(async () => {
  console.log('derive du schema du registre MCP\n  source: ' + URL_SCHEMA);
  let schema;
  try {
    schema = await get(URL_SCHEMA);
  } catch (e) {
    /* FAIL-CLOSED. Un schema injoignable n'est pas un schema inchange: si ce script se taisait, il
     * signalerait "aucune derive" en n'ayant rien lu — exactement la panne que ce depot passe son temps
     * a debusquer ailleurs. */
    console.log('\n  IMPOSSIBLE DE LIRE LE SCHEMA: ' + e.message);
    console.log('  Ce n\'est PAS "aucune derive" — c\'est "je n\'ai pas pu regarder".');
    process.exit(2);
  }

  const defs = schema.definitions || schema.$defs || {};
  const sd = defs.ServerDetail;
  if (!sd || !sd.properties) {
    console.log('\n  Le schema ne contient plus definitions.ServerDetail.properties.');
    console.log('  C\'est en soi une derive structurelle: relire le schema a la main avant de publier.');
    process.exit(3);
  }

  const derives = [];
  for (const [champ, attendu] of Object.entries(FIGE)) {
    const p = sd.properties[champ];
    if (!p) { derives.push(champ + ' : a DISPARU du schema'); continue; }
    if (attendu.max != null && p.maxLength !== attendu.max) derives.push(champ + '.maxLength : fige ' + attendu.max + ' -> schema ' + p.maxLength);
    if (attendu.min != null && p.minLength !== attendu.min) derives.push(champ + '.minLength : fige ' + attendu.min + ' -> schema ' + p.minLength);
  }

  const requisSchema = (sd.required || []).slice().sort().join(',');
  const requisFige = ['description', 'name', 'version'].join(',');
  if (requisSchema !== requisFige) derives.push('champs requis : fige [' + requisFige + '] -> schema [' + requisSchema + ']');

  const nouveaux = Object.entries(sd.properties)
    .filter(([k, v]) => !(k in FIGE) && (v.maxLength != null || v.minLength != null))
    .map(([k, v]) => k + ' (max ' + v.maxLength + ')');

  console.log();
  if (!derives.length) {
    console.log('  AUCUNE DERIVE — les ' + Object.keys(FIGE).length + ' contraintes figees correspondent au schema en ligne.');
  } else {
    console.log('  ' + derives.length + ' DERIVE(S) — mettre a jour REGLES dans test/server-json.test.js :');
    derives.forEach((d) => console.log('    ' + d));
  }
  if (nouveaux.length) {
    console.log('\n  Champs CONTRAINTS que nous ne surveillons pas encore :');
    nouveaux.forEach((n) => console.log('    ' + n));
  }
  process.exit(derives.length ? 1 : 0);
})();
