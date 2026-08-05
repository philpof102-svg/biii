'use strict';
/**
 * BIII verdict eval-harness — the trust verdict, held to a metric, pinned as a diffable artifact.
 * ==================================================================================================
 * Borrowed from the graph-engineering dig (DSPy: compile a policy offline against a metric, save it as a
 * reloadable JSON). BIII's verdict logic (lib/trust.assessTriangle + lib/asset.assessAsset) is DETERMINISTIC
 * and must stay fail-closed. This harness runs a LABELED corpus through it and enforces three
 * non-negotiable gates, then writes eval/policy.json — a behavioral snapshot (what the code actually
 * decided) so a partner can audit WHICH policy produced a verdict, and a reviewer can DIFF the day the
 * behavior changes.
 *
 *   HARD GATE 1 — recall on known-bad = 100%: every negative (flagged reputation, denylisted or
 *                 impersonating asset) MUST come out non-payable / unsafe. A miss here BLESSES a scam.
 *   HARD GATE 2 — fail-closed held = 100%: every ambiguous case (CAUTION, unknown, low score, no data)
 *                 MUST NOT be payable on that signal alone. "Unknown is never safe" — enforced, not hoped.
 *   HARD GATE 3 — signals informative = 100%: every graded signal MUST still DISTINGUISH. Added
 *                 2026-07-27 after a day where the two gates above held at 1.0 while twelve real defects
 *                 lived in the layer that FEEDS them — including a concentration score that was 100 for
 *                 every token. That one broke in the safe direction, so no gate opened, and it still
 *                 measured nothing. A constant is not a measurement, it is an assertion.
 *   SOFT metric — positives payable: hand-built clean cases SHOULD pass; reported, not gated (a partner
 *                 tightens thresholds against their own false-positive tolerance).
 *
 * ⚠️ SCOPE, printed with the score: gates 1 and 2 grade the COMPOSITION given already-formed inputs.
 * "recall=1" means the composition never blesses a flagged input — NOT that the product catches every
 * bad actor. Gate 3 is the only one that reaches into the layer below. A number without its perimeter is
 * an assertion, which is precisely what this repo refuses to ship in a verdict; the same rule applies to
 * its own scorecard.
 *
 * Run:  node eval/verdict-harness.js          (runs the corpus, enforces gates, (re)writes policy.json)
 *       node eval/verdict-harness.js --check   (CI mode: fails if policy.json drifted or a gate breaks)
 * Pure/offline: it imports the verdict code and calls it — it never touches the running server, the chain,
 * or the merchant key. Safe to run while a live till is serving.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assessTriangle, standingVertex } = require('../lib/trust');
const { assessAsset } = require('../lib/asset');
/* La couche qui PRODUIT les entrees du triangle — celle que ce harnais ne regardait pas. Tout est pur et
 * synchrone ici: aucun de ces appels ne touche le reseau, la chaine, ni la cle du marchand. */
const { computeHealthMetrics } = require('../lib/holders-health');
const { candidatesFrom } = require('../lib/meme');
const { priceMicro } = require('../lib/openapi');
const { settleOnce, _reset: resetConsumed } = require('../lib/x402-settle');
const ZERO_ADDR = '0x' + '0'.repeat(40);

// REAL known-bad addresses (OFAC SDN extract, verified by the datasets scout 2026-07-21). Used as the
// denylist so the asset layer is tested against ground truth, not toy data.
const OFAC_SAMPLE = [
  '0x0330070fd38ec3bb94f58fa55d40368271e9e54a',
  '0x038989cbb1710c72b9920dc4fa529158f463e72c',
  '0xf4377eda661e04b6dda78969796ed31658d602d4',
];
const DENYLIST = new Set(OFAC_SAMPLE);
const REGISTRY = [
  { issuer: 'BlackRock', symbol: 'BUIDL', name: 'BlackRock USD Institutional Digital Liquidity',
    chainId: 1, address: '0x7712c34205737192402172409a8f7ccef8aa2aec', source: 'seed' },
];
const GENUINE = REGISTRY[0].address;
const PAID = { paid: true, tier: 'confirmed', txHash: '0x' + 'cd'.repeat(32) };
const PROVEN = { paidMicro: '5000000' };

