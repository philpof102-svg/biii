'use strict';
/**
 * LA PAGE QUI DECIDE A QUI ON PAIE NE PEINT PAS EN VERT CE QU'ELLE N'A PAS CRIBLE.
 * Run: node test/p2p-unscreened-is-not-green.test.js
 *
 * 🔁 TROISIEME SURFACE DU MEME DEFAUT. `test/two-lens.test.js` l'a corrige sur le handler MCP
 * `till_trust`; `test/non-address-is-not-green.test.js` (11/08) l'a corrige sur `vetLocal` /
 * `localClassify`, avec cette phrase: « le module divulgue, l'appelant ignore la divulgation POUR LA
 * DECISION ». Aucun des deux n'a atteint `web/p2p.html` — la page P2P servie par le noeud, celle ou
 * deux personnes se scannent et se paient de wallet a wallet.
 *
 * ⚠️ MESURE DU 2026-08-15, ET POURQUOI LE CORRECTIF NE POUVAIT PAS Y ARRIVER TOUT SEUL.
 * `lib/screen.js` rend TROIS etats et le dit dans son en-tete: « it MUST NEVER report an address as
 * clean when it [cannot screen] ». `vetLocal` s'en sert pour ecrire sa `disclosure`… et ne transmettait
 * que `{ blocked, reason }`. `available` restait dans la fonction. Un consommateur ne pouvait donc PAS
 * distinguer « crible, rien trouve » de « jamais crible »: les deux arrivent en `blocked:false`, et la
 * seule difference vivait dans une PHRASE ANGLAISE.
 *
 * La page faisait alors la seule chose qu'elle pouvait faire, et c'etait faux:
 *
 *     var badge = vet ? "<div style='color:var(--green)'>✓ pas known-bad — " + esc(vet.disclosure.slice(0,80))
 *
 * Tout verdict non nul devenait un ✓ VERT — y compris quand la disclosure disait « NOT SCREENED — …
 * the known-bad floor was never consulted for it » ou « SCREENING UNAVAILABLE — no known-bad floor is
 * loaded on this node ». Et la troncature a 80 caracteres coupe EXACTEMENT la ou commence « This is
 * NOT a clean verdict ». Le resume, lui, concluait « Validé — destinataire vérifié. ».
 *
 * ⛔ BORNE — CE TEST NE TRANCHE PAS LA SEMANTIQUE PRODUIT. Faut-il RETIRER le bouton de paiement quand
 * notre crible est indisponible ? C'est un arbitrage (bloquer un paiement P2P parce que NOTRE service
 * est en panne), il n'est pas pris ici et le bouton reste affiche. Ce test exige seulement que la page
 * n'AFFIRME pas une verification qui n'a pas eu lieu. On retire l'affirmation, on garde la decision.
 *
 * ⚖️ AUTRE BORNE: le bloc <script> de la page publiee est evalue dans un bac a sable. Ce fichier prouve
 * ce que la page DECIDE et la CHAINE qu'elle produit — il ne lance aucun navigateur. Aucun reseau.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { vetLocal, loadFloor } = require('../lib/vet');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n         ' + (e && e.message)); } };

console.log('p2p — ce qui n a pas ete crible ne ressort pas vert:');

const ADRESSE = '0x' + '11'.repeat(20);
const floor = loadFloor();

// ── 1) LE SERVEUR DOIT DONNER DE QUOI BRANCHER ──────────────────────────────────────────────────

t('★ TEMOIN — une adresse valide criblee porte available:true', () => {
  const r = vetLocal(ADRESSE, { knownBad: floor });
  assert.equal(r.screen.available, true, 'le crible a tourne sur cette entree, il doit le dire');
  assert.equal(r.screen.blocked, false, 'et cette adresse temoin n est pas known-bad');
});

t('★ une NON-ADRESSE porte available:false — pas seulement une phrase', () => {
  for (const v of ['alice.base.eth', 'pas-une-adresse', '', '0x1234']) {
    const r = vetLocal(v, { knownBad: floor });
    assert.equal(r.screen.available, false,
      JSON.stringify(v) + ' : « pas crible » doit etre un CHAMP, lisible sans parser l anglais');
    assert.equal(r.screen.blocked, false, JSON.stringify(v) + ' : et ce n est pas une accusation non plus');
  }
});

t('★ blocked:false ne suffit PAS a distinguer les deux cas — c est tout le probleme', () => {
  const propre = vetLocal(ADRESSE, { knownBad: floor });
  const jamais = vetLocal('alice.base.eth', { knownBad: floor });
  assert.equal(propre.screen.blocked, jamais.screen.blocked,
    'les deux arrivent bien en blocked:false — c est pourquoi available doit voyager');
  assert.notEqual(propre.screen.available, jamais.screen.available,
    'et available doit etre CE QUI LES SEPARE');
});

// ── 2) LA PAGE DOIT BRANCHER DESSUS ─────────────────────────────────────────────────────────────

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'p2p.html'), 'utf8');
const bloc = (HTML.match(/<script>\s*\(function\(\)\{([\s\S]*?)\n\}\)\(\);\s*<\/script>/) || [])[0];

const ecrits = new Map();
const mkEl = (id) => ({ id, textContent: '', innerHTML: '', style: {}, srcObject: null,
  addEventListener() {}, play() {}, getTracks: () => [], appendChild() {}, focus() {} });
const sandbox = {
  document: { getElementById: (id) => { if (!ecrits.has(id)) ecrits.set(id, mkEl(id)); return ecrits.get(id); },
    querySelector: () => mkEl('?'), createElement: () => mkEl('?'), addEventListener() {}, body: { appendChild() {} } },
  window: { addEventListener() {} }, navigator: {}, location: { search: '' },
  fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout: () => {},
  setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, prompt: () => null,
  console: { log() {}, error() {} }, qrcode: () => ({ addData() {}, make() {}, createImgTag: () => '<img>' }),
  Date, Math, JSON, String, Number, Boolean, Array, Object, RegExp, Error, Promise, encodeURIComponent,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

t('le bloc de la page P2P publiee est bien lu', () => {
  assert.ok(bloc && bloc.length > 1500, 'succes vide: le <script> de p2p.html n a pas ete lu');
  assert.ok(/\brenderPay\b/.test(bloc), 'renderPay introuvable — la page a change de forme');
  const fin = bloc.lastIndexOf('})();');
  assert.notEqual(fin, -1, 'fermeture de l IIFE introuvable');
  const instrumente = (bloc.slice(0, fin) + '\n;globalThis.__p = { renderPay: renderPay };\n' + bloc.slice(fin))
    .replace(/^<script>/, '').replace(/<\/script>$/, '');
  vm.runInContext(instrumente, sandbox);
  assert.equal(typeof sandbox.__p.renderPay, 'function');
});

const rendu = (vet) => {
  ecrits.clear();
  sandbox.__p.renderPay({ to: ADRESSE, valid: true }, '4500000', '4.50', vet);
  return { carte: String(ecrits.get('pay-card').innerHTML), statut: String(ecrits.get('scan-status').textContent) };
};
/* ⚠️ LA FIXTURE A ETE CHOISIE APRES MESURE, ET MON PREMIER CHOIX ETAIT FAUX.
 * J'avais pris `vetLocal('alice.base.eth')`. Mesure: dans cet etat `classifier.allowed === false`
 * (c'est le correctif du 11/08), donc `p2p.html` prend sa branche BLOQUANTE et affiche deja
 * « 🚫 NE PAYEZ PAS » sans bouton. Mon test aurait donc prouve la mauvaise chose, sur un chemin qui
 * n'atteint jamais le badge. La page est SAINE sur ce cas et ce fichier l'asserte comme temoin.
 *
 * L'etat reellement atteignable est le NOEUD LEAN: `localClassify` fait `if (!tc) return null`
 * (lib/vet.js:67), et `vet.js` qualifie lui-meme cet etat de « normal lean deployment, not a fault ».
 * La page lit alors `cls = (vet && vet.classifier) || {}` ⇒ `{}` ⇒ `cls.allowed === false` vaut FAUX
 * ⇒ la garde ne se declenche pas. Ajoute a un floor jamais ingere, c'est le profil d'un noeud
 * fraichement deploye, et la page y peignait « ✓ pas known-bad » EN VERT par-dessus une divulgation
 * qui dit « SCREENING UNAVAILABLE », coupee a 80 caracteres sur « This is NOT a » — un mot avant que
 * la negation soit complete.
 *
 * ⚖️ CAVEAT DE FIXTURE: on force `tc:null` pour reproduire la FORME. Un vrai noeud lean y arrive par
 * `TC_STATE` et porterait alors `classifierSource:'absent'`. C'est la meme forme cote consommateur —
 * `classifier: null` — qui est tout ce que la page voit. */
