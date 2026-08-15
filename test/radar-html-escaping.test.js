#!/usr/bin/env node
'use strict';
/**
 * Le radar PUBLIE rendait en HTML une valeur que n'importe qui peut choisir.
 * ==========================================================================
 * `web/` part dans le tarball npm (`files`), et `lib/server.js` sert `/radar.html`. La page affiche
 * le flux des verifications recentes; `rowHtml` construit chaque ligne par concatenation. Sur UNE
 * SEULE LIGNE, la meme valeur etait traitee deux fois differemment:
 *
 *     '<span class="q" title="' + esc(r.q) + '">' + esc(r.kind) + ' · ' + short(r.q) + …
 *
 * `esc(r.q)` protegeait l'attribut, `short(r.q)` inserait la MEME valeur crue dans le texte —
 * `short` ne faisait que tronquer. Une valeur de 16 caracteres ou moins ressortait ENTIERE, et
 * `<svg onload=x>` en fait 14.
 *
 * 🔴 D'OU VIENT `r.q`, mesure le 2026-08-15 dans `lib/server.js`:
 *   - `/trust` valide `^0x[0-9a-f]{40}$` et rend 400 sinon — rien a injecter par la.
 *   - la route meme enregistre `logCheck({ q: b.symbol || b.address || '?' })`, et `b.symbol` est du
 *     TEXTE LIBRE. Elle est payante (x402): c'est un COUT, pas un controle d'entree.
 * `radar.html` etant servi par le nœud, la valeur s'execute chez celui qui ouvre la page — c'est-a-dire
 * l'operateur.
 *
 * ⛔ ET LE `else` D'UNE LISTE BLANCHE RECOPIAIT SON ENTREE. `tagFor` rendait `['? ' + v, 'unk']` pour
 * un verdict inconnu, sans borne ni echappement, et ce texte part dans le HTML.
 *
 * ⚖️ BORNES. Ce test extrait les fonctions de rendu du fichier PUBLIE et les evalue — il ne lance pas
 * de navigateur, donc il prouve que la CHAINE produite ne contient pas de balise, pas qu'un moteur de
 * rendu reel se comporterait comme prevu. Aucun reseau.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0; let fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('radar.html — ce qui devient du HTML:');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'radar.html'), 'utf8');

/* On evalue le bloc <script> de la page dans un bac a sable, avec juste ce qu'il touche au chargement.
 * Repere par MARQUEUR (les definitions), jamais par numero de ligne. */
const bloc = (HTML.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
const sandbox = { document: { getElementById: () => ({ innerHTML: '' }) }, fetch: () => new Promise(() => {}),
  window: {}, console: { log() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0 };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

t('le bloc de rendu de la page publiee est bien lu', () => {
  assert.ok(bloc && bloc.length > 500, 'succes vide: aucun <script> lu dans radar.html');
  for (const nom of ['esc', 'short', 'tagFor', 'card', 'rowHtml']) {
    assert.ok(new RegExp('\\b' + nom + '\\b').test(bloc), 'fonction ' + nom + ' introuvable — la page a change de forme');
  }
  /* ⚠️ Le bloc est une IIFE `(function(){…})();` — un export ajoute APRES s'evalue HORS de la
   * fermeture et ne voit rien (`esc is not defined`, mesure du premier jet). On l'injecte DEDANS,
   * juste avant la parenthese finale, reperee comme marqueur. */
  const fin = bloc.lastIndexOf('})();');
  assert.notStrictEqual(fin, -1, 'fermeture de l IIFE introuvable — la page a change de forme');
  const instrumente = bloc.slice(0, fin)
    + '\n;globalThis.__r = { esc:esc, short:short, tagFor:tagFor, card:card, rowHtml:rowHtml };\n'
    + bloc.slice(fin);
  vm.runInContext(instrumente, sandbox);
  assert.strictEqual(typeof sandbox.__r.rowHtml, 'function');
});

const R = () => sandbox.__r;
/* Charges utiles COURTES: le raccourcisseur laissait passer entier tout ce qui fait 16 ou moins. */
const CHARGES = ['<svg onload=x>', '<img src=x>', '"><b>x</b>', "'><i>y</i>", '<b>1</b>', '</span><b>'];

t('★ aucune charge courte ne survit dans la ligne rendue', () => {
  const survivants = [];
  for (const p of CHARGES) {
    const out = R().rowHtml({ q: p, kind: 'meme', verdict: 'impersonation' });
    if (/<(svg|img|b|i)\b/i.test(out)) survivants.push(p + ' -> ' + out.slice(0, 110));
  }
  assert.deepEqual(survivants, [],
    'balise(s) rendue(s) depuis une valeur d appelant:\n  ' + survivants.join('\n  ')
    + '\n  `short()` tronquait sans echapper, et une valeur de 16 caracteres ou moins passait entiere.');
});

t('★ le raccourcisseur echappe aussi ce qu il TRONQUE', () => {
  /* Une charge longue est coupee — mais les 10 premiers caracteres partent quand meme dans le HTML. */
  const out = R().rowHtml({ q: '<svg onload=alert(document.cookie)>', kind: 'meme', verdict: 'genuine' });
  assert.ok(!/<svg/i.test(out), 'meme tronquee, l ouverture de balise ne doit pas sortir: ' + out.slice(0, 120));
});

t('★ le `else` de la liste blanche ne recopie plus son entree', () => {
  const out = R().rowHtml({ q: '0x' + 'ab'.repeat(20), kind: 'trust', verdict: '<img src=x onerror=1>' });
  assert.ok(!/<img/i.test(out), 'un verdict inconnu ne doit pas devenir du HTML: ' + out.slice(0, 140));
  const long = R().rowHtml({ q: '0x1', kind: 'trust', verdict: 'z'.repeat(500) });
  assert.ok(long.length < 400, 'et il doit rester borne, vu ' + long.length + ' caracteres');
});

t('★ card echappe ses propres entrees, sans compter sur l appelant', () => {
  const out = R().card('<b>9</b>', '<i>label</i>', '<u>sm</u>');
  for (const balise of ['<b>', '<i>', '<u>']) {
    assert.ok(!out.includes(balise), balise + ' ne doit pas survivre: ' + out.slice(0, 120));
  }
});

t('TEMOIN: une ligne legitime reste lisible et complete', () => {
  /* Cas oppose: un echappement qui detruirait le contenu passerait tous les tests ci-dessus. */
  const adr = '0x' + 'ab'.repeat(20);
  const out = R().rowHtml({ q: adr, kind: 'asset', verdict: 'genuine', issuer: 'Circle' });
  assert.ok(out.includes('✓ genuine'), 'le verdict connu doit s afficher');
  assert.ok(out.includes('asset'), 'le kind doit s afficher');
  assert.ok(out.includes('Circle'), 'l emetteur doit s afficher');
  assert.ok(out.includes('0xababab'), 'et le debut de l adresse aussi, vu ' + out.slice(0, 160));
  assert.ok(!out.includes('&amp;amp;'), 'aucun double echappement');
});

t('TEMOIN: une esperluette legitime est echappee UNE fois', () => {
  const out = R().card(1, 'A & B', 'x & y');
  assert.ok(out.includes('A &amp; B'), 'echappee: ' + out);
  assert.ok(!out.includes('&amp;amp;'), 'et une seule fois — le double echappement se VOIT a l ecran');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
