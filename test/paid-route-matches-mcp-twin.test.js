#!/usr/bin/env node
'use strict';
/**
 * LA ROUTE PAYANTE PASSE-T-ELLE A UNE LENTILLE CE QUE SON JUMEAU MCP LUI PASSE ?
 * ================================================================================================
 * ⛔ CE GATE EXISTE PARCE QUE LE PRECEDENT ETAIT TROP FAIBLE. `test/openapi.test.js` verifie qu'un champ
 * DECLARE au schema est NOMME par le handler. Trois defauts de la MEME famille ont frappe le meme
 * fichier, et les deux derniers passaient ce gate sans broncher:
 *
 *   2026-07-27  `chainId`           corrige dans bin/biii-mcp.js, rate dans lib/server.js — un contrat
 *                                   Solana certifie « genuine » a un client qui avait demande Base ET PAYE
 *   2026-08-09  `siblingCount`      cable cote MCP, absent cote payant — la retenue de `observedRisk`
 *                                   devenait INCONTOURNABLE pour qui paie, tandis que le gratuit la levait
 *   2026-08-10  `registryComplete`  CHARGE par server.js puis JETE — la route payante ne pouvait JAMAIS
 *                                   rendre `confirmed: true`, que le MCP gratuit rendait
 *
 * Le point commun n'est pas un champ oublie au schema: c'est un ARGUMENT que l'un des deux jumeaux
 * passe a une lentille PARTAGEE et que l'autre ne passe pas. Aucun schema ne le voit.
 *
 * CE QUE CE GATE FAIT: pour chaque lentille appelee DANS LES DEUX fichiers, il extrait les CLES d'option
 * de chaque site d'appel et signale celles que le MCP passe et que `lib/server.js` ne passe pas.
 *
 * ⚠️ SA BORNE, ECRITE ICI PARCE QU'UN GATE QUI NE DIT PAS CE QU'IL IGNORE FINIT PAR REPONDRE A LA PLACE
 * DU MONDE:
 *   · c'est une comparaison de SOURCE — elle prouve l'absence d'OUBLI PUR, jamais l'equivalence
 *     semantique. Passer `registryComplete: null` en dur satisferait ce gate et serait un mensonge;
 *   · la direction est ASYMETRIQUE et c'est voulu: un argument que seul le PAYANT passe n'est pas un
 *     defaut (le payant a le droit d'en faire plus), l'inverse si — c'est le motif « le palier facture
 *     delivre moins que le gratuit », observe trois fois;
 *   · elle ne lit pas les valeurs, seulement les cles.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('la route payante passe-t-elle a une lentille ce que son jumeau MCP lui passe ?');

const RACINE = path.join(__dirname, '..');
const MCP = fs.readFileSync(path.join(RACINE, 'bin', 'biii-mcp.js'), 'utf8');
const REST = fs.readFileSync(path.join(RACINE, 'lib', 'server.js'), 'utf8');

/* Les lentilles PARTAGEES. ⛔ Une liste figee POURRIT: chaque nom est verifie present dans LES DEUX
 * fichiers, donc un renommage fait echouer le gate bruyamment au lieu de le laisser sauter en silence.
 *
 * ⚠️ `screenAddress` A ETE RETIRE DE CETTE LISTE, ET C'EST UNE MESURE, PAS UN ABANDON. Le gate l'a
 * signale « introuvable dans lib/server.js » des son premier run — son auto-verification a donc fait
 * exactement son travail. Verifie ensuite: les deux cotes composent l'ecran d'adresse DIFFEREMMENT.
 *   · `lib/server.js` (routes /vet et /x402/vet-address) appelle `vetLocal(addr, {resourceUrl, knownBad, tc})`,
 *     le helper de `lib/vet.js` qui compose ecran + classifier en un seul verdict;
 *   · `bin/biii-mcp.js` n'appelle JAMAIS `vetLocal` — il appelle `screenAddress` directement.
 * Deux compositions distinctes pour la MEME question produit. Ce n'est pas comparable cle-a-cle (les
 * signatures different), donc ce gate ne peut pas le juger — mais c'est la forme de
 * `canonical-helper-weaker-copy`, et elle est RAPPORTEE plutot que masquee par un retrait silencieux. */
const LENTILLES = ['assessAsset', 'vetMeme'];

/** Extrait le texte d'un appel `nom(...)` en comptant les parentheses — un `slice` fixe couperait un
 *  appel multi-ligne, et c'est justement la forme qu'ont pris les correctifs recents. */
function appels(src, nom) {
  const out = [];
  let i = 0;
  for (;;) {
    const k = src.indexOf(nom + '(', i);
    if (k < 0) break;
    /* Ecarter `function assessAsset(`, `require(...).assessAsset` en declaration, etc.: on ne garde que
     * les APPELS, donc on refuse quand le mot precedent est `function`. */
    const avant = src.slice(Math.max(0, k - 12), k);
    if (avant.endsWith('function ')) { i = k + nom.length; continue; }
    let p = 0, j = k + nom.length;
    for (; j < src.length; j++) {
      if (src[j] === '(') p++;
      else if (src[j] === ')') { p--; if (p === 0) { j++; break; } }
    }
    out.push(src.slice(k, j));
    i = j;
  }
  return out;
}

