#!/usr/bin/env node
// probe-densite-vs-compte.js — que vaudrait un seuil de DENSITE a 0,40 contre le seuil de COMPTE a 20 ?
// ================================================================================================
// Le 2026-08-06, `siblingTxScanned` a commence a etre persiste et la densite est devenue calculable:
// `siblingCount / siblingTxScanned`, c'est-a-dire destinataires distincts par transaction.
//
// ⚠️ L'IDENTITE QU'IL FAUT COMPRENDRE AVANT DE LIRE UN CHIFFRE. Une page d'explorateur vaut 50
// transactions. Sur le lecteur d'UNE page, un compte de 20 est donc une densite de 20/50 = 0,40. Le
// seuil « choisi a la main » de `funder-20` etait deja un seuil de densite — exprime dans les unites
// d'une page. Sur ces lignes-la, les deux regles sont LA MEME REGLE et les comparer ne dit rien.
// ⛔ Elles ne divergent que la ou le denominateur cesse de valoir 50: les lignes du lecteur PAGINE.
//
// ⚠️ OU LE CHIFFRAGE EST DONC POSSIBLE, ET C'EST LE SEUL ENDROIT: `data/token-radar/rewalk-safe-bucket.json`
// porte `siblingCount` ET `siblingTxScanned` pour 11 financeurs relus en profondeur, et ces financeurs
// portent des tokens dont l'issue est TRANCHEE. C'est la seule population ou densite et issue sont
// connues ensemble.
//
// ⛔ TROIS BORNES, a lire avant les nombres:
//   1. L'unite d'independance est le FINANCEUR, pas le token. Onze operateurs. Tout taux publie ici
//      porte ses deux effectifs.
//   2. La densite est lue DANS UN CACHE DATE, l'issue s'est jouee AVANT. L'historique d'un financeur
//      n'a pu que croitre, donc sa densite a pu bouger. Ce n'est pas une note vers l'avant.
//      ⚠️ CETTE BORNE DISAIT « lue AUJOURD'HUI » ET C'ETAIT FAUX. `rewalk-safe-bucket.json` n'est pas
//      recalcule a chaque passe: il est ecrit par `rewalk-safe-bucket-funders.js`, une sonde
//      forensique PONCTUELLE (aucune entree dans cron/jobs.json — verifie le 2026-08-15), et il ne
//      porte AUCUNE date interne. Mesure du 2026-08-15: le fichier datait du 2026-08-05, soit
//      231 h — 9,6 jours pendant lesquels, par la logique de cette borne meme, les historiques n'ont
//      pu que CROITRE sans que rien ici ne le compte. La phrase affirmait donc une fraicheur que son
//      entree n'avait plus, dans le sens rassurant. L'age du cache est desormais IMPRIME avec les
//      chiffres: la borne voyage avec la mesure, au lieu d'etre promise en en-tete.
//      ⛔ Un cache vieux n'est PAS une panne ici — la sonde est ponctuelle par dessein, et sa date EST
//      son sens. Ce qu'on refuse, c'est de lire ses nombres sans savoir de quand ils datent.
//
//      ⚖️ DECISION DE L'OPERATEUR, 2026-08-15 — ARBITREE, PAS SUBIE:
//        · la mesure du 2026-08-05 est CONSERVEE telle quelle, comme observation DATEE. On ne relance
//          pas `rewalk-safe-bucket-funders.js` pour la rafraichir: re-marcher les 11 financeurs
//          produirait d'autres nombres, et ce sont ceux du 5 aout qui ont servi a trancher la
//          contradiction que ce seau documente. Rafraichir effacerait la mesure au lieu de l'ajouter.
//        · cette sonde AVERTIT et ne BLOQUE PAS, quel que soit l'age du cache.
//      ⛔ NE PAS "durcir" en refus. Un forensicien doit pouvoir lire une mesure vieille EN SACHANT
//      qu'elle est vieille — c'est le but meme de l'affichage d'age ci-dessous. Un seuil qui ferait
//      sortir la sonde en erreur rendrait la donnee INACCESSIBLE au lieu de la rendre HONNETE, et
//      supprimerait la seule population ou densite et issue sont connues ensemble.
//   3. Ce seau a ete SELECTIONNE comme le cote SUR d'une regle. Le taux de base n'y est pas celui de
//      la base, et une precision mesuree ici ne se transporte pas ailleurs.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt } = require('../../lib/prequential');

const RACINE = path.join(__dirname, '..', '..', 'data', 'token-radar');
const rows = Object.entries(JSON.parse(fs.readFileSync(path.join(RACINE, 'tokens.json'), 'utf8')))
  .map(([addr, v]) => ({ addr, ...v }));
