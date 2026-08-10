#!/usr/bin/env node
'use strict';
/**
 * probe-actif-tient-il-encore.js
 * ================================================================================================
 * L'ACTIF QUE LE PRODUIT VEND TIENT-IL ENCORE, SUR LA POPULATION D'AUJOURD'HUI ?
 *
 * L'affirmation historique — « financeur industriel: >= 20 wallets frere, 83 % de rugs sur 48
 * financeurs » — a ete etablie sur une population bien plus petite. Un chiffre voisin, la « bande verte
 * a 6 % », NE S'EST DEJA PAS TRANSPORTE: rejeu sur 1859 tokens -> 64,4 %. Rien ne garantit que celui-ci
 * survive mieux, et le republier sans le remesurer serait exactement ce que la regle anti-hype interdit.
 *
 * CE QUE CETTE SONDE FAIT:
 *   · resout les issues avec le helper CANONIQUE `outcomeKnownAt` + la fenetre `maturityWindow`
 *     — jamais une re-derivation maison de « rugged/live », qui compterait les non-resolus comme vivants;
 *   · rend le taux dans LES DEUX unites, parce que le signe est connu pour S'INVERSER entre elles;
 *   · applique le plancher de 20 tirages: sous ce seuil le TAUX est RETENU, seul le compte est lisible;
 *   · verifie que `siblingCount` est STABLE par financeur — s'il varie, l'appartenance a la bande
 *     depend de l'instant de mesure et toute comparaison historique est douteuse.
 *
 * ⚠️ BORNES: population d'observation de CE noeud, pas un echantillon aleatoire de Base. `ruggedAt` est
 * une DETECTION, pas une mort. ⛔ Aucune adresse n'est imprimee.
 */
const fs = require('node:fs');
const path = require('node:path');
const { outcomeKnownAt, maturityWindow, MIN_RESOLUS } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
let brut;
try { brut = JSON.parse(fs.readFileSync(DB, 'utf8')); }
catch (e) { console.log('base ILLISIBLE (' + ((e && e.message) || e) + ') — aucun chiffre'); process.exitCode = 1; return; }

const lignes = Object.values(brut).filter((t) => Number.isFinite(Date.parse(t.firstSeen)));
const T = Date.now();
const f = maturityWindow(lignes);

console.log('== l actif tient-il encore ? ==');
console.log('   lignes datables        ' + lignes.length);
console.log('   fenetre de maturite    ' + (f.maturityH == null ? 'INDISPONIBLE' : f.maturityH + ' h (p95 des rugs observes)'));

/* ── 1. RESOUDRE avec le helper canonique, jamais a la main ───────────────────────────────────────── */
const resolus = [];
let ouverts = 0;
for (const t of lignes) {
  const k = outcomeKnownAt(t, T, f.maturityH);
  if (!k) { ouverts++; continue; }
  resolus.push({ t, rugged: k === 'rugged' });
}
const baseRugges = resolus.filter((r) => r.rugged).length;
console.log('   RESOLUS                ' + resolus.length + '   (ouverts, exclus: ' + ouverts + ')');
console.log('   taux de BASE           ' + (100 * baseRugges / resolus.length).toFixed(1) + ' pct');

/* ── 2. `siblingCount` EST-IL STABLE PAR FINANCEUR ? ──────────────────────────────────────────────── */
const parFinanceur = new Map();
let sansFinanceur = 0;
for (const r of resolus) {
  const fd = typeof r.t.funder === 'string' && r.t.funder ? r.t.funder.toLowerCase() : null;
  if (!fd) { sansFinanceur++; continue; }
  if (!parFinanceur.has(fd)) parFinanceur.set(fd, { tokens: 0, rugges: 0, freres: new Set() });
  const e = parFinanceur.get(fd);
  e.tokens++; if (r.rugged) e.rugges++;
  if (typeof r.t.siblingCount === 'number') e.freres.add(r.t.siblingCount);
}
let instables = 0;
for (const e of parFinanceur.values()) if (e.freres.size > 1) instables++;
console.log('');
console.log('-- l appartenance a la bande est-elle STABLE ? --');
console.log('   financeurs resolus     ' + parFinanceur.size + '   (tokens sans financeur trace: ' + sansFinanceur + ')');
console.log('   financeurs dont `siblingCount` VARIE selon le token: ' + instables
  + ' (' + (100 * instables / parFinanceur.size).toFixed(1) + ' pct)');
