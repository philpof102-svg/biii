#!/usr/bin/env node
'use strict';
/**
 * probe-couverture-refaisable.js
 * ================================================================================================
 * LA COUVERTURE DU RADAR, RECALCULEE — PARCE QUE LE CHIFFRE PUBLIE ETAIT UN LITTERAL GELE.
 *
 * « 68,9 % de couverture, 101,2 h aveugles sur 325,5 h » est cite dans DEUX fichiers
 * (`lib/server.js`, `lib/radar-tick.js`) et RECALCULE dans AUCUN. Un nombre qu'on ne sait plus refaire
 * n'est plus une mesure: c'est une citation.
 *
 * ⛔ ET LES DEUX CITATIONS SE CONTREDISAIENT DEJA. `radar-tick.js` disait « huit trous », `server.js`
 * « quatre trous » — memes heures, meme pourcentage. La source (`blackouts.json`) en compte HUIT.
 * ⚠️ Une copie PARTIELLEMENT a jour est plus trompeuse qu'une copie franchement perimee: les deux
 * chiffres qui coincidaient donnaient l'impression d'une concordance, et seul le compte de trous
 * trahissait la derive.
 *
 * MESURE DU 2026-08-11: fenetre 393,5 h (contre 325,5 citees), 101,2 h aveugles inchangees, 8 trous,
 * COUVERTURE 74,3 %. Le chiffre publie etait donc PESSIMISTE — on se sous-vendait — parce que 38 h se
 * sont ecoulees sans nouveau trou et que le denominateur a grandi.
 *
 * ⚠️ BORNES:
 *   · la fenetre est bornee par les OBSERVATIONS (premiere `firstSeen` -> derniere `lastSeen`), pas par
 *     une horloge murale: un radar arrete depuis trois jours ne se penaliserait pas tout seul ici;
 *   · `blackouts.json` n'enregistre que les silences de plus de 2 h (`watch-gap.js`), donc la couverture
 *     rendue est une BORNE SUPERIEURE — les micro-trous n'y sont pas;
 *   · un fichier de trous ILLISIBLE n'est pas un fichier VIDE, et les deux ne se lisent pas pareil.
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'data', 'token-radar');
const H = 3600000;

function lire(p, quoi) {
  if (!fs.existsSync(p)) return { etat: 'absent', detail: quoi + ' introuvable: ' + p };
  try { return { etat: 'ok', data: JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { etat: 'illisible', detail: quoi + ' illisible: ' + ((e && e.message) || e) }; }
}

const tk = lire(path.join(DIR, 'tokens.json'), 'la base d observations');
const bl = lire(path.join(DIR, 'blackouts.json'), 'le journal des trous');

console.log('== la couverture du radar, RECALCULEE ==');
/* ⛔ TROIS ETATS, et deux d'entre eux ne sont PAS un zero: un fichier illisible ne se lit pas comme un
 * fichier vide, et l'absence de trous enregistres ne prouve pas l'absence de trous. */
if (tk.etat !== 'ok') { console.log('   ⛔ ' + tk.detail + ' — aucun chiffre ne peut etre rendu'); process.exitCode = 1; return; }
if (bl.etat === 'illisible') { console.log('   ⛔ ' + bl.detail + ' — ce n est PAS « zero trou »'); process.exitCode = 1; return; }

const vus = [];
for (const t of Object.values(tk.data)) {
  const a = Date.parse(t.firstSeen), b = Date.parse(t.lastSeen);
  if (Number.isFinite(a)) vus.push(a);
  if (Number.isFinite(b)) vus.push(b);
}
if (vus.length < 2) { console.log('   ⛔ moins de deux observations datables — pas de fenetre'); process.exitCode = 1; return; }
vus.sort((a, b) => a - b);
const t0 = vus[0], t1 = vus[vus.length - 1];
const fenetre = (t1 - t0) / H;

const trous = bl.etat === 'absent' ? [] : (Array.isArray(bl.data) ? bl.data : (bl.data.blackouts || []));
const heures = trous.map((x) => Number(x.hours)).filter(Number.isFinite);
const aveugle = heures.reduce((s, x) => s + x, 0);

console.log('   premiere observation   ' + new Date(t0).toISOString());
console.log('   derniere observation   ' + new Date(t1).toISOString());
console.log('   FENETRE                ' + fenetre.toFixed(1) + ' h');
console.log('   journal des trous      ' + (bl.etat === 'absent'
  ? 'ABSENT — ⚠️ ce n est pas « zero trou », c est « on ne sait pas »'
  : trous.length + ' trous, ' + aveugle.toFixed(1) + ' h aveugles'));
if (bl.etat === 'absent') { process.exitCode = 1; return; }

const couverture = 100 * (1 - aveugle / fenetre);
const tri = heures.slice().sort((a, b) => a - b);
console.log('   median d un trou       ' + (tri.length ? tri[Math.floor(tri.length / 2)].toFixed(1) + ' h' : 'n/d'));
console.log('');
console.log('   💎 COUVERTURE          ' + couverture.toFixed(1) + ' pct');
console.log('   ⚠️ BORNE SUPERIEURE: `watch-gap.js` n enregistre qu au-dela de 2 h de silence, donc les');
console.log('      micro-trous ne sont pas comptes. La vraie couverture est <= ce chiffre.');

/* ── LE CHIFFRE CITE DANS LE CODE, CONFRONTE ──────────────────────────────────────────────────────── */
const CITE = { couverture: 68.9, aveugle: 101.2, fenetre: 325.5 };
console.log('');
console.log('-- confrontation au chiffre CITE dans le code --');
console.log('   cite       ' + CITE.couverture + ' pct   (' + CITE.aveugle + ' h sur ' + CITE.fenetre + ' h)');
console.log('   mesure     ' + couverture.toFixed(1) + ' pct   (' + aveugle.toFixed(1) + ' h sur ' + fenetre.toFixed(1) + ' h)');
const ecart = couverture - CITE.couverture;
console.log('   ecart      ' + (ecart >= 0 ? '+' : '') + ecart.toFixed(1) + ' pts   '
  + (ecart > 0 ? '(le chiffre publie est PESSIMISTE — on se sous-vend)'
    : ecart < 0 ? '⛔ (le chiffre publie est OPTIMISTE — on sur-vend)' : '(identique)'));
console.log('');
console.log('   🔑 Cette sonde existe pour que le chiffre soit REFAIT plutot que CITE.');
console.log('      Le relancer avant toute publication: `node hermes/economy/probe-couverture-refaisable.js`');

/* ── DEPUIS QUAND SANS TROU ? ─────────────────────────────────────────────────────────────────────── */
const fins = trous.map((x) => Date.parse(x.to)).filter(Number.isFinite);
if (fins.length) {
  const dernier = Math.max(...fins);
  console.log('');
  console.log('   dernier trou enregistre ' + new Date(dernier).toISOString());
  console.log('   soit ' + ((t1 - dernier) / H).toFixed(1) + ' h d observation sans trou enregistre');
  console.log('   ⚠️ « aucun trou enregistre » a TROIS lectures: aucun silence > 2 h · le detecteur n a');
  console.log('      pas tourne · il n a pas su ecrire. Verifier le mtime du journal avant de conclure.');
}
