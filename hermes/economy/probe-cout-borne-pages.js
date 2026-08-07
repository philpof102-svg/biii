#!/usr/bin/env node
// probe-cout-borne-pages.js — que COUTE reellement la borne de six pages, et que couterait la lever ?
// ================================================================================================
// La mesure du 2026-08-07 a montre que 7 financeurs sur 9 s'arretent sur `page_cap` et ne comptent donc
// jamais vers le chiffrage du seuil de densite. La borne est la contrainte qui mord. Mais un arbitrage
// avec un seul cote du chiffre n'est pas un arbitrage: on savait ce que la borne COUTE en preuve, pas ce
// qu'elle EPARGNE en appels. Cette sonde rend l'autre cote.
//
// ⛔ ELLE NE RECOMMANDE RIEN. Lever la borne change deux choses a la fois — le cout en appels sur un
// explorateur gratuit, et le SENS de `page_cap` pour tout ce qui le lit en aval. Les deux appartiennent
// a un humain.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: ce qui a REELLEMENT ete consomme (les pages lues sont persistees), quelle
// part de l'enveloppe cela represente, et les deux BORNES du cout d'un plafond plus haut.
// ⛔ CE QU'ELLE NE PEUT PAS: dire ce que les pages supplementaires liraient. Un financeur arrete a la
// page 6 peut terminer a la page 7 comme continuer au-dela de 12 — on ne le saura qu'en les lisant.
// C'est pourquoi le cout projete est publie en FOURCHETTE et jamais en point.
// ⛔ ET LE COUT MESURE EST UN PLANCHER: les traces qui ECHOUENT consomment aussi des appels et ne
// persistent pas `siblingPagesRead`. Elles sont invisibles ici, donc absentes du total.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');   // pas execSync: cmd.exe mange les metacaracteres
const { SIBLING_MAX_PAGES, TRACE_FIXED_CALLS } = require('../../lib/feeder');

const RACINE = path.join(__dirname, '..', '..');
const REL_DB = 'data/token-radar/tokens.json';
const REL_TROUS = 'data/token-radar/blackouts.json';
const REL_RADAR = 'hermes/economy/token-radar.js';
const CHAMP = 'siblingPagesRead';
const MAINTENANT = Date.parse(process.argv[3] || new Date().toISOString());
const PLAFOND_TESTE = Number(process.argv[2]) || 12;

/* ── LES CONSTANTES DE BUDGET VIVENT DANS UN FICHIER EPINGLE, ON LES LIT PLUTOT QUE DE LES RECOPIER ──
 * `token-radar.js` est un script, pas un module: il n'exporte pas `TRACE_CALL_BUDGET` ni `TRACE_MAX`, et
 * son sha256 est epingle — l'editer pour ajouter un export ARRETERAIT son cron en silence. Les recopier
 * ici creerait une derive muette le jour ou l'un des deux bouge. On les LIT dans la source, et si l'un
 * manque on REFUSE de projeter: une projection sur un budget devine ne vaut rien. */
function constante(source, nom) {
  const ligne = source.split('\n').find((l) => l.trim().startsWith('const ' + nom + ' ='));
  if (!ligne) return null;
  const n = Number(ligne.split('=')[1].split(';')[0].trim());
  return Number.isFinite(n) ? n : null;
}
/* La source est surchargeable par `RADAR_SRC` UNIQUEMENT pour prouver le refus ci-dessous. Prouver ce
 * fail-closed en editant le vrai fichier est exclu: son sha256 est epingle et une edition arreterait son
 * cron en silence — la verification serait plus couteuse que le defaut qu'elle cherche. */
const src = fs.readFileSync(process.env.RADAR_SRC || path.join(RACINE, REL_RADAR), 'utf8');
const BUDGET = constante(src, 'TRACE_CALL_BUDGET');
const MAX_TOKENS = constante(src, 'TRACE_MAX');

/* ── DEPUIS QUAND, ET COMBIEN DE CE TEMPS L'INSTRUMENT TOURNAIT-IL ? ────────────────────────────── */
let miseEnService = null, erreurGit = null;
try {
  const s = execFileSync('git', ['log', '--format=%aI', '-S', CHAMP, '--', REL_DB],
    { cwd: RACINE, encoding: 'utf8' }).trim();
  const l = s ? s.split('\n') : [];
  if (l.length) miseEnService = Date.parse(l[l.length - 1]);
} catch (e) { erreurGit = e.message; }