/* ═══ CE QUE CE HARNAIS MESURAIT, ET CE QU'IL NE MESURAIT PAS ═══
 * Les 17 cas d'origine portent tous sur la COMPOSITION — assessTriangle et assessAsset — et lui
 * injectent des decisions DEJA PRISES ('PROCEED', 'BLOCK', 'CAUTION'). Aucun ne touchait les modules qui
 * PRODUISENT ces entrees.
 *
 * Le 2026-07-27, douze defauts reels ont ete trouves dans cette couche du dessous pendant que le harnais
 * affichait recall=1, failClosedHeld=1, positivesPayable=1 — un score parfait, toute la journee. Il
 * n'avait pas tort: il etait ETROIT, et ses metriques etaient lues comme la note du produit. Un
 * partenaire qui lit « recall=1 » comprend « 100 % des mauvais sont attrapes », pas « la composition est
 * correcte quand on lui donne les bonnes entrees ». La portee est donc desormais imprimee avec le score.
 *
 * ═══ QUATRIEME CATEGORIE: `informative` ═══
 * Aucune des trois existantes n'attrapait la faute la plus frequente du jour. `negative` attrape ce qui
 * BENIT un scam; `failclosed` attrape ce qui passe pour SUR; rien ne detectait un signal qui NE VARIE
 * PAS. `top10Concentration` valait 100 pour toute distribution: le verdict echouait dans le bon sens
 * (jamais 'healthy'), donc aucune porte ne s'ouvrait — et pourtant le signal n'observait rien.
 *
 * Un signal a variance nulle n'est pas une mesure, c'est une affirmation. C'est une PORTE DURE ici:
 * expedier un chiffre constant en le presentant comme mesure est un defaut produit, pas une imprecision.
 *
 * THE CORPUS. Each case: { name, label, run() → verdict, ok(verdict) → bool }.
 * label ∈ 'negative' (must be caught) | 'failclosed' (must not be payable)
 *       | 'informative' (must actually distinguish) | 'positive' (should pass). */
const triangle = (rep, standing, settlement, opts) => assessTriangle({ reputation: rep, standing, settlement }, opts || {});
const asset = (token, claim) => assessAsset({ token, ...(claim || {}) }, { registry: REGISTRY, denylist: DENYLIST });

