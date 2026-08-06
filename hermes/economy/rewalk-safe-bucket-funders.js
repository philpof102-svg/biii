#!/usr/bin/env node
// rewalk-safe-bucket-funders.js — re-compter les financeurs du seau SUR avec le lecteur PAGINE.
// ================================================================================================
// probe-safe-bucket-contamine.js a montre que 101 des 104 tokens du seau SUR de
// `simulation-et-financeur-lu` portent un `siblingCount` CENSURE: un plancher lu sur une seule page,
// alors que le compte porte sur les destinataires DISTINCTS. Deux mesures se contredisent alors:
//
//   · la projection : 9330a3b a re-marche 42 financeurs et 4 des 7 enregistres sous 20 franchissent
//                     le seuil une fois lus. Transposee, ~58 des 101 seraient industriels, et au taux
//                     industriel de 93,4 % cela ferait ~54 rugs.
//   · l'observation : UN rug. Mesure aussi, sur la meme population.
//
// Les deux sont vraies et ne peuvent pas decrire la meme population. Ce script tranche en LISANT,
// au lieu de choisir laquelle des deux croire.
//
// ═══ POURQUOI ON RE-MARCHE 11 FINANCEURS ET NON 101 TOKENS, ET POURQUOI CE N'EST PAS UN ECHANTILLON ═══
// `siblingCount` est une propriete du FINANCEUR — le nombre de destinataires distincts de SON historique
// sortant. Deux tokens qui partagent un financeur partagent donc le compte, par construction et non par
// approximation. Les 101 tokens se rangent derriere 11 financeurs distincts, dont trois portent 93.
// Les re-marcher tous les 11 est un recensement COMPLET du seau; le faire token par token paierait
// 101 fois les 3 appels fixes de traceFeeder pour re-deriver une reponse qui ne varie que par financeur.
//
// ⚠️ ET C'EST DEJA LE RESULTAT PRINCIPAL, AVANT LE PREMIER APPEL. La projection « ~58 industriels sur
// 101 » traite le seau comme 101 tirages independants. Il n'y en a que 11, et le taux de transposition
// (« 4 des 7 franchissent ») a ete mesure PAR FINANCEUR. L'observation souffre du meme defaut: « 1 rug
// sur 101 » est 1 rug sur ~11 grappes. Les deux moities de la contradiction ont gonfle N en comptant
// des tokens la ou l'unite d'independance est le financeur.
//
// ⚠️ CE QUE CETTE LECTURE NE PEUT PAS DIRE, et il faut le lire AVANT les chiffres:
//   1. On lit le financeur AUJOURD'HUI, pas au premier regard. Son historique n'a pu que CROITRE depuis.
//      Le biais est donc asymetrique et il joue contre nous: il produit des franchissements en trop,
//      jamais en moins. Un financeur qui ressort sous le seuil l'etait donc aussi a l'epoque.
//   2. Six pages restent une borne. Un compte < 20 rendu avec `stoppedBy: 'page_cap'` est ENCORE un
//      plancher — il obtient sa propre categorie et n'est jamais compte comme « vraiment sous 20 ».
//   3. Le financeur enregistre est celui que la trace avait nomme; si la page des entrants du deployeur
//      etait elle-meme incomplete, ce n'est pas prouvablement le premier payeur. On re-marche donc
//      exactement l'adresse sur laquelle le compte conteste a ete mesure — la comparaison reste
//      appariee — et un financeur qui se resout differemment aujourd'hui est SIGNALE, jamais substitue.
//
// Lecture SEULE sur tokens.json. N'ecrit que son propre cache, pour qu'une re-execution soit gratuite
// et que le chiffre publie reste auditable sans redepenser le budget.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { traceFeeder, SIBLING_MAX_PAGES } = require('../../lib/feeder');
const { maturityWindow, outcomeKnownAt } = require('../../lib/prequential');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const CACHE = path.join(__dirname, '..', '..', 'data', 'token-radar', 'rewalk-safe-bucket.json');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PAGES = Math.max(1, parseInt(flag('--pages', String(SIBLING_MAX_PAGES)), 10) || SIBLING_MAX_PAGES);
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry-run');
const MAINTENANT = Date.parse(flag('--at', new Date().toISOString()));

const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);

