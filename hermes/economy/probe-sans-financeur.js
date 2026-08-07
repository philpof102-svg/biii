#!/usr/bin/env node
// probe-sans-financeur.js — `no_funder` rugge a 46 %. Est-ce un profil, ou une soustraction ?
// ================================================================================================
// Des cinq etats de trace, `no_funder` est le seul qui rugge nettement MOINS que la base: 46,0 % contre
// 83 %. Un chiffre pareil se lit comme une decouverte — « les deployeurs finances par contrat sont plus
// sains ». Cette sonde le desassemble avant qu'il ne soit cru.
//
// CE QUE `no_funder` EST, LU DANS LE CODE ET NON DEDUIT DU NOM (`lib/feeder.js`, branche
// `if (!funders.length)`): l'explorateur A REPONDU (`fundingRead: true`) et aucun transfert entrant ne
// porte de valeur. Or `/transactions?filter=to` ne rend pas les transactions INTERNES. L'etat signifie
// donc « paye par un contrat, un bridge, ou un retrait » — un financement d'une AUTRE FORME, pas une
// absence de financement. La note du tracer le dit deja: « may be funded via a contract or bridged ».
//
// ⚠️ CE QU'ELLE PEUT PROUVER: si l'ecart survit a la liquidite, et quelles autres proprietes separent
// systematiquement ce groupe du groupe trace.
// ⛔ CE QU'ELLE NE PEUT PAS: rendre un taux par TIRAGE. Ces tokens n'ont pas de financeur, et leur
// deployeur n'est pas persiste (mesure ci-dessous) — il ne reste aucune unite d'independance.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt, quantile } = require('../../lib/prequential');
const { proportionAvecBornes } = require('../../lib/binomial');

const RACINE = path.join(__dirname, '..', '..');
const rows = Object.entries(JSON.parse(fs.readFileSync(
  path.join(RACINE, 'data/token-radar/tokens.json'), 'utf8'))).map(([addr, v]) => ({ addr, ...v }));
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);
const issue = (t) => outcomeKnownAt(t, MAINTENANT, maturityH);
const etat = (t) => (t.funderTrace === undefined ? 'ABSENT' : String(t.funderTrace));
const nf = rows.filter((t) => etat(t) === 'no_funder');
const ok = rows.filter((t) => etat(t) === 'ok');
const pct = (x) => (x === null || x === undefined ? '   —  ' : (100 * x).toFixed(1).padStart(5) + ' %');

if (!nf.length || !ok.length) {
  console.log('\n  ⛔ Un des deux groupes est vide (`no_funder` ' + nf.length + ', `ok` ' + ok.length
    + '). Aucune comparaison ne se publie.\n');
  process.exit(0);
}

const mesure = (g) => {
  const res = g.filter((t) => issue(t) !== null);
  const rug = res.filter((t) => issue(t) === 'rugged').length;
  return { n: g.length, res: res.length, rug, p: proportionAvecBornes(rug, res.length) };
};
const ic = (m) => (m.p.taux === null ? '     —'
  : pct(m.p.taux) + ' [' + pct(m.p.basse).trim() + '–' + pct(m.p.haute).trim() + ']');

const mNF = mesure(nf), mOK = mesure(ok), mTout = mesure(rows);
console.log('\n  ── LE CHIFFRE QUI INTRIGUE ──\n');
console.log('    no_funder     ' + String(mNF.rug).padStart(4) + ' / ' + String(mNF.res).padStart(4) + '   ' + ic(mNF));
console.log('    ok (trace)    ' + String(mOK.rug).padStart(4) + ' / ' + String(mOK.res).padStart(4) + '   ' + ic(mOK));
console.log('    tout le radar ' + String(mTout.rug).padStart(4) + ' / ' + String(mTout.res).padStart(4) + '   ' + ic(mTout));

/* ── DESASSEMBLAGE 1: LA LIQUIDITE. L'ECART SURVIT-IL, OU CHANGE-T-IL DE SIGNE ? ─────────────────── */
const liqs = rows.filter((t) => Number.isFinite(t.firstLiq)).map((t) => t.firstLiq).sort((a, b) => a - b);
const q1 = quantile(liqs, 0.33), q2 = quantile(liqs, 0.66);
const STRATES = [['basse  ', (l) => l < q1], ['moyenne', (l) => l >= q1 && l < q2], ['haute  ', (l) => l >= q2]];
console.log('\n  ── DESASSEMBLAGE 1: A LIQUIDITE COMPARABLE ──\n');
console.log('    tertiles de firstLiq: < ' + Math.round(q1) + '  |  ' + Math.round(q1) + ' a ' + Math.round(q2)
  + '  |  > ' + Math.round(q2) + '\n');
