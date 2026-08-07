#!/usr/bin/env node
// probe-paris-par-financeur.js — les six paris annonces, notes sur l'unite d'independance.
// ================================================================================================
// `gradeAnnounced` note les paris par TOKEN. Mesure du 2026-08-07: la population est massivement
// groupee — 975 tokens resolus derriere 192 financeurs, et les dix plus gros en portent 80,6 %. Sur un
// decoupage groupe, un ecart de 91 points s'est revele n'etre qu'un financeur qui n'avait pas rugge.
// La question est donc: lesquelles de nos six cartes reposent sur des TOKENS, et lesquelles sur des
// TIRAGES ?
//
// ⚠️ CE QU'ELLE PEUT PROUVER: pour chaque pari et chaque branche, combien de financeurs DISTINCTS
// portent les appels notes, de combien l'intervalle s'elargit quand on compte sur eux, et l'ecart entre
// le taux par token et la moyenne NON PONDEREE par financeur.
// ⛔ CE QU'ELLE NE PEUT PAS: dire qu'une carte est FAUSSE. Un taux par token est exact sur les tokens
// observes. Il ne repond pas a « et sur le prochain operateur ? », qui est une autre question.
// ⛔ ELLE NE MODIFIE RIEN. Les paris sont geles; changer leur unite de notation est une decision
// produit. La mesure se publie A COTE de l'existante, jamais a sa place.
//
// ⛔ ET ELLE SE VERIFIE CONTRE LA FONCTION CANONIQUE. Cette sonde doit re-parcourir les tokens pour
// pouvoir les grouper — `gradeAnnounced` ne rend que des agregats. Re-ecrire une marche, c'est risquer
// de la re-ecrire FAUX. Les predicats viennent donc de `RULES` (exporte, jamais recopie), et les
// comptes obtenus sont compares un a un a ceux de `gradeAnnounced`. Au moindre desaccord, la carte
// n'est PAS publiee: un chiffre issu d'une marche non conforme vaudrait moins que rien.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gradeAnnounced, outcomeKnownAt, maturityWindow, MIN_RESOLUS,
  RULES, DANGER, ABSTAIN } = require('../../lib/prequential');
const { ANNOUNCED } = require('../../lib/announced-rules');
const { proportionAvecBornes } = require('../../lib/binomial');

const RACINE = path.join(__dirname, '..', '..');
const rows = Object.entries(JSON.parse(fs.readFileSync(
  path.join(RACINE, 'data/token-radar/tokens.json'), 'utf8'))).map(([addr, v]) => ({ addr, ...v }))
  .filter((t) => Number.isFinite(Date.parse(t.firstSeen)));
const MAINTENANT_ISO = process.argv[2] || new Date().toISOString();
const T = Date.parse(MAINTENANT_ISO);
const { maturityH } = maturityWindow(rows);
const cle = (t) => (typeof t.funder === 'string' && t.funder.length > 10 ? t.funder.toLowerCase() : null);

/* Les agregats canoniques, pour verifier la marche de cette sonde avant d'en publier quoi que ce soit. */
/* ⚠️ La cle est `cards`, pas `cartes`: la variable interne est francaise, la sortie est anglaise. Lue
 * dans un retour reel, pas devinee d'apres le nom de la variable locale — ce qui etait mon erreur. */
const canonique = gradeAnnounced(rows, MAINTENANT_ISO);
if (!Array.isArray(canonique.cards)) {
  console.error('⛔ gradeAnnounced ne rend pas `cards`: la forme a change. Rien ne se publie.');
  process.exit(1);
}
const officiel = new Map(canonique.cards.map((c) => [c.key, c]));
const regles = new Map(RULES.map((r) => [r.key, r]));

const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');

function marche(a) {
  const regle = regles.get(a.key);
  if (!regle) return { key: a.key, erreur: 'aucune regle vivante ne porte cette cle' };
  const debut = Date.parse(a.announcedAt);
  const eligibles = rows.filter((t) => Date.parse(t.firstSeen) > debut);

  /* Deux seaux, chacun garde ses appels notes ET l'identite du financeur qui les porte. */
  const seau = { danger: [], sur: [] };
  let sansFinanceur = 0;
  for (const t of eligibles) {
    /* Aucun des six predicats annonces ne lit l'historique (verifie: `predict.length === 1`). Si l'un
     * venait a en avoir besoin, le lui passer VIDE fabriquerait un resultat; on le calcule alors. */
    const hist = regle.predict.length >= 2
      ? eligibles.filter((h) => Date.parse(h.firstSeen) < Date.parse(t.firstSeen)
        && outcomeKnownAt(h, Date.parse(t.firstSeen), maturityH))
      : [];
    const p = regle.predict(t, hist);
    if (p === ABSTAIN) continue;
    const mine = outcomeKnownAt(t, T, maturityH);
    if (!mine) continue;                                   // appel ouvert: ni juste ni faux
    const f = cle(t);
    if (!f) sansFinanceur++;
    (p === DANGER ? seau.danger : seau.sur).push({ f, rug: mine === 'rugged' });
  }
  return { key: a.key, label: a.label, seau, sansFinanceur };
}