let trousH = null, erreurTrous = null;
if (miseEnService) {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(RACINE, REL_TROUS), 'utf8'));
    if (!Array.isArray(journal)) throw new Error('le journal n est pas un tableau');
    let somme = 0;
    for (const t of journal) {
      const d = Date.parse(t.from), f = Date.parse(t.to);
      if (!Number.isFinite(d) || !Number.isFinite(f)) continue;
      const chev = Math.min(f, MAINTENANT) - Math.max(d, miseEnService);
      if (chev > 0) somme += chev;
    }
    trousH = somme / 3600000;
  } catch (e) { erreurTrous = e.message; }
}
const mural = miseEnService ? (MAINTENANT - miseEnService) / 3600000 : null;
const uptime = (mural !== null && trousH !== null) ? mural - trousH : null;

/* ── CE QUI A ETE CONSOMME ──────────────────────────────────────────────────────────────────────── */
const rows = Object.entries(JSON.parse(fs.readFileSync(path.join(RACINE, REL_DB), 'utf8')))
  .map(([addr, v]) => ({ addr, ...v }));
const traces = rows.filter((t) => Number.isInteger(t[CHAMP]) && t[CHAMP] > 0);
const cout = (pages) => TRACE_FIXED_CALLS + pages;

const parEtat = new Map();
for (const t of traces) {
  const cle = (t.siblingScanStoppedBy || 'inconnu') + '@' + t[CHAMP] + 'p';
  if (!parEtat.has(cle)) parEtat.set(cle, { etat: t.siblingScanStoppedBy || 'inconnu', pages: t[CHAMP],
    plafond: t.siblingPageCap, n: 0 });
  parEtat.get(cle).n++;
}
const depense = traces.reduce((s, t) => s + cout(t[CHAMP]), 0);
const surBorne = traces.filter((t) => t.siblingScanStoppedBy === 'page_cap');
const plafondsAbaisses = traces.filter((t) => Number.isInteger(t.siblingPageCap)
  && t.siblingPageCap < SIBLING_MAX_PAGES);

console.log('\n  ── LA BORNE, ET L ENVELOPPE QUI LA CONTIENT ──\n');
if (BUDGET === null || MAX_TOKENS === null) {
  console.log('  ⛔ ' + REL_RADAR + ' ne livre pas ses constantes de budget'
    + (BUDGET === null ? ' (TRACE_CALL_BUDGET)' : '') + (MAX_TOKENS === null ? ' (TRACE_MAX)' : '') + '.');
  console.log('     AUCUNE projection ne se publie: une projection sur un budget devine ne vaut rien.');
} else {
  console.log('    SIBLING_MAX_PAGES   ' + SIBLING_MAX_PAGES + '   pages de fratrie par trace');
  console.log('    TRACE_FIXED_CALLS   ' + TRACE_FIXED_CALLS + '   appels fixes avant la fratrie');
  console.log('    cout maximal / trace ' + cout(SIBLING_MAX_PAGES) + '   appels');
  console.log('    TRACE_MAX           ' + MAX_TOKENS + '  tokens traces par passage');
  console.log('    TRACE_CALL_BUDGET   ' + BUDGET + ' appels par passage');
  console.log('  → ' + MAX_TOKENS + ' x ' + cout(SIBLING_MAX_PAGES) + ' = ' + (MAX_TOKENS * cout(SIBLING_MAX_PAGES))
    + ' appels: l enveloppe est dimensionnee pour que le PIRE cas tienne.');
  console.log('    Les deux constantes sont un couple, pas deux reglages independants.');
}

console.log('\n  ── CE QUI A REELLEMENT ETE CONSOMME ──\n');
console.log('    traces datables (portant ' + CHAMP + ')   ' + traces.length);
console.log('    appels consommes par elles                ' + depense
  + '   (moyenne ' + (traces.length ? (depense / traces.length).toFixed(2) : '—') + ' / trace)');
console.log('\n    etat        pages  plafond   traces');
for (const e of [...parEtat.values()].sort((a, b) => b.n - a.n)) {
  console.log('    ' + e.etat.padEnd(12) + String(e.pages).padStart(3) + String(e.plafond).padStart(9)
    + String(e.n).padStart(9));
}
console.log('\n    arretees SUR la borne                     ' + surBorne.length
  + (traces.length ? '   (' + (100 * surBorne.length / traces.length).toFixed(0) + ' %)' : ''));
/* La question qui pouvait tout retourner: `planTrace` abaisse le plafond quand l'enveloppe se vide. Si
 * les `page_cap` observes etaient des bornes de BUDGET et non de DESIGN, lever SIBLING_MAX_PAGES ne
 * changerait rien du tout — et la conclusion de la veille serait fausse. */