const CASES = [
  // ── NEGATIVES: a flagged counterparty must be unsafe & unpayable, even with every other green ──
  { name: 'BLOCK overrides proven standing + settled payment', label: 'negative',
    run: () => triangle({ decision: 'BLOCK', score: 90 }, PROVEN, PAID),
    ok: (v) => v.trust === 'unsafe' && v.payable === false },
  { name: 'REFUSE with nothing else is unsafe', label: 'negative',
    run: () => triangle({ decision: 'REFUSE' }, null, null), ok: (v) => v.trust === 'unsafe' && !v.payable },
  { name: 'AVOID overrides proven standing', label: 'negative',
    run: () => triangle({ decision: 'AVOID' }, PROVEN, null), ok: (v) => v.trust === 'unsafe' && !v.payable },
  { name: 'DENY / DECLINE / UNSAFE all flag', label: 'negative',
    run: () => ['DENY', 'DECLINE', 'UNSAFE'].map((d) => triangle({ decision: d }, null, null)),
    ok: (vs) => vs.every((v) => v.trust === 'unsafe' && !v.payable) },
  { name: 'whitespace-padded " BLOCK " still flags (trim)', label: 'negative',
    run: () => triangle({ decision: ' BLOCK ' }, PAID && PROVEN, PAID), ok: (v) => v.trust === 'unsafe' },
  { name: 'denylisted OFAC contract is unsafe to acquire', label: 'negative',
    run: () => OFAC_SAMPLE.map((a) => asset(a)), ok: (vs) => vs.every((v) => v.status === 'unsafe' && v.safeToAcquire === false) },
  { name: 'impersonation: claims BUIDL but is a lookalike address', label: 'negative',
    run: () => asset('0x' + 'ee'.repeat(20), { claimedSymbol: 'BUIDL' }),
    ok: (v) => v.status === 'impersonation' && v.safeToAcquire === false },

  // ── FAIL-CLOSED: ambiguous signals must never be payable on their own ──
  { name: 'CAUTION alone is not payable', label: 'failclosed',
    run: () => triangle({ decision: 'CAUTION', score: 80 }, null, null), ok: (v) => v.payable === false },
  { name: 'PROCEED but score below floor is weak, not payable alone', label: 'failclosed',
    run: () => triangle({ decision: 'PROCEED', score: 10 }, null, null, { minScore: 40 }), ok: (v) => v.payable === false },
  { name: 'no reputation data at all → unknown, not payable', label: 'failclosed',
    run: () => triangle(null, null, null), ok: (v) => v.trust === 'unknown' && !v.payable },
  { name: 'unknown decision string → not payable', label: 'failclosed',
    run: () => triangle({ decision: 'MAYBE' }, null, null), ok: (v) => v.payable === false },
  { name: 'unknown contract with no claim → not safe to acquire', label: 'failclosed',
    run: () => asset('0x' + 'ab'.repeat(20)), ok: (v) => v.status === 'unknown' && v.safeToAcquire === false },
  { name: 'non-finite score never clears', label: 'failclosed',
    run: () => triangle({ score: NaN }, null, null), ok: (v) => v.payable === false },

  // ── POSITIVES: clean cases should pass (soft) ──
  { name: 'PROCEED at/above floor is trusted & payable', label: 'positive',
    run: () => triangle({ decision: 'PROCEED', score: 71 }, null, null, { minScore: 40 }), ok: (v) => v.payable === true },
  { name: 'proven standing alone is trusted & payable', label: 'positive',
    run: () => triangle(null, PROVEN, null), ok: (v) => v.payable === true },
  { name: 'PROCEED + settled on-chain is settled & proven', label: 'positive',
    run: () => triangle({ decision: 'PROCEED', score: 71 }, null, PAID), ok: (v) => v.trust === 'settled' && v.proven === true },
  { name: 'genuine registry contract is safe to acquire', label: 'positive',
    run: () => asset(GENUINE, { claimedSymbol: 'BUIDL' }), ok: (v) => v.status === 'genuine' && v.safeToAcquire === true },

  /* ── INFORMATIVE: un signal qui ne distingue rien n'est pas un signal ───────────────────────────────
   * Chacun de ces cas correspond a un defaut TROUVE EN PRODUCTION le 2026-07-27. Ils sont ici, et pas
   * seulement dans les tests unitaires, parce que ce fichier est le tableau de bord que le produit se
   * donne — et il affichait un score parfait pendant que ces defauts vivaient. Un cas qui ne teste qu'UNE
   * entree passerait aussi contre une constante: chacun compare donc des entrees OPPOSEES. */
  { name: 'holder concentration DISTINGUE une baleine d une distribution plate', label: 'informative',
    /* Valait 100 pour tout: numerateur et denominateur etaient la meme somme. rugScore >= 80 partout,
     * donc `healthy` TOUJOURS faux — expedie aux appelants de till_vet_meme sur chaque token Base. */
    run: () => {
      const mint = (to, v) => ({ from: ZERO_ADDR, to, value: BigInt(v), blockNumber: 1 });
      const plat = Array.from({ length: 200 }, (_, i) => mint('0x' + String(i + 1).padStart(40, '0'), 100));
      return { baleine: computeHealthMetrics([mint('0x' + '1'.padStart(40, '0'), 1e6)]).top10Concentration,
        plat: computeHealthMetrics(plat).top10Concentration };
    },
    ok: (v) => v.baleine === 100 && v.plat < 20 && v.baleine !== v.plat },

  { name: 'demander une chaine ne rend JAMAIS un contrat d une autre', label: 'informative',
    /* `Number('base')` = NaN (falsy) -> aucun filtre; 8453 -> aucun slug -> tout ecarte. Mesure en
     * production sur DEGEN: demander Base rendait un contrat SOLANA en status 'genuine'. */
    run: () => {
      const paires = [
        { chainId: 'solana', baseToken: { address: '0xS', symbol: 'X' }, liquidity: { usd: 9e6 } },
        { chainId: 'base', baseToken: { address: '0xB', symbol: 'X' }, liquidity: { usd: 1e3 } },
      ];
      return { slug: candidatesFrom(paires, 'X', 'base'), num: candidatesFrom(paires, 'X', 8453),
        inconnue: candidatesFrom(paires, 'X', 'chaine-inexistante') };
    },
    ok: (v) => v.slug.length === 1 && v.slug[0].chain === 'base'
      && v.num.length === 1 && v.num[0].chain === 'base'
      && v.inconnue.length === 0 },

  { name: 'un noeud STRUCTURELLEMENT AVEUGLE ne produit pas un constat', label: 'informative',
    /* Le standing est borne par la depense propre du noeud: a spend 0 il rend 0 pour TOUTE adresse.
     * Ce zero-la comptait comme « consulte, aucun historique » — un constat sur la contrepartie. */
    run: () => ({
      aveugle: standingVertex({ paidMicro: '0', bound: { spendMicro: '0' } }).status,
      voyant: standingVertex({ paidMicro: '0', bound: { spendMicro: '5000000' } }).status,
      absent: standingVertex(null).status,
    }),
    ok: (v) => v.aveugle === 'uninformative' && v.voyant === 'none' && v.absent === 'unqueried'
      && new Set([v.aveugle, v.voyant, v.absent]).size === 3 },

  { name: 'un prix illisible ou NEGATIF est refuse, jamais publie', label: 'informative',
    /* BigInt("-5000000") est valide: `paidMicro < priceNeed` devenait faux pour TOUT paiement, donc une
     * coquille dans BIII_VET_PRICE_USD rendait l endpoint payant gratuit. */
    run: () => ['abc', '-5', '1e3', '0'].map((p) => { try { priceMicro(p); return 'PUBLIE'; } catch { return 'refuse'; } })
      .concat(priceMicro('0.25')),
    ok: (v) => v.slice(0, 4).every((x) => x === 'refuse') && v[4] === '250000' },

  { name: 'une preuve de paiement sans ancre ne franchit pas la garde anti-rejeu', label: 'informative',
    /* `Number(confirmations || 0)` faisait d un champ absent la fraicheur MAXIMALE; `blockNumber || 0`
     * ancrait l empreinte au bloc 0, que la purge suivante effacait — rendant le paiement rejouable. */
    run: () => {
      const M = '0x' + 'a'.repeat(40);
      const bon = { paid: true, to: M, valueMicro: '250000', confirmations: 5, blockNumber: 3e7 };
      const essai = (patch, h) => { resetConsumed();
        return settleOnce({ proof: { ...bon, ...patch, txHash: '0x' + h.repeat(64).slice(0, 64) }, merchant: M, needMicro: '250000' }).ok; };
      return { sansConf: essai({ confirmations: undefined }, '1'), confNull: essai({ confirmations: null }, '2'),
        confVide: essai({ confirmations: '' }, '3'), sansBloc: essai({ blockNumber: undefined }, '4') };
    },
    ok: (v) => Object.values(v).every((x) => x === false) },
];