const basis = (t) => (t.basisAtFirstSight && typeof t.basisAtFirstSight === 'object') ? t.basisAtFirstSight : null;
const unreadable = (t) => { const b = basis(t); return b ? b.unreadable : undefined; };

/* ═══ QUELLE DEFINITION DE « SURVIVANT » TOURNE ICI — DETECTEE, PAS SUPPOSEE ═══
 * Ce script a rendu deux fois des chiffres differents sur des donnees identiques, a vingt minutes
 * d'intervalle: 1883 resolus / base 76,3 % puis 1727 / 83,1 %, et le seau SUR passant de 1,0 % a 1,4 %.
 * Ni la base ni le commit n'avaient bouge. `outcomeKnownAt` avait change — par une edition NON COMMITEE
 * d'une autre session travaillant dans le meme arbre, qui ajoute « il ne suffit pas d'avoir vieilli, il
 * faut avoir ete VU vivant a cet age » (`min(lastSeen, t)`).
 *
 * Epingler un hash n'aurait rien sauve: le code qui decide n'etait dans aucun commit. Le seul remede
 * est que la mesure PORTE sa semantique. On sonde donc le comportement avec un token synthetique plutot
 * que de lire la source — un token vieux de 10 h mais dont la derniere lecture date de son heure 1:
 *   · « age depuis la premiere vue »  -> 'survived'
 *   · « observe jusqu'a maturite »    -> null
 * ⚠️ Le classement industriel/sous-le-seuil ne depend PAS de ce choix (il sort de la re-marche RPC);
 * seuls les TAUX en dependent. C'est pourquoi la structure est reportee comme le resultat, et les taux
 * avec l'etiquette de la definition qui les a produits. */
function definitionSurvivant() {
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const faux = { outcome: 'live', firstSeen: new Date(T0).toISOString(),
    lastSeen: new Date(T0 + 1 * 3600e3).toISOString() };
  const r = outcomeKnownAt(faux, T0 + 10 * 3600e3, 4);
  return r === 'survived' ? 'age-depuis-premiere-vue (survivant des qu il a vieilli)'
    : 'observe-jusqu-a-maturite (il faut l avoir VU vivant a cet age)';
}

/* La meme fonction de qualite que la sonde, pour que les deux scripts decrivent le meme seau. */
function qualite(t) {
  if (t.siblingScanStoppedBy === 'end') return 'complete';
  if (t.siblingScanStoppedBy) return 'plafonnee:' + t.siblingScanStoppedBy;
  if (t.siblingCountCensored === true) return 'censuree';
  if (t.siblingCountCensored === false) return 'complete';
  return 'inconnue';
}

const seauSur = rows.filter((t) => unreadable(t) === 3 && typeof t.siblingCount === 'number' && t.siblingCount < 20);
const cible = seauSur.filter((t) => qualite(t) !== 'complete');

const parFinanceur = new Map();
for (const t of cible) {
  const k = String(t.funder || '').toLowerCase();
  if (!parFinanceur.has(k)) parFinanceur.set(k, []);
  parFinanceur.get(k).push(t);
}

console.log(`\n  ── SEMANTIQUE ACTIVE (detectee a l execution, pas supposee) ──`);
console.log(`  « survivant » = ${definitionSurvivant()}`);
console.log(`  maturityH = ${maturityH} h · evalue a ${new Date(MAINTENANT).toISOString()} · `
  + `${rows.length} lignes · ${rows.filter((t) => issue(t) !== null).length} resolus`);
console.log(`  ⚠️ ce bloc existe parce que ces chiffres ONT deja change sous une mesure en cours.`);

console.log(`\n  seau SUR : ${seauSur.length} tokens · dont ${cible.length} sur un compte CENSURE`);
console.log(`  financeurs DISTINCTS derriere ces ${cible.length} tokens : ${parFinanceur.size}`);
console.log(`  ⚠️ l unite d independance est le financeur, pas le token — ${cible.length} observations, `
  + `${parFinanceur.size} operateurs\n`);

const cache = (!FORCE && fs.existsSync(CACHE)) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

/* ═══ TROIS ETATS APRES RE-LECTURE, ET LE TROISIEME EST CELUI QUI SE FAIT OUBLIER ═══
 * Un compte re-lu sous 20 dont le balayage s'est arrete sur la BORNE reste un plancher: la borne a
 * bouge de 50 a ~300 transactions, elle n'a pas disparu. Le confondre avec un compte termine
 * refabriquerait exactement la faute qu'on mesure, un cran plus loin. Il lui faut sa branche. */