if (instables > 0) {
  console.log('   ⚠️ pour ceux-la, appartenir a la bande >= 20 DEPEND de l instant de mesure — donc toute');
  console.log('      comparaison a un chiffre historique porte cette incertitude, en plus du bruit.');
}

/* ── 3. LA BANDE, DANS LES DEUX UNITES ────────────────────────────────────────────────────────────── */
const SEUIL = 20;
const bande = { dedans: [], dehors: [] };
for (const e of parFinanceur.values()) {
  const max = e.freres.size ? Math.max(...e.freres) : null;
  if (max === null) continue;                 // financeur sans compte de freres: ni dedans ni dehors
  (max >= SEUIL ? bande.dedans : bande.dehors).push(e);
}

function rapport(nom, groupe) {
  const nF = groupe.length;
  const nT = groupe.reduce((s, e) => s + e.tokens, 0);
  const rT = groupe.reduce((s, e) => s + e.rugges, 0);
  /* ⛔ DEUX UNITES, PARCE QUE LE SIGNE S'INVERSE ENTRE ELLES. Par TOKEN: chaque token compte une fois.
   * Par FINANCEUR: chaque operateur compte une fois, quel que soit son nombre de tokens. */
  const parToken = nT ? (100 * rT / nT) : null;
  const parFin = nF ? (100 * groupe.reduce((s, e) => s + (e.rugges / e.tokens), 0) / nF) : null;
  console.log('   ' + nom.padEnd(22) + ' financeurs=' + String(nF).padStart(4)
    + '  tokens=' + String(nT).padStart(5));
  /* ⛔ LE PLANCHER S'APPLIQUE A L'UNITE D'INDEPENDANCE: sous MIN_RESOLUS financeurs, le taux est RETENU. */
  console.log('     par TOKEN     ' + (parToken === null ? 'n/d' : parToken.toFixed(1) + ' pct'));
  console.log('     par FINANCEUR ' + (nF < MIN_RESOLUS
    ? 'RETENU (' + nF + ' financeurs < ' + MIN_RESOLUS + ' — le compte reste lisible, pas le taux)'
    : parFin.toFixed(1) + ' pct'));
  return { nF, nT, parToken, parFin };
}

console.log('');
console.log('-- la bande « financeur industriel » (>= ' + SEUIL + ' freres) --');
const dedans = rapport('DANS la bande', bande.dedans);
const dehors = rapport('HORS la bande', bande.dehors);

/* ── 4. L'ECART, AVEC SON PLAFOND ─────────────────────────────────────────────────────────────────── */
const baseTx = 100 * baseRugges / resolus.length;
console.log('');
console.log('-- l ecart, et ce que la population PERMET d atteindre --');
console.log('   taux de BASE           ' + baseTx.toFixed(1) + ' pct');
/* ⛔ DEUX ECARTS DIFFERENTS, ET UN SEUL A CE PLAFOND. Un premier jet imprimait `dedans - dehors` (39,6)
 * a cote d un plafond calcule comme `100 - base` (16,2) — un ecart NE PEUT PAS depasser son plafond, et
 * l incoherence a revele que je comparais deux quantites distinctes:
 *   · `dedans - BASE` mesure « la regle bat-elle le hasard sur cette population » — plafonne a 100-base;
 *   · `dedans - dehors` mesure « les deux groupes different-ils » — pas la meme question, pas ce plafond.
 * Les deux sont utiles; les confondre transforme un ecart ordinaire en exploit. */