/**
 * Les CLES d'option d'un appel. Pas les valeurs — voir la borne en tete.
 *
 * ⛔ DEUX FORMES, ET OUBLIER LA SECONDE PRODUIT UN FAUX POSITIF. Un premier jet ne cherchait que
 * `mot:`; le gate a alors accuse la route `/asset` de ne pas passer `token`, alors qu'elle ecrit
 * `{ token, claimedIssuer: … }` — la notation ABREGEE d'ES6, semantiquement identique a `token: token`.
 * Les deux formes sont donc extraites, et par le MEME extracteur des deux cotes: une asymetrie
 * d'extraction inventerait des ecarts qui n'existent pas dans le code.
 */
function cles(texte) {
  const s = new Set();
  for (const m of texte.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) s.add(m[1]);          // `cle: valeur`
  for (const m of texte.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) s.add(m[1]); // `{ cle }` abrege
  return s;
}

/* ── 1. LE GATE LUI-MEME ──────────────────────────────────────────────────────────────────────────── */

t('★ toute cle passee par le MCP a une lentille partagee est aussi passee par lib/server.js', () => {
  let inspectees = 0, comparaisons = 0;
  const manques = [];

  for (const nom of LENTILLES) {
    const aMcp = appels(MCP, nom), aRest = appels(REST, nom);
    /* ⛔ La liste se verifie elle-meme: un nom absent d'un cote est une PANNE du gate, pas un succes. */
    assert.ok(aMcp.length > 0, 'lentille `' + nom + '` introuvable dans bin/biii-mcp.js — liste perimee ?');
    assert.ok(aRest.length > 0, 'lentille `' + nom + '` introuvable dans lib/server.js — liste perimee ?');
    inspectees++;

    const clesMcp = new Set();
    for (const a of aMcp) for (const c of cles(a)) clesMcp.add(c);

    /* ⛔ SITE PAR SITE, ET C'EST LOAD-BEARING. Un premier jet AGREGEAIT les cles de tous les appels de
     * `lib/server.js`, et la mutation l'a pris en flagrant delit: en retirant `registryComplete` de la
     * route PAYANTE, le gate restait vert parce que la route GRATUITE `/asset` la passait encore.
     * L'agregation reposait exactement la question qu'on reproche a l'ancien gate — « ce fichier
     * mentionne-t-il la cle quelque part » — au lieu de « CE handler la passe-t-il ». Chaque site doit
     * donc porter la totalite des cles du MCP. */
    for (let s = 0; s < aRest.length; s++) {
      const clesSite = cles(aRest[s]);
      for (const c of clesMcp) {
        comparaisons++;
        if (!clesSite.has(c)) {
          manques.push(nom + ' (site ' + (s + 1) + '/' + aRest.length + ') : `' + c
            + '` passe par le MCP, absent de CE site dans lib/server.js');
        }
      }
    }
  }

  /* ⛔ Un gate qui n'a RIEN examine passe en vert: il compte ce qu'il a inspecte. */
  assert.strictEqual(inspectees, LENTILLES.length, 'toutes les lentilles doivent avoir ete inspectees');
  assert.ok(comparaisons >= 8, 'le gate doit avoir compare des cles, pas zero: ' + comparaisons);

  assert.deepStrictEqual(manques, [],
    'le palier PAYANT delivrerait moins que le gratuit:\n       ' + manques.join('\n       '));
});

/* ── 2. LE TEMOIN — sans lui, un extracteur qui rend TOUJOURS vide passerait le cas ci-dessus ──────── */

t('★ TEMOIN: l extracteur trouve VRAIMENT des cles, et sait voir un manque', () => {
  const a = appels(MCP, 'assessAsset');
  assert.ok(a.length > 0, 'au moins un appel doit etre trouve');
  const c = cles(a.join('\n'));
  assert.ok(c.has('token'), 'l extracteur doit voir `token`: ' + [...c].join(','));
  assert.ok(c.has('registryComplete'),
    'et `registryComplete` — la cle dont l absence cote payant a ete le defaut du 2026-08-10');

  /* Cas OPPOSE: sur un texte ou la cle manque, le manque doit etre DETECTE. Sans ce cas, un extracteur
   * qui rend toujours toutes les cles passerait aussi. */
  const bidon = 'assessAsset({ token: x }, { registry: r })';
  assert.strictEqual(cles(appels(bidon, 'assessAsset')[0]).has('registryComplete'), false);
});

t('l extracteur compte les parentheses — un appel MULTI-LIGNE n est pas tronque', () => {
  const src = 'vetMeme({ symbol: s,\n  chainId: c,\n  address: a,\n  siblingCount: n },\n  { autre: 1 })';
  const c = cles(appels(src, 'vetMeme')[0]);
  assert.ok(c.has('siblingCount') && c.has('autre'),
    'un slice de longueur fixe aurait coupe ici — et c est la forme qu ont prise les correctifs recents');
});

t('une DECLARATION de fonction n est pas comptee comme un appel', () => {
  assert.strictEqual(appels('function assessAsset({ token } = {}) {}', 'assessAsset').length, 0);
});

const ATTENDUS = 4;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