function classer(r) {
  if (!r || !r.ok || r.siblingCount == null) return 'non_lu';
  if (r.siblingCount >= 20) return 'industriel';              // le plancher franchit deja: c'est PROUVE
  if (r.siblingScanStoppedBy === 'end') return 'sous_le_seuil'; // historique epuise: c'est un COMPTE
  return 'plancher_indetermine';                               // < 20 mais la lecture s est arretee
}

(async () => {
  let appels = 0, lus = 0;
  const resultats = new Map();

  for (const [funder, tokens] of [...parFinanceur.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const stockes = [...new Set(tokens.map((t) => t.siblingCount))].sort((a, b) => a - b);
    if (cache[funder] && !FORCE) {
      resultats.set(funder, cache[funder]);
      console.log(`  ${funder.slice(0, 12)}…  ${String(tokens.length).padStart(3)} tok  `
        + `stocke ${JSON.stringify(stockes).padEnd(8)} → CACHE ${cache[funder].siblingCount}`);
      continue;
    }
    if (DRY) {
      console.log(`  ${funder.slice(0, 12)}…  ${String(tokens.length).padStart(3)} tok  `
        + `stocke ${JSON.stringify(stockes).padEnd(8)} → a lire (≤ ${3 + PAGES} appels)`);
      appels += 3 + PAGES;
      continue;
    }
    /* Un token REPRESENTATIF suffit, et il doit passer par traceFeeder plutot que par un appel maison:
     * c'est le lecteur qui vient d'etre corrige, donc c'est LUI qu'on veut exercer. Il redonne aussi le
     * financeur, ce qui verifie au passage qu'on re-marche bien la meme adresse. */
    const rep = tokens[0];
    const r = await traceFeeder(rep.chain || 'base', rep.addr, { maxPages: PAGES });
    appels += r.explorerCalls || 0;
    lus++;
    const resolu = String(r.funder || '').toLowerCase();
    const memeFinanceur = resolu === funder;
    const enregistrement = {
      funder, tokens: tokens.length, storedCounts: stockes, viaToken: rep.addr,
      ok: !!r.ok, reason: r.reason || null,
      resolvedFunder: r.funder || null, sameFunder: memeFinanceur,
      siblingCount: r.ok ? r.siblingCount : null,
      siblingPagesRead: r.siblingPagesRead, siblingPageCap: r.siblingPageCap,
      siblingTxScanned: r.siblingTxScanned, siblingScanStoppedBy: r.siblingScanStoppedBy,
      morePages: r.ok ? r.morePages : null, explorerCalls: r.explorerCalls,
    };
    enregistrement.classe = classer(enregistrement);
    resultats.set(funder, enregistrement);
    cache[funder] = enregistrement;
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));   // ecrit au fil de l eau: une coupure ne perd rien
    const drapeau = memeFinanceur ? '' : '  ⚠️ FINANCEUR DIFFERENT: ' + (r.funder || 'non resolu');
    console.log(`  ${funder.slice(0, 12)}…  ${String(tokens.length).padStart(3)} tok  `
      + `stocke ${JSON.stringify(stockes).padEnd(8)} → ${String(enregistrement.siblingCount).padStart(4)}  `
      + `${String(enregistrement.siblingPagesRead)}p/${enregistrement.siblingPageCap} `
      + `${enregistrement.siblingScanStoppedBy}  ${enregistrement.classe}${drapeau}`);
  }

  if (DRY) { console.log(`\n  --dry-run : ${appels} appels au plus pour ${parFinanceur.size} financeurs.\n`); return; }

  console.log(`\n  ── INSTRUMENT ──`);
  console.log(`  appels explorateur depenses : ${appels}  ·  financeurs lus a chaud : ${lus}`
    + `  ·  repris du cache : ${parFinanceur.size - lus}`);
  console.log(`  borne de pages : ${PAGES}  ·  pages lues : `
    + [...resultats.values()].map((r) => r.siblingPagesRead).join(', '));
  const differents = [...resultats.values()].filter((r) => !r.sameFunder);
  console.log(`  financeurs qui se resolvent differemment aujourd hui : ${differents.length}`);

  /* ── LE DECOUPAGE DEMANDE: par VRAI compte, pas par compte enregistre ── */
  const groupes = { industriel: [], sous_le_seuil: [], plancher_indetermine: [], non_lu: [] };
  for (const [funder, r] of resultats) for (const t of parFinanceur.get(funder)) groupes[r.classe].push(t);

  const ligne = (nom, g) => {
    const r = g.filter((t) => issue(t) === 'rugged').length;
    const s = g.filter((t) => issue(t) === 'survived').length;
    const res = r + s;
    const f = new Set(g.map((t) => String(t.funder).toLowerCase())).size;
    console.log(`    ${nom.padEnd(26)} ${String(g.length).padStart(4)} tok · ${String(f).padStart(2)} fin · `
      + `${String(r).padStart(3)} rug · ${String(s).padStart(3)} surv · `
      + `${res ? ((r / res) * 100).toFixed(1).padStart(5) : '  n/a'} %`);
    return { n: g.length, f, r, res };
  };

  console.log(`\n  ── LE SEAU SUR, DECOUPE PAR VRAI COMPTE ──\n`);
  const gi = ligne('VRAI >= 20 (industriel)', groupes.industriel);
  const gb = ligne('VRAI < 20 (lu jusqu au bout)', groupes.sous_le_seuil);
  const gp = ligne('< 20 mais ENCORE plancher', groupes.plancher_indetermine);
  const gn = ligne('non lu', groupes.non_lu);

  console.log(`\n  ── LA CONTRADICTION ──\n`);
  const projete = Math.round(cible.length * 4 / 7);
  console.log(`  projection depuis 9330a3b (4 des 7 franchissent) : ~${projete} tokens industriels,`);
  console.log(`    soit ~${Math.round(projete * 0.934)} rugs attendus au taux industriel de 93,4 %.`);
  console.log(`  MESURE ici                                       : ${gi.n} tokens industriels, `
    + `${gi.r} rug(s) observe(s).`);
  console.log(`  ⚠️ la projection supposait ${cible.length} tirages independants; il y en a ${parFinanceur.size}.`);

  if (gb.res) {
    console.log(`\n  le 1,0 % sur le groupe VRAIMENT sous le seuil : `
      + `${((gb.r / gb.res) * 100).toFixed(1)} % (${gb.r}/${gb.res}), sur ${gb.f} financeur(s).`);
  } else {
    console.log(`\n  ⚠️ AUCUN token ne se qualifie « vraiment sous le seuil » : le 1,0 % n a pas de`);
    console.log(`     population sur laquelle survivre. Ce n est pas un dementi, c est une ABSENCE de test.`);
  }
  if (gp.n) {
    console.log(`\n  ⛔ ${gp.n} token(s) (${gp.f} financeur(s)) restent sur un PLANCHER apres ${PAGES} pages.`);
    console.log(`     Leur « < 20 » n est toujours pas une mesure. Les compter avec les lectures terminees`);
    console.log(`     referait la faute d un cran plus loin — les deux bornes sont publiees plus bas.`);
  }
  console.log('');

  /* Les deux bornes, publiees ensemble: le meilleur cas suppose que tout plancher indetermine est sain,
   * le pire qu il est industriel. Un seul chiffre ici serait un choix deguise en mesure. */
  const sousR = groupes.sous_le_seuil.filter((t) => issue(t) === 'rugged').length;
  const sousRes = groupes.sous_le_seuil.filter((t) => issue(t) !== null).length;
  const planR = groupes.plancher_indetermine.filter((t) => issue(t) === 'rugged').length;
  const planRes = groupes.plancher_indetermine.filter((t) => issue(t) !== null).length;
  if (sousRes || planRes) {
    const basse = sousRes ? (sousR / sousRes) : null;
    const haute = (sousRes + planRes) ? ((sousR + planR) / (sousRes + planRes)) : null;
    console.log(`  ── TAUX DU SEAU « SUR » APRES RE-LECTURE, DEUX BORNES ──`);
    console.log(`    lectures TERMINEES seules        : ${basse == null ? 'n/a' : (basse * 100).toFixed(1) + ' %'}`
      + `  (${sousR}/${sousRes})`);
    console.log(`    + les planchers indetermines     : ${haute == null ? 'n/a' : (haute * 100).toFixed(1) + ' %'}`
      + `  (${sousR + planR}/${sousRes + planRes})`);
    console.log(`    ⛔ publier la borne basse seule serait annoncer une precision qu on n a pas lue.`);
  }
  /* ═══ CE QUI DISCRIMINE N'EST PAS LE VRAI COMPTE — ET LA CELLULE MANQUANTE N'A PAS BESOIN D'ETRE LUE ═══
   * Deux populations portent `unreadable === 3` ET un vrai compte >= 20. Elles ne different que par UN
   * detail: le seuil a-t-il ete franchi DES LA PREMIERE PAGE, ou seulement en profondeur.
   *
   * Le cote DANGER n'est pas re-marche, et ce n'est pas une economie de budget: c'est une deduction. Un
   * compte censure est un PLANCHER, donc `stocke >= 20` implique `vrai >= 20` — la cellule est determinee
   * logiquement, la lire depenserait 72 appels pour confirmer une implication. La cellule symetrique
   * (`stocke >= 20` et `vrai < 20`) est vide pour la meme raison: un plancher ne peut pas surestimer.
   *
   * Et le compte d'une page N'EST PAS un compte rate: c'est une DENSITE. « Combien de destinataires
   * distincts dans les ~50 dernieres transactions ». Franchir 20 sur une page, c'est payer 20 portefeuilles
   * distincts en rafale — la signature d'une usine. Atteindre 29 en 300 transactions, c'est un portefeuille
   * chaud qui vit depuis longtemps. La pagination remplace la rafale par un TOTAL A VIE, qui confond les
   * deux. Les densites mesurees ici le disent sans hypothese: aucun des 11 financeurs du seau SUR n'atteint
   * 0,40 destinataire par transaction, alors que tout le cote DANGER l'atteint par construction. */
  const dangerTok = rows.filter((t) => unreadable(t) === 3 && typeof t.siblingCount === 'number' && t.siblingCount >= 20);
  const dangerFin = new Set(dangerTok.map((t) => String(t.funder).toLowerCase())).size;
  const dR = dangerTok.filter((t) => issue(t) === 'rugged').length;
  const dRes = dangerTok.filter((t) => issue(t) !== null).length;

  console.log(`\n  ── CE QUI DISCRIMINE : LA DENSITE, PAS LE TOTAL ──\n`);
  console.log(`  les deux groupes ci-dessous ont TOUS un vrai compte >= 20 :\n`);
  console.log(`    seuil franchi DES LA 1re PAGE   ${String(dangerTok.length).padStart(4)} tok · `
    + `${String(dangerFin).padStart(2)} fin · ${String(dR).padStart(3)} rug · `
    + `${dRes ? ((dR / dRes) * 100).toFixed(1).padStart(5) : '  n/a'} %`);
  console.log(`    seuil franchi EN PROFONDEUR     ${String(gi.n).padStart(4)} tok · `
    + `${String(gi.f).padStart(2)} fin · ${String(gi.r).padStart(3)} rug · `
    + `${gi.res ? ((gi.r / gi.res) * 100).toFixed(1).padStart(5) : '  n/a'} %`);
  if (dRes && gi.res) {
    console.log(`\n  ecart : ${(((dR / dRes) - (gi.r / gi.res)) * 100).toFixed(1)} points entre deux groupes que`);
    console.log(`  le VRAI compte declare identiques. Le total a vie ne porte pas le signal; la rafale si.`);
  }
  console.log(`\n  ⛔ ET LA CONSEQUENCE POUR LE CLASSEUR, dite en precision plutot qu en anecdote :`);
  console.log(`     le compte pagine reclasserait ${gi.n} tokens en DANGER pour attraper ${gi.r} rug`);
  console.log(`     (precision ${gi.res ? ((gi.r / gi.res) * 100).toFixed(1) : 'n/a'} %, contre un taux de base de `
    + `${(100 * rows.filter((t) => issue(t) === 'rugged').length / rows.filter((t) => issue(t) !== null).length).toFixed(1)} %).`);
  console.log(`     Un drapeau DANGER moins precis que le hasard n est pas un drapeau. ⚠️ n=${gi.r} rug: cette`);
  console.log(`     precision est bornee par un seul evenement — elle refute le 93,4 %, elle ne la remplace pas.`);
  console.log(`\n  cache : ${path.relative(process.cwd(), CACHE)}\n`);
})();