const VIDE = { set: new Set(), count: 0, available: false, asOf: null, sources: [] };
const VET_CRIBLE = vetLocal(ADRESSE, { knownBad: floor });
const VET_NON_CRIBLE = vetLocal(ADRESSE, { knownBad: VIDE, tc: null });   // noeud lean, floor jamais ingere
const VET_NON_ADRESSE = vetLocal('alice.base.eth', { knownBad: floor });  // deja bloque depuis le 11/08

t('★ LE CORRECTIF — un verdict NON CRIBLE ne recoit ni le vert ni le « ✓ pas known-bad »', () => {
  const r = rendu(VET_NON_CRIBLE);
  assert.ok(!/var\(--green\)/.test(r.carte), 'la page peignait ce cas en VERT');
  assert.ok(!/✓ pas known-bad/.test(r.carte), 'et affirmait « pas known-bad » sans avoir rien crible');
  assert.ok(/NON CRIBL/i.test(r.carte), 'elle doit dire que rien n a ete crible');
});

/* ⚠️ CETTE ASSERTION A DEJA ETE FAUSSE DANS LES DEUX SENS, en une seule ecriture.
 * Premier jet: `!/vérifié/i.test(statut)`. (a) Elle PASSAIT sur la mauvaise fixture parce que le
 * statut valait « Bloqué par BIII. » — vert pour une raison qui n'etait pas la bonne. (b) Elle
 * ROUGISSAIT sur la phrase CORRIGEE, « rien n'a été vérifié », qui contient le mot tout en le niant.
 * 💎 Interdire une CHAINE ne distingue pas AFFIRMER de NIER. On asserte donc l'absence de la
 * REVENDICATION (« Validé »), et la presence de son contraire explicite. */