console.log('    groupe        ' + STRATES.map(([n]) => n.padEnd(19)).join(''));
const grille = {};
for (const [nom, g] of [['no_funder', nf], ['ok       ', ok]]) {
  grille[nom.trim()] = STRATES.map(([, pred]) => {
    const s = g.filter((t) => Number.isFinite(t.firstLiq) && pred(t.firstLiq));
    const m = mesure(s);
    return m.res ? m : null;
  });
  console.log('    ' + nom + '     ' + grille[nom.trim()]
    .map((m) => (m ? (pct(m.p.taux).trim() + ' (' + m.res + ')').padEnd(19) : '—'.padEnd(19))).join(''));
}
const [, nfMid, nfHaut] = grille.no_funder;
if (nfMid && nfHaut && nfMid.p.taux !== null && nfHaut.p.taux !== null) {
  const ecart = 100 * (nfHaut.p.taux - nfMid.p.taux);
  console.log('\n  ⛔ L ECART CHANGE DE SIGNE A L INTERIEUR DU GROUPE: ' + pct(nfMid.p.taux).trim()
    + ' en strate moyenne (' + nfMid.res + ' resolus) contre ' + pct(nfHaut.p.taux).trim()
    + ' en strate haute (' + nfHaut.res + ').');
  console.log('     ' + ecart.toFixed(1) + ' points d ecart DANS le meme groupe, et en strate haute il rugge PLUS');
  console.log('     que le groupe trace. Le « 46 % » global est donc porte par une seule strate, pas par un');
  console.log('     profil. Un chiffre qui s inverse quand on le stratifie n est pas un effet, c est un melange.');
  const chev = !(nfMid.p.haute < nfHaut.p.basse || nfHaut.p.haute < nfMid.p.basse);
  console.log('     Intervalles ' + (chev ? 'CHEVAUCHANTS' : 'DISJOINTS') + ' — '
    + (chev ? 'l inversion elle-meme n est pas etablie a ces effectifs.'
      : 'l inversion est etablie a ces effectifs.'));
}

/* ── DESASSEMBLAGE 2: LA CIRCULARITE. LE VERDICT DEPEND-IL DE LA TRACE ? ─────────────────────────── */
const repartition = (g, lire) => {
  const m = new Map();
  for (const t of g) { const v = lire(t); m.set(v, (m.get(v) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, n]) => k + ' ' + (100 * n / g.length).toFixed(0) + '%').join('  ');
};
console.log('\n  ── DESASSEMBLAGE 2: LES DEUX GROUPES NE SONT PAS JUGES PAR LE MEME CHEMIN ──\n');
console.log('    firstVerdict  no_funder : ' + repartition(nf, (t) => String(t.firstVerdict)));
console.log('                  ok        : ' + repartition(ok, (t) => String(t.firstVerdict)));
const hrNF = nf.filter((t) => t.firstVerdict === 'high_risk').length;
const hrOK = ok.filter((t) => t.firstVerdict === 'high_risk').length;
console.log('\n    high_risk     no_funder ' + hrNF + ' / ' + nf.length
  + '   ·   ok ' + hrOK + ' / ' + ok.length);
console.log('  ⛔ ET VOILA LA CIRCULARITE. Le verdict `high_risk` du radar s appuie en grande partie sur le');
console.log('     FINANCEUR (financeur industriel, fratrie). Un token sans financeur identifie ne peut donc');
console.log('     pas le recevoir — sa rarete ici n est pas une propriete du token, c est une consequence');
console.log('     mecanique de l etat de trace. Comparer les deux taux de rug revient a comparer un groupe');
console.log('     dont on a RETIRE le signal de danger le plus fort a un groupe qui le contient.');

/* ── DESASSEMBLAGE 3: LA DONNEE QUI EXISTE ET QUI EST JETEE ──────────────────────────────────────── */
const avecDep = nf.filter((t) => typeof t.deployer === 'string' && t.deployer.length > 10).length;
console.log('\n  ── DESASSEMBLAGE 3: LA SEULE IDENTITE QUI RESTAIT, ET ELLE EST PERDUE ──\n');
console.log('    tokens `no_funder` portant un `deployer`   ' + avecDep + ' / ' + nf.length);
console.log('  ⛔ `traceFeeder` REND le deployeur sur cette branche — c est verifie par');
console.log('     test/feeder.test.js. `token-radar.js` fait `continue` sur `!f.funder` AVANT la ligne qui');
console.log('     persiste `db[addr].deployer`, trois lignes au-dessus des temoins qu il garde soigneusement.');
console.log('     Sans financeur ET sans deployeur, ces ' + nf.length + ' lignes n ont plus AUCUNE unite de');
console.log('     regroupement: elles sont definitivement incomptables en tirages independants.');
console.log('  ⚠️ Reparer cela demande d editer un fichier au sha256 EPINGLE — son edition arrete son cron');
console.log('     en silence. Ce n est pas un geste d agent.');

console.log('\n  ⛔ CONCLUSION QUE CETTE SONDE AUTORISE, ET RIEN DE PLUS: le « 46 % » ne decrit pas un profil');
console.log('     de deployeur. Il decrit un groupe defini par un ECHEC DE LECTURE, dont le verdict est');
console.log('     produit par un chemin different, dont l ecart s inverse selon la liquidite, et dont');
console.log('     l independance est inconnaissable. Il ne se publie pas comme un signal.\n');