const CACHE_PATH = path.join(RACINE, 'rewalk-safe-bucket.json');
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
/* L'AGE DU CACHE, lu sur le fichier parce qu'il ne porte pas sa date DEDANS. Ce n'est pas un detail
 * d'affichage: toute la colonne `densite` en sort, et la borne 2 depend de sa fraicheur. `null` si le
 * mtime est illisible — on ne fabrique pas une date, on dit qu'on ne l'a pas. */
function ageCacheH() {
  try {
    const ms = fs.statSync(CACHE_PATH).mtimeMs;
    return { iso: new Date(ms).toISOString(), h: (Date.now() - ms) / 3600000 };
  } catch { return null; }
}

const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);

const SEUIL_COMPTE = 20;
const SEUIL_DENSITE = 0.40;      // = 20/50, l'identite ci-dessus

/* Les tokens du seau, ranges derriere le financeur dont la densite a ete relue. */
const parFinanceur = new Map();
for (const t of rows) {
  const k = String(t.funder || '').toLowerCase();
  if (cache[k]) { if (!parFinanceur.has(k)) parFinanceur.set(k, []); parFinanceur.get(k).push(t); }
}

console.log(`\n  ${parFinanceur.size} financeur(s) relus, adosses a `
  + `${[...parFinanceur.values()].reduce((s, g) => s + g.length, 0)} token(s)`);
/* LA BORNE VOYAGE AVEC LE CHIFFRE. Toute la colonne `densite` vient de ce cache; l'imprimer en tete
 * evite qu'un lecteur prenne des nombres de la semaine derniere pour l'etat d'aujourd'hui. */
const ac = ageCacheH();
if (!ac) {
  console.log('  ⚠️ densite lue dans rewalk-safe-bucket.json — DATE ILLISIBLE (mtime non lu):'
    + ' l anciennete de ces chiffres est INCONNUE, pas nulle.\n');
} else {
  console.log('  densite lue dans rewalk-safe-bucket.json, ecrit le ' + ac.iso
    + ' (' + ac.h.toFixed(1) + ' h)'
    + (ac.h > 48 ? '  ⚠️ les historiques n ont pu que CROITRE depuis, sans etre recomptes ici' : '') + '\n');
}
console.log('    financeur       compte  txScan  densite   COMPTE>=20   DENSITE>=0.40   tok   rug/res');
console.log('    ' + '-'.repeat(86));

