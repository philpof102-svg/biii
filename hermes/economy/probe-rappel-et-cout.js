#!/usr/bin/env node
// probe-rappel-et-cout.js — un ecart n'est pas un produit. Ce qu'un drapeau ATTRAPE, et ce qu'il COUTE.
// ================================================================================================
// Les deux sondes precedentes ont etabli que « deployeur jetable » (`freshDeployer`) n'ajoute rien la ou
// `funder-20` dit deja DANGER, et 58,9 points la ou il dit SUR (sur lectures non censurees). Un ecart
// de taux ne dit pourtant rien de ce qui compte pour quelqu'un qui s'en sert:
//   · combien de rugs sont ATTRAPES (rappel), et
//   · combien de survivants sont accuses a tort (cout), et
//   · ce qui reste dans la branche « sur » — la seule que lit un acheteur qui passe a l'achat.
// Un pourcentage seul ne vaut rien sans son taux de base ET son rappel. Cette sonde publie les trois.
//
// ⛔ DEUX UNIVERS, ET LE SECOND EST CELUI QUI DECIDE. Les deux drapeaux n'existent que sur les tokens
// TRACES: sans trace, ni `siblingCount` ni `freshDeployer`. Mesurer sur les seuls traces flatte la
// regle, parce que les tokens qu'elle ne peut pas lire disparaissent du calcul. En production ils ne
// disparaissent pas — ils tombent dans « sur » par defaut. Les deux univers sont donc publies.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: rappel, precision, taux de faux positifs et surtout la SURVIE de la
// branche « sur », chacun avec ses bornes exactes.
// ⛔ CE QU'ELLE NE PEUT PAS: promettre ces chiffres a l'avenir. Ils sont mesures VERS L'ARRIERE sur la
// population deja observee; seul un pari annonce et note vers l'avant vaut comme preuve — c'est ce que
// `gradeAnnounced` fait, et cette sonde n'en tient pas lieu.
// ⛔ ELLE NE PROMEUT RIEN.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, MIN_RESOLUS } = require('../../lib/prequential');
const { proportionAvecBornes } = require('../../lib/binomial');

