'use strict';
/**
 * LA CAISSE — LE MONTANT AFFICHE SOUS « ✓ PAYE » EST LU, OU IL EST DIT NON LU. JAMAIS FABRIQUE.
 * Run: node test/paid-amount-is-read-or-said.test.js
 *
 * ⚠️ CE QUI A ETE TROUVE (2026-08-15, premiere lecture de web/index.html — la caisse que le commercant
 * touche vraiment, jamais auditee jusqu'ici).
 *
 * Le montant paye vient de `microToUsd(verdict.paidMicro)`, et LES DEUX FORMES D'ABSENCE rendaient
 * DEUX MAUVAISES REPONSES DIFFERENTES:
 *
 *   paidMicro ABSENT     → `String(micro||"0")` donnait "0", qui passe la regex → « 0.00 USDC »
 *                          affiche sous un « ✓ PAYE ». Un recu paye pour zero.
 *   paidMicro ILLISIBLE  → microToUsd rendait null, et l'appelant retombait par `||` sur
 *                          `formatDisplay(rawCents)` — LE MONTANT QUE LE COMMERCANT AVAIT TAPE.
 *
 * Le second est le plus couteux: `till.verifyPayment` accepte le SURPAIEMENT (`got >= want` ⇒ paye,
 * avec `overpaidMicro`), donc paye != demande PAR CONSTRUCTION. Le recu — decrit dans le code comme
 * « anchored to the on-chain tx (the real proof) », celui que la comptabilite recopie — aurait imprime
 * un chiffre que la chaine n'a jamais confirme. Et ni l'un ni l'autre ne disait « je n'ai pas su lire ».
 *
 * ⚖️ BORNE HONNETE — CE N'EST PAS UN DEFAUT VIVANT. Aucun des deux chemins n'est atteignable
 * aujourd'hui: `verifyPayment` ne pose `paidMicro` que dans sa branche payante et n'y met que des
 * chiffres (`/^\d+$/` valide en amont), le chemin DEMO passe `charge.amountMicro`, et `API = ""` donc
 * le JSON vient du meme noeud qui sert la page. C'est de la defense en profondeur sur le SEUL nombre
 * que le commercant recopie dans ses livres. Le dire plutot que de vendre une prise.
 *
 * ⚖️ AUTRE BORNE: ce fichier extrait le bloc <script> de la page PUBLIEE et l'evalue dans un bac a
 * sable. Il prouve ce que le code DECIDE et ce qu'il ECRIT dans le DOM stubbe — il ne lance aucun
 * navigateur, donc il ne prouve pas le rendu reel. Aucun reseau.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('index.html — le montant paye est lu, ou il est dit non lu:');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
// le bloc de la caisse est le SECOND <script> (le premier charge qrcode.min.js): on prend celui qui a du corps.
const bloc = (HTML.match(/<script>\s*\(function\(\)\{([\s\S]*?)\n\}\)\(\);\s*<\/script>/) || [])[0];

// ── le DOM juste assez reel pour que la page se charge, et OBSERVABLE ──
const elements = new Map();
const mkEl = (id) => {
  const el = { id, textContent: '', innerHTML: '', value: '', disabled: false, style: { cssText: '', display: '' },
    classList: { add() {}, remove() {} }, handlers: {},
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    removeEventListener() {}, appendChild() {}, removeChild() {}, closest() { return null; },
    querySelector() { return mkEl('?'); }, setAttribute() {}, focus() {} };
  return el;
};
const cree = [];
const sandbox = {
  document: {
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, mkEl(id)); return elements.get(id); },
    querySelector: (s) => { if (!elements.has(s)) elements.set(s, mkEl(s)); return elements.get(s); },
    querySelectorAll: () => [],
    createElement: (tag) => { const e = mkEl(tag); cree.push(e); return e; },
    body: { appendChild() {}, removeChild() {} },
    addEventListener() {},
  },
  window: { addEventListener() {} }, navigator: {}, location: { search: '', href: '' },
  URLSearchParams: global.URLSearchParams, fetch: () => new Promise(() => {}),
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  console: { log() {}, error() {} }, qrcode: () => ({ addData() {}, make() {}, createImgTag: () => '<img>' }),
  Date, Math, JSON, String, Number, Boolean, Array, Object, RegExp, Error, Promise,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

t('le bloc de la caisse publiee est bien lu', () => {
  assert.ok(bloc && bloc.length > 2000, 'succes vide: le <script> de la caisse n a pas ete lu');
  for (const nom of ['microToUsd', 'showPaid', 'formatDisplay', 'MONTANT_ILLISIBLE']) {
    assert.ok(new RegExp('\\b' + nom + '\\b').test(bloc), nom + ' introuvable — la page a change de forme');
  }
  // ⚠️ IIFE: un export ajoute APRES s'evalue HORS de la fermeture. On l'injecte DEDANS, avant `})();`,
  // repere comme MARQUEUR (jamais par numero de ligne).
  const fin = bloc.lastIndexOf('})();');
  assert.notStrictEqual(fin, -1, 'fermeture de l IIFE introuvable');
  const instrumente = bloc.slice(0, fin)
    + '\n;globalThis.__c = { microToUsd:microToUsd, showPaid:showPaid, formatDisplay:formatDisplay,'
    + ' ILLISIBLE:MONTANT_ILLISIBLE, recu:$btnReceipt, setLast:function(v){ lastVerdict = v; },'
    + ' setCents:function(n){ rawCents = n; } };\n'
    + bloc.slice(fin);
  vm.runInContext(instrumente.replace(/^<script>/, '').replace(/<\/script>$/, ''), sandbox);
  assert.strictEqual(typeof sandbox.__c.showPaid, 'function');
});

const C = () => sandbox.__c;

t('microToUsd rend TROIS etats, et les deux absences tombent du MEME cote', () => {
  assert.strictEqual(C().microToUsd('4500000'), '4.50', 'un montant lisible se lit');
  // 1 micro = 0,000001 USDC. J'avais ecrit '0.00' au premier jet: mon attente etait fausse, pas le
  // code — la fonction garde la precision au-dela de deux decimales quand le montant en a besoin.
  assert.strictEqual(C().microToUsd('1'), '0.000001', 'un micro-montant se lit aussi, sans etre arrondi a zero');
  assert.strictEqual(C().microToUsd('4000000'), '4.00', 'et un compte rond garde ses deux decimales de facture');
  // les DEUX formes d absence: elles rendaient AVANT deux reponses differentes, aucune honnete.
  for (const absent of [undefined, null, '']) {
    assert.strictEqual(C().microToUsd(absent), null, `absent (${JSON.stringify(absent)}) doit dire « non lu », pas « 0 »`);
  }
  for (const illisible of ['abc', '-5', '4.5', '1e6', ' 12 ']) {
    assert.strictEqual(C().microToUsd(illisible), null, `illisible (${JSON.stringify(illisible)}) doit dire « non lu »`);
  }
});

t('LE CORRECTIF — un montant paye illisible ne devient JAMAIS le montant tape', () => {
  // Le commercant a tape 99,99: si le repli existait encore, c'est CE chiffre qui s'afficherait.
  C().setCents(9999);
  C().showPaid({ paid: true, tier: 'confirmed', paidMicro: 'abc' });
  const affiche = String(elements.get('paid-amount').textContent);
  assert.ok(!/\d/.test(affiche), `un montant non lu ne doit porter AUCUN chiffre, or on affiche « ${affiche} »`);
  assert.ok(!affiche.includes('99.99'), 'le montant DEMANDE ne doit jamais tenir lieu de montant PAYE');
  assert.strictEqual(affiche, C().ILLISIBLE, 'et la page doit dire laquelle des deux choses s est passee');
});

t('un montant paye ABSENT ne devient pas « 0.00 » non plus', () => {
  C().setCents(4500);
  C().showPaid({ paid: true, tier: 'confirmed' });          // pas de paidMicro du tout
  const affiche = String(elements.get('paid-amount').textContent);
  assert.ok(!/0\.00/.test(affiche), `un montant absent s affichait « 0.00 USDC » sous un PAYE — on lit « ${affiche} »`);
  assert.strictEqual(affiche, C().ILLISIBLE);
});

t('TEMOIN — un montant lisible s affiche normalement, et c est CELUI DE LA CHAINE', () => {
  C().setCents(100);                                        // le commercant avait tape 1,00
  C().showPaid({ paid: true, tier: 'final', paidMicro: '7250000' });  // la chaine dit 7,25 (surpaiement)
  const affiche = String(elements.get('paid-amount').textContent);
  assert.strictEqual(affiche, '7.25 USDC', 'le surpaiement est un cas NORMAL: on affiche ce qui a ete PAYE');
  assert.ok(!affiche.includes('1.00'), 'jamais le montant demande');
});

t('le RECU imprime la meme regle — non lu se dit, ne se fabrique pas', () => {
  C().setCents(9999);
  C().setLast({ paid: true, tier: 'confirmed', paidMicro: 'abc', txHash: '0x' + 'cd'.repeat(32) });
  const clic = (C().recu.handlers.click || [])[0];
  assert.ok(typeof clic === 'function', 'le bouton Recu n a pas de handler — la page a change de forme');
  cree.length = 0;
  clic({ target: null });
  const ov = cree[cree.length - 1];
  assert.ok(ov && ov.innerHTML, 'le recu n a rien rendu');
  assert.ok(ov.innerHTML.includes(C().ILLISIBLE), 'le recu doit dire que le montant n a pas ete lu');
  assert.ok(!ov.innerHTML.includes('99.99'), 'le recu ne doit JAMAIS imprimer le montant demande a la place du paye');
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