let desaccords = 0;
const parRegle = { compte: { d: [], s: [] }, densite: { d: [], s: [] } };
for (const [f, toks] of [...parFinanceur.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const c = cache[f];
  const dens = (typeof c.siblingCount === 'number' && c.siblingTxScanned > 0)
    ? c.siblingCount / c.siblingTxScanned : null;
  const parCompte = c.siblingCount >= SEUIL_COMPTE;
  const parDensite = dens == null ? null : dens >= SEUIL_DENSITE;
  if (parDensite != null && parCompte !== parDensite) desaccords++;
  (parCompte ? parRegle.compte.d : parRegle.compte.s).push(...toks);
  if (parDensite != null) (parDensite ? parRegle.densite.d : parRegle.densite.s).push(...toks);
  const r = toks.filter((t) => issue(t) === 'rugged').length;
  const res = toks.filter((t) => issue(t) !== null).length;
  console.log('    ' + f.slice(0, 12) + '…  ' + String(c.siblingCount).padStart(6)
    + String(c.siblingTxScanned).padStart(8) + '   ' + (dens == null ? '  n/a' : dens.toFixed(3)).padStart(6)
    + '   ' + (parCompte ? 'DANGER' : 'sur   ').padStart(10)
    + '   ' + (parDensite == null ? 'n/a' : parDensite ? 'DANGER' : 'sur   ').padStart(13)
    + String(toks.length).padStart(6) + '   ' + r + '/' + res
    + (parDensite != null && parCompte !== parDensite ? '   <<< DESACCORD' : ''));
}

function taux(nom, g) {
  const r = g.filter((t) => issue(t) === 'rugged').length;
  const s = g.filter((t) => issue(t) === 'survived').length;
  const f = new Set(g.map((t) => String(t.funder).toLowerCase())).size;
  console.log('    ' + nom.padEnd(34) + String(g.length).padStart(4) + ' tok · ' + String(f).padStart(2) + ' fin · '
    + String(r).padStart(3) + ' rug · ' + String(s).padStart(3) + ' surv · '
    + (r + s ? (100 * r / (r + s)).toFixed(1).padStart(5) + ' %' : '  n/a'));
  return { n: g.length, f, r, res: r + s };
}

console.log('\n  ── ce que chaque regle appelle DANGER, et ce qui s y est passe ──\n');
const cd = taux('COMPTE >= 20  -> DANGER', parRegle.compte.d);
const cs = taux('COMPTE  < 20  -> sur', parRegle.compte.s);
console.log('');
const dd = taux('DENSITE >= 0.40 -> DANGER', parRegle.densite.d);
const ds = taux('DENSITE  < 0.40 -> sur', parRegle.densite.s);

console.log(`\n  financeurs sur lesquels les deux regles DIVERGENT : ${desaccords} sur ${parFinanceur.size}`);
console.log('  ⚠️ Comparer deux regles sur si peu d operateurs ne tranche rien: chaque financeur pese');
console.log('     ici comme UN tirage, quel que soit son nombre de tokens.');

/* ═══ ⛔ POURQUOI CE TABLEAU NE PEUT PAS REPONDRE A LA QUESTION QU'IL A L'AIR DE TRANCHER ═══
 *
 * La densite ne signale AUCUN financeur ici, et il serait tentant de conclure qu'elle est aveugle. Ce
 * serait lire un artefact de selection comme un resultat.
 *
 * Ce cache a ete construit en re-marchant le cote SUR de `simulation-et-financeur-lu`, dont la condition
 * est `siblingCount < 20` MESURE PAR LE LECTEUR D'UNE PAGE. Par l'identite 20/50, cette condition EST
 * « densite < 0,40 ». Chaque financeur present ici a donc ete choisi parce que sa densite etait basse.
 * Relire en profondeur a fait monter certains COMPTES au-dessus de 20 — c'est tout l'objet du re-marchage
 * — mais la densite, elle, ne pouvait pas monter: elle etait le critere d'entree.
 *
 * ⛔ UN TEST DE LA DENSITE SUR UN ECHANTILLON FILTRE PAR LA DENSITE NE TESTE RIEN. Ce n'est pas un
 * manque de donnees qu'une passe de plus comblerait: c'est une impossibilite de conception. La seule
 * population ou la densite est aujourd'hui mesurable est exactement celle ou elle ne peut pas
 * discriminer.
 *
 * ⚠️ CE QUI RENDRAIT LE CHIFFRAGE POSSIBLE, et rien d'autre: des lignes portant `siblingTxScanned`
 * ecrites par le radar sur une population NON selectionnee — c'est-a-dire les lignes neuves, une fois
 * leur fenetre de maturite fermee. Elles arrivent maintenant que le champ est persiste. */
console.log('\n  ⛔ ET CE TABLEAU NE TRANCHE PAS LA QUESTION QU IL A L AIR DE TRANCHER.');
console.log('     Ce cache vient du cote SUR d une regle dont la condition d entree etait `compte < 20`');
console.log('     SOUS LE LECTEUR D UNE PAGE — soit, par l identite 20/50, « densite < 0,40 ». Chaque');
console.log('     financeur ici a donc ete SELECTIONNE pour sa densite basse. Qu elle n en signale aucun');
console.log('     n est pas une mesure de son pouvoir: c est le critere d entree qui se regarde lui-meme.');
console.log('     Le chiffrage demande n a pas de reponse sur cette population, et aucune passe');
console.log('     supplementaire ne la donnera — il faut des lignes NON selectionnees.');

/* Le cas qui a motive la question, isole: un compte au-dessus du seuil ET une densite tres en dessous.
 * Il est visible dans les lignes NEUVES de la base, pas dans ce cache. */
const neufs = rows.filter((t) => t.siblingTxScanned > 0);
const divergents = neufs.filter((t) => (t.siblingCount >= SEUIL_COMPTE)
  !== (t.siblingCount / t.siblingTxScanned >= SEUIL_DENSITE));
console.log(`\n  ── dans les lignes NEUVES de la base (lecteur pagine) ──\n`);
console.log(`    ${neufs.length} ligne(s) portent une densite mesurable`);
console.log(`    dont ${divergents.length} ou COMPTE et DENSITE ne disent pas la meme chose :`);
for (const t of divergents) {
  console.log(`      compte=${t.siblingCount} txScanned=${t.siblingTxScanned} densite=`
    + (t.siblingCount / t.siblingTxScanned).toFixed(3)
    + `  -> compte dit ${t.siblingCount >= SEUIL_COMPTE ? 'DANGER' : 'sur'}, densite dit `
    + (t.siblingCount / t.siblingTxScanned >= SEUIL_DENSITE ? 'DANGER' : 'sur')
    + `  · issue: ${issue(t) || 'NON TRANCHEE'}`);
}
console.log('\n  ⛔ Une issue NON TRANCHEE ne vaut rien, dans aucun sens. Ces lignes sont nees a la passe');
console.log('     de 17:02 et leur fenetre de maturite ne se ferme pas avant plusieurs heures. Le');
console.log('     chiffrage demande devient possible a ce moment-la, pas avant.\n');