const RACINE = path.join(__dirname, '..', '..');
const rows = Object.entries(JSON.parse(fs.readFileSync(
  path.join(RACINE, 'data/token-radar/tokens.json'), 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const SEUIL = 20;
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const fnd = (t) => (typeof t.funder === 'string' && t.funder.length > 10 ? t.funder.toLowerCase() : null);
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');
const ic = (p) => (p.taux === null ? (p.retenu ? 'RETENU' : 'REFUSE')
  : pct(p.taux) + ' [' + pct(p.basse).trim() + '–' + pct(p.haute).trim() + ']');

/* Les deux drapeaux, exactement comme le depot les lit ailleurs. Un champ absent n'est PAS un `false`:
 * il rend `null`, et l'appelant decide quoi en faire — ce qui est precisement la question de l'univers. */
const parFinanceur = (t) => (typeof t.siblingCount !== 'number' ? null : t.siblingCount >= SEUIL);
const parJetable = (t) => (t.freshDeployer === true ? true : t.freshDeployer === false ? false : null);

const resolus = rows.filter((t) => issue(t) !== null);
const traces = resolus.filter((t) => parFinanceur(t) !== null && parJetable(t) !== null);

function matrice(pop, drapeau) {
  const marque = pop.filter((t) => drapeau(t) === true);
  const libre = pop.filter((t) => drapeau(t) !== true);       // `null` compte comme NON marque: c'est la production
  const rugs = pop.filter((t) => issue(t) === 'rugged');
  const vp = marque.filter((t) => issue(t) === 'rugged').length;
  const fp = marque.length - vp;
  const fn = libre.filter((t) => issue(t) === 'rugged').length;
  const vn = libre.length - fn;
  const fdr = new Set(marque.map(fnd).filter(Boolean)).size;
  return {
    n: pop.length, rugs: rugs.length, marque: marque.length, libre: libre.length, vp, fp, fn, vn, fdr,
    rappel: proportionAvecBornes(vp, rugs.length),
    precision: proportionAvecBornes(vp, marque.length),
    fauxPositifs: proportionAvecBornes(fp, pop.length - rugs.length),
    survieSur: proportionAvecBornes(vn, libre.length),
  };
}

const DRAPEAUX = [
  ['funder-20 seul', (t) => parFinanceur(t) === true],
  ['jetable seul', (t) => parJetable(t) === true],
  ['UNION des deux', (t) => parFinanceur(t) === true || parJetable(t) === true],
  ['INTERSECTION', (t) => parFinanceur(t) === true && parJetable(t) === true],
  /* ⚠️ CONTREFACTUEL, PAS UNE PROPOSITION. `probe-trace-manquante.js` a mesure que « createur non lu »
   * rugge a 93,3 % et separe de 30,8 points a liquidite haute: l'illisibilite est elle-meme un signal,
   * et aujourd'hui elle tombe en SILENCE dans la branche « sur ». Cette ligne chiffre ce que couterait
   * et rapporterait de la traiter comme un marqueur. Elle est MESUREE, pas recommandee — promouvoir un
   * palier est un geste date qui appartient a un humain. */
  ['UNION + createur non lu', (t) => parFinanceur(t) === true || parJetable(t) === true
    || t.funderTrace === 'no_creator'],
];

function publie(pop, titre, note) {
  const base = proportionAvecBornes(pop.filter((t) => issue(t) === 'rugged').length, pop.length);
  console.log('\n  ── ' + titre + ' ──');
  console.log('     ' + pop.length + ' token(s) resolu(s)  ·  taux de base ' + ic(base));
  if (note) console.log('     ' + note);
  console.log('\n    regle                marques   rappel                   precision                survie de « sur »');
  console.log('    ' + '-'.repeat(104));
  for (const [nom, d] of DRAPEAUX) {
    const m = matrice(pop, d);
    console.log('    ' + nom.padEnd(20) + String(m.marque).padStart(6) + '   '
      + ic(m.rappel).padEnd(24) + ' ' + ic(m.precision).padEnd(24) + ' ' + ic(m.survieSur));
    console.log('      ' + ('vp ' + m.vp + ' · fp ' + m.fp + ' · fn ' + m.fn + ' · vn ' + m.vn).padEnd(38)
      + 'faux positifs ' + ic(m.fauxPositifs) + '   ' + m.fdr + ' financeur(s) marque(s)');
  }
}

publie(resolus, 'UNIVERS DE PRODUCTION — tous les tokens resolus',
  '⛔ Un token non trace ne peut etre marque par aucun des deux: il tombe dans « sur » par defaut.');
publie(traces, 'UNIVERS FLATTEUR — seulement les tokens ou LES DEUX drapeaux sont lisibles',
  '⚠️ Les ' + (resolus.length - traces.length) + ' tokens non lisibles ont disparu du calcul. C est le chiffre'
  + ' qu on publierait par erreur.');

/* ── ET LE MEME, SANS LE PLANCHER: seulement les comptes de freres lus en entier ─────────────────── */
const complets = traces.filter((t) => t.siblingCountCensored === false);
if (complets.length >= MIN_RESOLUS) {
  publie(complets, 'LECTURES COMPLETES SEULEMENT (siblingCount non censure)',
    '⚠️ ' + complets.length + ' token(s): le plancher de `siblingCount` est retire, mais la population'
    + ' n est plus celle de la production.');
} else {
  console.log('\n  ⛔ Moins de ' + MIN_RESOLUS + ' tokens a lecture complete (' + complets.length
    + '): ce decoupage ne se publie pas.');
}

/* ── ET LA VRAIE CONTRAINTE: POURQUOI 886 TOKENS NE SONT PAS LISIBLES ────────────────────────────
 * L'ecart entre les deux tableaux N'EST PAS un defaut des regles — elles sont justes quand elles
 * parlent (precision 95-99 %). Il vient entierement de la COUVERTURE. Et cette couverture n'est pas
 * d'un seul type: une partie est HISTORIQUE (des lignes anterieures a l'instrumentation, qui ne
 * reviendront pas mais ne se reproduiront pas non plus) et une partie est PERMANENTE (l'explorateur
 * ne nommera jamais ces createurs). Les confondre ferait passer un probleme qui se resorbe pour un
 * probleme structurel, ou l'inverse. */
const illisibles = resolus.filter((t) => parFinanceur(t) === null || parJetable(t) === null);
const classe = (t) => {
  const e = t.funderTrace;
  if (e === undefined) return 'historique (champ absent, precede l instrumentation)';
  if (e === 'no_creator') return 'PERMANENT (explorateur sans createur indexe)';
  if (e === 'no_funder') return 'PERMANENT (aucun entrant porteur de valeur)';
  if (e === 'failed') return 'mixte (etiquette `failed`, 74 % de no_creator perimes)';
  return 'autre (' + String(e) + ')';
};
console.log('\n  ── POURQUOI ' + illisibles.length + ' TOKENS RESOLUS NE SONT LISIBLES PAR AUCUN DES DEUX ──\n');
const parClasse = new Map();
for (const t of illisibles) {
  const k = classe(t);
  if (!parClasse.has(k)) parClasse.set(k, { n: 0, r: 0 });
  const e = parClasse.get(k); e.n++; if (issue(t) === 'rugged') e.r++;
}
for (const [k, e] of [...parClasse.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log('    ' + String(e.n).padStart(5) + '  ' + (100 * e.n / illisibles.length).toFixed(1).padStart(5)
    + ' %   ' + k + '   (rug ' + (100 * e.r / e.n).toFixed(1) + ' %)');
}
const hist = [...parClasse.entries()].filter(([k]) => k.startsWith('historique'))
  .reduce((s, [, e]) => s + e.n, 0);
console.log('\n  ⚠️ ' + hist + ' de ces ' + illisibles.length + ' sont HISTORIQUES: leur illisibilite ne se reproduira pas.');
console.log('     Le chiffre de production ci-dessus est donc un PLANCHER qui doit remonter de lui-meme —');
console.log('     mais seulement jusqu au niveau que la part PERMANENTE autorise. Aucune des deux moities');
console.log('     ne se lit sans l autre.');

console.log('\n  ⛔ LA COLONNE QUI DECIDE EST « SURVIE DE SUR », PAS LE RAPPEL. Un drapeau qui attrape tout');
console.log('     en marquant tout a un rappel parfait et ne sert a rien. Ce qu un acheteur lit, c est la');
console.log('     branche non marquee: si elle survit a 50 %, la regle ne protege de rien.');
console.log('  ⛔ ET LA DIFFERENCE ENTRE LES DEUX PREMIERS TABLEAUX EST LE COUT REEL DE LA COUVERTURE.');
console.log('     Restreindre aux tokens lisibles ameliore tous les chiffres sans qu aucune regle ne soit');
console.log('     meilleure: c est la population qui a change. Le premier tableau est celui qui engage.');
console.log('  ⛔ MESURE VERS L ARRIERE. Ces chiffres sont calcules sur une population deja observee et ne');
console.log('     valent pas comme preuve prospective — seul un pari annonce puis note vers l avant le');
console.log('     fait, et c est le role de `gradeAnnounced`, pas de cette sonde.');
console.log('  ⛔ RIEN N EST PROMU. Annoncer un pari est date et irreversible.\n');