function runCorpus() {
  const byLabel = { negative: { total: 0, ok: 0 }, failclosed: { total: 0, ok: 0 }, informative: { total: 0, ok: 0 }, positive: { total: 0, ok: 0 } };
  const failures = [];
  // behavioral snapshot of the reputation classifier — so policy.json reflects the CODE, not a copy
  const repSnapshot = {};
  for (const d of ['PROCEED', 'PROCEED_LOW_VALUE', 'CAUTION', 'BLOCK', 'REFUSE', 'AVOID', 'DENY', 'DECLINE', 'UNSAFE', 'MAYBE']) {
    repSnapshot[d] = triangle({ decision: d, score: 71 }, null, null).vertices.reputation.status;
  }
  for (const c of CASES) {
    const bucket = byLabel[c.label];
    bucket.total++;
    let pass = false;
    try { pass = !!c.ok(c.run()); } catch (e) { pass = false; }
    if (pass) bucket.ok++; else failures.push(c.label + ': ' + c.name);
  }
  const recall = byLabel.negative.total ? byLabel.negative.ok / byLabel.negative.total : 1;
  const failClosedHeld = byLabel.failclosed.total ? byLabel.failclosed.ok / byLabel.failclosed.total : 1;
  const positivesPayable = byLabel.positive.total ? byLabel.positive.ok / byLabel.positive.total : 1;
  /* Un signal a variance nulle n est pas une mesure: porte DURE, au meme titre que recall. */
  const signalsInformative = byLabel.informative.total ? byLabel.informative.ok / byLabel.informative.total : 1;
  return { byLabel, failures, recall, failClosedHeld, positivesPayable, signalsInformative, repSnapshot };
}