t('★ et le RESUME ne contredit pas le badge', () => {
  const r = rendu(VET_NON_CRIBLE);
  assert.ok(!/\bValidé\b/.test(r.statut),
    'le resume disait « Validé — destinataire vérifié. » alors que rien ne l avait ete: ' + JSON.stringify(r.statut));
  assert.ok(/NON cribl/i.test(r.statut), 'et il doit dire explicitement ce qui n a pas eu lieu');
});

t('★ TEMOIN — une NON-ADRESSE reste bloquee (le correctif du 11/08 tient toujours)', () => {
  const r = rendu(VET_NON_ADRESSE);
  assert.ok(/NE PAYEZ PAS/.test(r.carte), 'localClassify rend allowed:false ici, et la page doit bloquer');
  assert.ok(!/Ouvrir mon wallet/.test(r.carte), 'aucun bouton de paiement sur une entree incriblable');
});

t('★ la divulgation n est plus coupee la ou commence l avertissement', () => {
  const r = rendu(VET_NON_CRIBLE);
  const phrase = String(VET_NON_CRIBLE.disclosure || '');
  assert.ok(phrase.length > 80, 'temoin: la phrase du serveur depasse bien l ancienne troncature');
  assert.ok(/NOT a clean verdict/i.test(phrase), 'temoin: c est bien la partie qui etait coupee');
  assert.ok(r.carte.includes('NOT a clean verdict'),
    'la page doit montrer l avertissement, pas les 80 premiers caracteres qui s arretent avant');
});

t('★ TEMOIN — un verdict CRIBLE et propre garde son vert (le correctif n avale rien)', () => {
  const r = rendu(VET_CRIBLE);
  assert.ok(/var\(--green\)/.test(r.carte), 'une adresse reellement criblee doit rester verte');
  assert.ok(/✓ pas known-bad/.test(r.carte), 'et garder son affirmation, qui est vraie ici');
  assert.ok(/cribl/i.test(r.statut), 'le resume doit dire que le crible a bien tourne');
});

t('★ TEMOIN — un known-bad reste BLOQUE, sans bouton de paiement', () => {
  const bloque = { screen: { blocked: true, available: true, reason: 'on the local known-bad floor' },
    classifier: { allowed: false, explainer: 'adresse sur la denylist' }, disclosure: 'BLOCKED on this node' };
  const r = rendu(bloque);
  assert.ok(/NE PAYEZ PAS/.test(r.carte), 'le blocage decisif doit rester decisif');
  assert.ok(!/Ouvrir mon wallet/.test(r.carte), 'et aucun bouton de paiement ne doit etre offert');
});

t('★ verdict ABSENT (le /trust a echoue) — toujours pas de vert, toujours pas de « Validé »', () => {
  const r = rendu(null);
  assert.ok(!/var\(--green\)/.test(r.carte), 'un verdict absent ne peut pas etre vert');
  assert.ok(!/\bValidé\b/.test(r.statut), 'ni annonce comme valide');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