console.log('    dont le plafond etait ABAISSE par le budget  ' + plafondsAbaisses.length
  + (plafondsAbaisses.length ? '  ⚠️ le budget mord DEJA' : '  → toutes sur la borne de DESIGN'));

/* ── LA PROJECTION, EN FOURCHETTE ────────────────────────────────────────────────────────────────── */
if (BUDGET !== null && MAX_TOKENS !== null && traces.length && PLAFOND_TESTE <= SIBLING_MAX_PAGES) {
  /* ⛔ Les deux bornes ci-dessous supposent qu'on MONTE le plafond: la borne basse dit « chaque trace
   * bornee se termine des la page suivante », ce qui n'a aucun sens si le nouveau plafond est plus bas
   * que l'actuel. Plutot que de rendre des nombres qui se liraient comme une projection, on refuse. */
  console.log('\n  ⛔ PLAFOND DEMANDE (' + PLAFOND_TESTE + ') <= plafond actuel (' + SIBLING_MAX_PAGES + ').');
  console.log('     Cette sonde ne projette que des HAUSSES: ses deux bornes reposent sur « la lecture');
  console.log('     continue au-dela de la page ' + SIBLING_MAX_PAGES + ' », ce qu une baisse ne fait pas.');
  console.log('     Une baisse se chiffre autrement — elle RETIRE des pages deja lues, donc son effet est');
  console.log('     connu exactement, sans fourchette. Rien n est publie ici plutot qu un chiffre faux.\n');
} else if (BUDGET !== null && MAX_TOKENS !== null && traces.length) {
  const hautCout = traces.reduce((s, t) => s + cout(t.siblingScanStoppedBy === 'page_cap'
    ? PLAFOND_TESTE : t[CHAMP]), 0);                       // haut: chaque trace bornee irait au nouveau plafond
  const basCout = traces.reduce((s, t) => s + cout(t.siblingScanStoppedBy === 'page_cap'
    ? SIBLING_MAX_PAGES + 1 : t[CHAMP]), 0);               // bas: chacune se termine des la page suivante
  console.log('\n  ── SI LE PLAFOND PASSAIT A ' + PLAFOND_TESTE + ' ──\n');
  console.log('    cout maximal / trace        ' + cout(SIBLING_MAX_PAGES) + ' -> ' + cout(PLAFOND_TESTE) + ' appels');
  console.log('    traces tenant dans ' + BUDGET + '        '
    + Math.floor(BUDGET / cout(SIBLING_MAX_PAGES)) + ' -> ' + Math.floor(BUDGET / cout(PLAFOND_TESTE))
    + '   (pire cas, toutes bornees)');
  console.log('    budget pour garder ' + MAX_TOKENS + ' traces  ' + BUDGET + ' -> '
    + (MAX_TOKENS * cout(PLAFOND_TESTE)) + ' appels  ('
    + (100 * (MAX_TOKENS * cout(PLAFOND_TESTE)) / BUDGET - 100).toFixed(0) + ' %)');
  console.log('\n    sur le melange REELLEMENT observe, le meme lot aurait coute:');
  console.log('      borne BASSE (chaque trace bornee finit page ' + (SIBLING_MAX_PAGES + 1) + ')  '
    + basCout + ' appels  (+' + (100 * basCout / depense - 100).toFixed(0) + ' %)');
  console.log('      borne HAUTE (chaque trace bornee va a ' + PLAFOND_TESTE + ')          '
    + hautCout + ' appels  (+' + (100 * hautCout / depense - 100).toFixed(0) + ' %)');

  if (uptime !== null && uptime > 0) {
    /* Le radar commite une fois par heure QUAND IL TOURNE: le nombre de passages est l uptime, pas le
     * temps mural. Le meme piege que la veille, au meme endroit. */
    const passages = uptime;
    const parPassage = traces.length / passages;
    console.log('\n  ── ET LE VOLUME REEL, QUI DECIDE SI L ENVELOPPE MORD ──\n');
    console.log('    uptime depuis la mise en service   ' + uptime.toFixed(2) + ' h'
      + '  (mural ' + mural.toFixed(2) + ' h, aveugle ' + trousH.toFixed(2) + ' h)');
    console.log('    passages horaires estimes          ' + passages.toFixed(1));
    console.log('    traces datables par passage        ' + parPassage.toFixed(1)
      + '   sur les ' + MAX_TOKENS + ' que le plafond autorise');
    const actuel = parPassage * (depense / traces.length);
    const projete = parPassage * (hautCout / traces.length);
    console.log('    appels par passage, aujourd hui    ' + actuel.toFixed(0) + ' / ' + BUDGET
      + '   (' + (100 * actuel / BUDGET).toFixed(0) + ' % de l enveloppe)');
    console.log('    appels par passage a ' + PLAFOND_TESTE + ' pages     ' + projete.toFixed(0) + ' / ' + BUDGET
      + '   (' + (100 * projete / BUDGET).toFixed(0) + ' % — borne HAUTE)');
    console.log('\n  ⛔ CE CHIFFRE EST UN PLANCHER, ET LE PLANCHER EST LE COTE DANGEREUX ICI. Les traces qui');
    console.log('     ECHOUENT consomment des appels sans persister ' + CHAMP + ': elles sont absentes du');
    console.log('     total. Et le volume par passage est une MOYENNE — c est le passage le plus CHARGE qui');
    console.log('     ferait deborder l enveloppe, pas le passage moyen.');
    console.log('  ⚠️ ET LE DEBORDEMENT N EST PAS UN REFUS PROPRE: `planTrace` rogne la PROFONDEUR avant de');
    console.log('     refuser un token. Un plafond trop haut ne coupe donc pas la couverture — il fait VARIER');
    console.log('     `siblingPageCap` d un token a l autre DANS un meme passage, et `page_cap` cesse de');
    console.log('     designer une seule quantite. C est exactement la faute que la densite vient de corriger.');

    /* ── A QUELLE FREQUENCE UN PASSAGE EST-IL ASSEZ CHARGE POUR QUE CA ARRIVE ? ─────────────────────
     * La moyenne ne decide rien: c'est le passage le plus charge qui fait deborder. Le depot garde une
     * piste append-only (`observations.jsonl`) dont chaque ligne est horodatee — on peut donc regrouper
     * par passage et LIRE la distribution au lieu de la supposer.
     * ⛔ BORNE: une OBSERVATION n'est pas une TRACE. `toJudge` est un sous-ensemble des tokens vus, et
     * aucune trace ne porte d'horodatage ni d'identifiant de passage. Le compte ci-dessous est donc un
     * MAJORANT de la charge de trace — la frequence reelle de debordement est plus basse, jamais plus
     * haute. C'est le bon sens de l'erreur pour une decision de budget. */
    try {
      const brut = fs.readFileSync(path.join(RACINE, 'data/token-radar/observations.jsonl'), 'utf8')
        .trim().split('\n');
      const ts = brut.map((l) => Date.parse(JSON.parse(l).ts)).filter(Number.isFinite).sort((a, b) => a - b);
      const passagesObs = [];
      let cur = null;
      for (const t of ts) {
        if (!cur || t - cur.fin > 10 * 60000) { cur = { debut: t, fin: t, n: 0 }; passagesObs.push(cur); }
        cur.fin = t; cur.n++;
      }
      const tailles = passagesObs.map((p) => p.n).sort((a, b) => a - b);
      const quant = (p) => tailles[Math.min(tailles.length - 1, Math.floor(p * tailles.length))];
      const satures = passagesObs.filter((p) => p.n >= MAX_TOKENS).length;
      console.log('\n  ── A QUELLE FREQUENCE UN PASSAGE ATTEINDRAIT-IL LA SATURATION ? ──\n');
      console.log('    passages reconstruits depuis observations.jsonl   ' + passagesObs.length);
      console.log('    tokens VUS par passage: median ' + quant(0.5) + '  p90 ' + quant(0.9)
        + '  p99 ' + quant(0.99) + '  MAX ' + tailles[tailles.length - 1]);
      console.log('    passages atteignant TRACE_MAX (' + MAX_TOKENS + ')                 ' + satures
        + ' sur ' + passagesObs.length + '  (' + (100 * satures / passagesObs.length).toFixed(1) + ' %)');
      console.log('  ⛔ MAJORANT: une observation n est pas une trace, et aucune trace ne porte de');
      console.log('     marqueur de passage. La frequence reelle est PLUS BASSE que ce chiffre.');
    } catch (e) {
      console.log('\n  ⛔ observations.jsonl illisible (' + e.message + '): la frequence de saturation');
      console.log('     ne se publie pas. Sans elle, on ignore si le debordement serait rare ou courant.');
    }
  } else {
    console.log('\n  ⛔ Uptime inconnu ('
      + (erreurGit ? 'git: ' + erreurGit : erreurTrous ? 'trous: ' + erreurTrous : 'mise en service introuvable')
      + '). Le volume par passage ne se publie pas, donc rien ne dit si l enveloppe mordrait.');
  }
}
console.log('');