// deterministic fingerprint of the corpus (names+labels) — a stable id for "which cases were run"
function corpusFingerprint() {
  const canon = CASES.map((c) => c.label + '|' + c.name).sort().join('\n');
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

function buildPolicy(r) {
  return {
    artifact: 'biii-verdict-policy',
    generatedFrom: 'lib/trust.assessTriangle + lib/asset.assessAsset',
    policy: {
      minScoreDefault: 40,
      reputationClassification: r.repSnapshot,               // decision → status, as the CODE decides it
      overrideRule: 'reputation.status==="unsafe" forces trust="unsafe" and payable=false, over any other green',
      failClosed: 'unknown / CAUTION / below-floor / non-finite-score are never payable on reputation alone',
      assetStatuses: ['genuine (payable)', 'impersonation/unsafe (blocked)', 'unknown (not payable)'],
      denylistSource: 'OFAC SDN extract (0xB10C) sample; production injects the full MainStreet denylist',
    },
    corpus: { fingerprint: corpusFingerprint(), size: CASES.length,
      negatives: r.byLabel.negative.total, failclosed: r.byLabel.failclosed.total, positives: r.byLabel.positive.total },
    metrics: { recall: r.recall, failClosedHeld: r.failClosedHeld, signalsInformative: r.signalsInformative, positivesPayable: r.positivesPayable },
    gates: { recall: 1, failClosedHeld: 1, signalsInformative: 1 },                 // the non-negotiable thresholds
  };
}

function main() {
  const check = process.argv.includes('--check');
  const r = runCorpus();
  const policy = buildPolicy(r);
  const outPath = path.join(__dirname, 'policy.json');
  const rendered = JSON.stringify(policy, null, 2) + '\n';

  console.log('BIII verdict eval-harness — ' + CASES.length + ' cases (fingerprint ' + policy.corpus.fingerprint + '):');
  for (const [label, b] of Object.entries(r.byLabel)) console.log('  ' + label.padEnd(11) + ' ' + b.ok + '/' + b.total);
  if (r.failures.length) { console.log('  FAILURES:'); for (const f of r.failures) console.log('   ✗ ' + f); }
  console.log('  metrics: recall=' + r.recall + ' failClosedHeld=' + r.failClosedHeld
    + ' signalsInformative=' + r.signalsInformative + ' positivesPayable=' + r.positivesPayable);
  /* LA PORTEE, IMPRIMEE AVEC LE SCORE. « recall=1 » sans elle se lit « 100 % des mauvais sont attrapes »,
   * alors que la mesure porte sur la COMPOSITION d'entrees deja formees, plus les cas `informative` qui
   * exercent la couche du dessous. Un chiffre sans son perimetre est une affirmation, pas une mesure —
   * c'est la regle que ce depot applique a ses verdicts, elle vaut pour sa propre note. */
  console.log('  portee : ' + r.byLabel.negative.total + ' negatifs + ' + r.byLabel.failclosed.total
    + ' fail-closed sur la COMPOSITION (assessTriangle/assessAsset), ' + r.byLabel.informative.total
    + ' sur la couche qui produit ses entrees. Ce n\'est pas le recall du produit entier.');

  // THE GATES — a scam blessed (recall<1) or an ambiguous case waved through (failClosedHeld<1) is fatal.
  const gateBreach = [];
  /* ⛔ UNE PORTE QUI TIENT SUR ZERO CAS NE TIENT RIEN. Les quatre metriques ci-dessus s'ecrivent
   * `byLabel.X.total ? ok/total : 1`, donc un corpus vide rend 1 — un score PARFAIT tire d'aucune
   * preuve. Vider les cas `negative` par une mauvaise edition ou un filtre laissait donc `recall=1`,
   * les portes tenir, `npm test` vert, et le harnais imprimer « ✅ gates hold ».
   *
   * Ce depot connait deja la regle et l'applique ailleurs: test/suite-total.js refuse d'annoncer un
   * total quand AUCUN bilan n'a ete reconnu, parce qu'un zero rendu par un outil qui n'a rien su lire
   * n'est pas un zero du monde. Elle manquait a la garde qui protege les verdicts PAYANTS.
   *
   * Le plancher porte sur les trois labels a porte DURE. `positive` reste advisory — sa definition dit
   * « should pass », pas « must » — mais son absence est signalee, car `positivesPayable: 1` publie
   * dans policy.json serait autrement lu comme « les bons contreparties passent toutes ». */
  for (const label of ['negative', 'failclosed', 'informative']) {
    if (!r.byLabel[label].total) {
      gateBreach.push('corpus vide pour `' + label + '`: la porte a tenu sur ZERO cas — '
        + 'un score parfait sans preuve n est pas un succes, c est un instrument aveugle');
    }
  }
  if (r.recall < 1) gateBreach.push('recall on known-bad = ' + r.recall + ' (< 1.0): a flagged counterparty/asset was NOT caught');
  if (r.failClosedHeld < 1) gateBreach.push('fail-closed held = ' + r.failClosedHeld + ' (< 1.0): an ambiguous case became payable');
  if (r.signalsInformative < 1) gateBreach.push('signals informative = ' + r.signalsInformative + ' (< 1.0): a signal stopped distinguishing — a constant is not a measurement, it is an assertion');
  if (!r.byLabel.positive.total) {
    console.log('  ⚠️ aucun cas `positive`: positivesPayable=1 ne dit alors PAS que les bonnes '
      + 'contreparties passent — il dit qu on n en a teste aucune.');
  }

  if (check) {
    let drift = null;
    /* ⚠️ COMPARER LE COMPORTEMENT, PAS LES FINS DE LIGNE. La comparaison etait octet a octet: le harnais
     * ecrit en \n, et git (autocrlf) reecrit le fichier en \r\n a chaque checkout sous Windows. Un simple
     * `git checkout eval/policy.json` suffisait donc a declencher « ⛔ DRIFT: policy.json differs from the
     * current verdict behavior » — une DERIVE DE COMPORTEMENT annoncee alors que le contenu est identique
     * au caractere pres. Constate le 2026-07-28: diff brut = 45 lignes changees, diff --strip-trailing-cr
     * = aucune.
     *
     * Une garde qui crie au loup se fait desactiver, et celle-ci sort en 1 (elle casse `npm test`). Le
     * risque n'est donc pas cosmetique: le premier reflexe devant une alerte permanente est de la retirer,
     * et avec elle la detection des VRAIES derives de verdict. */
    const memeContenu = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
    try { const cur = fs.readFileSync(outPath, 'utf8'); if (!memeContenu(cur, rendered)) drift = 'policy.json differs from the current verdict behavior'; }
    catch { drift = 'policy.json missing — run `node eval/verdict-harness.js` to generate it'; }
    if (gateBreach.length || drift) {
      for (const g of gateBreach) console.error('  ⛔ GATE: ' + g);
      if (drift) console.error('  ⛔ DRIFT: ' + drift);
      process.exit(1);
    }
    console.log('  ✅ --check: gates hold, policy.json matches current behavior');
    return;
  }

  if (gateBreach.length) { for (const g of gateBreach) console.error('  ⛔ GATE: ' + g); process.exit(1); }
  fs.writeFileSync(outPath, rendered);
  console.log('  ✅ gates hold — wrote ' + path.relative(process.cwd(), outPath));
}

main();