if (dedans.parToken !== null) {
  console.log('   par TOKEN, dedans - BASE     ' + (dedans.parToken - baseTx).toFixed(1)
    + ' pts   (plafond ' + (100 - baseTx).toFixed(1) + ' — la precision ne depasse pas 100 pct)');
}
if (dedans.parToken !== null && dehors.parToken !== null) {
  console.log('   par TOKEN, dedans - dehors   ' + (dedans.parToken - dehors.parToken).toFixed(1)
    + ' pts   (autre question: separation entre groupes, sans ce plafond)');
}
if (dedans.nF >= MIN_RESOLUS && dehors.nF >= MIN_RESOLUS) {
  console.log('   par FINANCEUR, dedans - dehors ' + (dedans.parFin - dehors.parFin).toFixed(1) + ' pts');
} else {
  console.log('   par FINANCEUR                RETENU (un des deux groupes est sous le plancher de '
    + MIN_RESOLUS + ')');
}

/* ── 5. COMPARER DES OPERATEURS COMPARABLES ───────────────────────────────────────────────────────── */
/* ⛔ LE COMPLEMENT EST DOMINE PAR DES SINGLETONS, et sur un financeur a UN token la « moyenne par
 * financeur » n est rien d autre que l issue de ce token. Comparer un groupe d operateurs industriels a
 * un nuage de deploiements uniques n oppose pas deux politiques, ca oppose deux natures d objets. */
const tokensParFin = (g) => g.map((e) => e.tokens).sort((a, b) => a - b);
const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
console.log('');
console.log('-- des OPERATEURS COMPARABLES ? --');
console.log('   tokens par financeur, mediane : dedans=' + med(tokensParFin(bande.dedans))
  + '  dehors=' + med(tokensParFin(bande.dehors)));
const dehorsGros = bande.dehors.filter((e) => e.tokens >= 3);
const gardee = bande.dehors.length ? (100 * dehorsGros.length / bande.dehors.length) : 0;
console.log('   complement restreint aux financeurs portant >= 3 tokens :');
console.log('     financeurs conserves  ' + dehorsGros.length + ' / ' + bande.dehors.length
  + '  (' + gardee.toFixed(1) + ' pct conserves)');
/* ⛔ RETIRER DES LIGNES ELARGIT LES INTERVALLES: la fraction CONSERVEE voyage avec le chiffre, sinon
 * « l effet disparait apres restriction » se confond avec « il ne reste plus assez de monde ». */
if (dehorsGros.length >= MIN_RESOLUS) {
  const nT = dehorsGros.reduce((s, e) => s + e.tokens, 0);
  const rT = dehorsGros.reduce((s, e) => s + e.rugges, 0);
  const parFin = 100 * dehorsGros.reduce((s, e) => s + (e.rugges / e.tokens), 0) / dehorsGros.length;
  console.log('     par TOKEN     ' + (100 * rT / nT).toFixed(1) + ' pct  (' + nT + ' tokens)');
  console.log('     par FINANCEUR ' + parFin.toFixed(1) + ' pct');
  console.log('   ⚠️ le cote DEDANS reste sous le plancher (' + dedans.nF + ' financeurs), donc l ecart');
  console.log('      par financeur reste NON PUBLIABLE meme apres restriction.');
} else {
  console.log('     par FINANCEUR RETENU — ' + dehorsGros.length + ' financeurs < ' + MIN_RESOLUS);
}

console.log('');
console.log('-- confrontation a l affirmation historique --');
console.log('   annonce                « >= 20 freres -> 83 pct de rugs, sur 48 financeurs »');
console.log('   mesure aujourd hui     ' + (dedans.nF >= MIN_RESOLUS
  ? dedans.parFin.toFixed(1) + ' pct par financeur, sur ' + dedans.nF + ' financeurs'
  : 'RETENU — ' + dedans.nF + ' financeurs seulement'));
console.log('   ⚠️ population d observation de CE noeud, pas un echantillon aleatoire de Base.');
console.log('   ⚠️ `ruggedAt` est une DETECTION, pas une mort.');