function branche(appels) {
  const resolus = appels.length;
  const rugs = appels.filter((x) => x.rug).length;
  const avecF = appels.filter((x) => x.f);
  const sansF = resolus - avecF.length;
  const parF = new Map();
  for (const x of avecF) {
    if (!parF.has(x.f)) parF.set(x.f, { n: 0, r: 0 });
    const e = parF.get(x.f); e.n++; if (x.rug) e.r++;
  }
  const fN = parF.size;
  const moyenne = fN ? [...parF.values()].reduce((s, e) => s + e.r / e.n, 0) / fN : null;
  /* ⛔ LE NOMBRE DE TIRAGES N'EST PAS UN NOMBRE, C'EST UN INTERVALLE. Les appels sans financeur trace
   * comptent dans le taux par token et n'apparaissent dans aucun financeur. Au minimum ils partagent
   * tous un meme payeur inconnu (+1 tirage), au maximum ils en ont un chacun. Publier `fN` seul
   * sous-estimerait l'independance; publier `fN + sansF` la surestimerait. On publie les deux. */
  const tiragesMin = fN + (sansF > 0 ? 1 : 0);
  const tiragesMax = fN + sansF;
  const brut = proportionAvecBornes(rugs, resolus);
  /* Calcule sur la borne BASSE des tirages: c'est l'intervalle le plus large, donc le moins affirmatif.
   * Sur un compte d'independance, se tromper large est le bon sens de l'erreur. */
  const vrai = proportionAvecBornes(rugs, resolus, { effectif: tiragesMin, plancher: MIN_RESOLUS });
  return { resolus, rugs, fN, sansF, tiragesMin, tiragesMax, moyenne, brut, vrai,
    groupement: fN ? avecF.length / fN : null };
}

console.log('\n  ── LES SIX PARIS, NOTES SUR DEUX UNITES ──');
console.log('     arrete a ' + new Date(T).toISOString() + '  ·  fenetre de maturite ' + maturityH + ' h');

let desaccords = 0;
for (const a of ANNOUNCED) {
  const m = marche(a);
  console.log('\n  ' + a.key + '  —  ' + a.label);
  if (m.erreur) { console.log('    ⛔ ' + m.erreur); continue; }

  /* ── LA VERIFICATION, AVANT TOUT CHIFFRE ─────────────────────────────────────────────────────── */
  const off = officiel.get(a.key);
  const d = branche(m.seau.danger), s = branche(m.seau.sur);
  const attendu = off ? [off.dangerResolved, off.safeResolved,
    (off.dangerResolved || 0) - (off.observed ? 0 : 0)] : null;
  const conforme = off && off.dangerResolved === d.resolus && off.safeResolved === s.resolus;
  if (!conforme) {
    desaccords++;
    console.log('    ⛔ MARCHE NON CONFORME — cette sonde compte ' + d.resolus + ' appel(s) danger et '
      + s.resolus + ' sur; `gradeAnnounced` en compte '
      + (off ? off.dangerResolved + ' et ' + off.safeResolved : '(carte absente)') + '.');
    console.log('       Rien n est publie pour ce pari. Un chiffre issu d une marche non conforme vaut');
    console.log('       moins que rien: il aurait l air d une mesure.');
    continue;
  }

  for (const [nom, b] of [['DANGER', d], ['SUR   ', s]]) {
    if (!b.resolus) { console.log('    ' + nom + '  aucun appel resolu — rien a mesurer'); continue; }
    const ic = (r) => {
      if (r.taux !== null) return pct(r.taux) + ' [' + pct(r.basse).trim() + '–' + pct(r.haute).trim() + ']';
      if (r.retenu) return '  RETENU (' + r.effectif + ' tirage(s) < ' + MIN_RESOLUS + ')';
      return '  REFUSE (' + r.raison.slice(0, 46) + ')';
    };
    console.log('    ' + nom + '  ' + String(b.rugs).padStart(4) + ' rug / ' + String(b.resolus).padStart(4)
      + ' resolus   par token ' + ic(b.brut));
    console.log('            tirages: ' + b.tiragesMin + ' a ' + b.tiragesMax
      + '  (' + b.fN + ' financeur(s) trace(s)' + (b.sansF ? ' + ' + b.sansF + ' appel(s) sans trace' : '')
      + ')'.padEnd(6) + '  par tirage ' + ic(b.vrai));
    if (b.moyenne !== null && b.brut.taux !== null) {
      const ecart = 100 * (b.moyenne - b.brut.taux);
      console.log('            moyenne NON PONDEREE par financeur ' + pct(b.moyenne)
        + '   ecart ' + (ecart >= 0 ? '+' : '') + ecart.toFixed(1) + ' pts'
        + '   groupement ' + b.groupement.toFixed(1) + ' tok/fin');
    } else if (b.moyenne === null) {
      console.log('            ⛔ aucun financeur trace sur cette branche: le nombre de tirages est');
      console.log('               INCONNU, pas egal au nombre de tokens. Rien ne se publie par tirage.');
    }
  }
}

console.log('\n  ⛔ CE QUI EST PUBLIE ET CE QUI NE L EST PAS. Le taux « par token » est celui que rend');
console.log('     `gradeAnnounced` aujourd hui — exact sur les tokens observes. Le taux « par tirage »');
console.log('     est le MEME comptage ramene au nombre de financeurs distincts; sous ' + MIN_RESOLUS + ' tirages il');
console.log('     est RETENU et seul le compte reste lisible.');
console.log('  ⛔ AUCUNE REGLE N EST MODIFIEE. Changer l unite de notation des paris annonces est une');
console.log('     decision produit; cette sonde ne fait que poser les deux chiffres cote a cote.');
console.log('  ⚠️ ET LE COMPTE DE FINANCEURS EST UN MAJORANT D INDEPENDANCE: deux adresses distinctes');
console.log('     peuvent partager un operateur, et la chaine ne le montre pas.');
if (desaccords) {
  console.log('\n  ⛔ ' + desaccords + ' pari(s) non publie(s) pour marche non conforme — voir ci-dessus.');
  process.exitCode = 1;
}
console.log('');
