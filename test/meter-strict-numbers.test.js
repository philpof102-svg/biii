'use strict';
/**
 * meter — un chiffre de FACTURATION illisible ne devient jamais un chiffre.
 * Run: node test/meter-strict-numbers.test.js
 *
 * ═══ CE QUI A ETE MESURE LE 2026-08-11, PAR `callTool('till_meter')` ET PAS PAR UNE FIXTURE ═══
 * `Number()` seul rendait NaN sur tout champ de prix illisible, et NaN traversait toute la facture sans
 * rien casser — TOUJOURS dans le sens qui sous-facture, celui que personne ne verifie a la baisse:
 *
 *   plan valide + verdictCount 6000 ....... $1000   <- la vraie facture
 *   verdictCount "6,000" .................. $750    <- octet pour octet « 0 verdict » ET « rien declare »
 *   includedVerdicts "cinq mille" ......... $750    <- Math.max(0, 6000-NaN)=NaN, et NaN>0 est faux
 *   monthlyBaseUsd "sept cents" ........... $250    <- round2(NaN)=0: l abonnement facture a ZERO
 *   verdictOverageUsd "un quart" .......... $750    <- une ligne de charge SERVIE a $0
 *
 * ⛔ LES DEUX BORNES SONT TENUES ICI, et la premiere moitie est la plus importante: sans elle, « refuser
 * tout » passerait cette suite. Les entrees VALIDES — y compris les chaines numeriques que les clients
 * JSON-RPC envoient reellement — doivent rendre EXACTEMENT la facture d'avant.
 */
const assert = require('node:assert');
const { meterUsage, mergePlan } = require('../lib/meter');
const { callTool } = require('../bin/biii-mcp.js');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const tA = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const PLAN = { name: 'pilot', monthlyBaseUsd: 750, includedVerdicts: 5000, verdictOverageUsd: 0.25,
  includedReceipts: Infinity, receiptOverageUsd: 0.03 };

/** Le refus attendu: il jette, il porte `invalidParams` (c'est ce qui autorise le -32602 a NOMMER le
 *  champ), et son message contient le chemin complet du champ fautif. */
const refuse = (fn, champ, quoi) => {
  assert.throws(fn, (e) => {
    assert.strictEqual(e.invalidParams, true, quoi + ': le refus doit porter invalidParams (sinon -32603 muet)');
    assert.ok(e.message.includes(champ), quoi + ': le refus doit NOMMER ' + champ + ' — recu: ' + e.message);
    return true;
  }, quoi);
};

console.log('BIII meter — chiffres de facturation stricts:');

/* ── BORNE 1: CE QUI MARCHAIT DOIT MARCHER A L IDENTIQUE ────────────────────────────────────────── */

t('temoin: plan valide + 6000 verdicts → $1000 (750 base + 1000 surplus × $0.25)', () => {
  const m = meterUsage([], { plan: PLAN, verdictCount: 6000 });
  assert.strictEqual(m.selfReported.verdicts, 6000);
  assert.strictEqual(m.totalUsd, 1000);
  assert.strictEqual(m.charges.length, 2);
});

t('les chaines NUMERIQUES continuent de marcher — les clients JSON-RPC en envoient (mesure 2026-08-09)', () => {
  const parChaine = meterUsage([], { plan: PLAN, verdictCount: '6000' });
  const parNombre = meterUsage([], { plan: PLAN, verdictCount: 6000 });
  assert.deepStrictEqual(parChaine, parNombre, '"6000" doit facturer comme 6000');
  const decimal = meterUsage([], { plan: { ...PLAN, verdictOverageUsd: '0.25' }, verdictCount: 6000 });
  assert.strictEqual(decimal.totalUsd, 1000, 'un prix unitaire decimal en chaine reste lisible');
  const zeroInclus = meterUsage([], { plan: { ...PLAN, includedReceipts: '0' }, verdictCount: 6000 });
  assert.strictEqual(zeroInclus.totalUsd, 1000, '"0" est une borne basse LEGITIME, pas une absence');
});

t('verdictCount ABSENT reste 0 et ne facture aucun surplus — ne rien declarer est legitime', () => {
  const absent = meterUsage([], { plan: PLAN });
  assert.strictEqual(absent.selfReported.verdicts, 0);
  assert.strictEqual(absent.totalUsd, 750);
  assert.strictEqual(absent.charges.length, 1, 'aucune ligne de surplus sur un compte non declare');
  assert.deepStrictEqual(meterUsage([], { plan: PLAN, verdictCount: null }), absent, 'null = absent');
});

t('mergePlan: les champs absents prennent le defaut, y compris l illimite', () => {
  assert.strictEqual(mergePlan().includedReceipts, Infinity, 'recus illimites par defaut');
  assert.strictEqual(mergePlan({ monthlyBaseUsd: 3000 }).monthlyBaseUsd, 3000);
  assert.strictEqual(mergePlan({ monthlyBaseUsd: 3000 }).verdictOverageUsd, 0.25);
  /* `Infinity` EXPLICITE doit passer: c'est la facon dont ce plan ecrit « illimite », et le helper
   * canonique `ledger.boundStrict` le refuserait — c'est la divergence assumee, elle est epinglee ici. */
  assert.strictEqual(mergePlan({ includedReceipts: Infinity }).includedReceipts, Infinity);
  assert.strictEqual(mergePlan({ includedVerdicts: Infinity }).includedVerdicts, Infinity);
  /* ⛔ Et l'infini n'est PAS autorise partout: un abonnement « infini » est un prix, pas une borne. */
  refuse(() => mergePlan({ monthlyBaseUsd: Infinity }), 'plan.monthlyBaseUsd', 'un PRIX infini est refuse');
});

/* ── BORNE 2: UN CHIFFRE PRESENT ET ILLISIBLE EST REFUSE, JAMAIS COERCE ─────────────────────────── */

t('verdictCount illisible ne devient plus « zero verdict rendu »', () => {
  refuse(() => meterUsage([], { plan: PLAN, verdictCount: '6,000' }), 'verdictCount', 'separateur de milliers');
  refuse(() => meterUsage([], { plan: PLAN, verdictCount: {} }), 'verdictCount', 'objet');
  refuse(() => meterUsage([], { plan: PLAN, verdictCount: 'beaucoup' }), 'verdictCount', 'texte');
  refuse(() => meterUsage([], { plan: PLAN, verdictCount: NaN }), 'verdictCount', 'NaN');
  refuse(() => meterUsage([], { plan: PLAN, verdictCount: [] }), 'verdictCount', 'tableau vide (Number([]) = 0)');
  refuse(() => meterUsage([], { plan: PLAN, verdictCount: '' }), 'verdictCount', 'chaine vide (Number("") = 0)');
});

t('verdictCount NEGATIF est refuse — ce n est pas un compte bas, c est un rapport malforme', () => {
  refuse(() => meterUsage([], { plan: PLAN, verdictCount: -5 }), 'verdictCount', 'negatif');
  refuse(() => meterUsage([], { plan: PLAN, verdictCount: '-1' }), 'verdictCount', 'negatif en chaine');
});

t('chaque champ de prix du plan refuse separement, et le refus NOMME le champ', () => {
  for (const champ of ['monthlyBaseUsd', 'includedVerdicts', 'verdictOverageUsd', 'includedReceipts', 'receiptOverageUsd']) {
    refuse(() => meterUsage([], { plan: { ...PLAN, [champ]: 'illisible' }, verdictCount: 10 }),
      'plan.' + champ, champ + ' illisible');
    refuse(() => meterUsage([], { plan: { ...PLAN, [champ]: NaN }, verdictCount: 10 }),
      'plan.' + champ, champ + ' a NaN');
  }
});

/* ── LE POINT DE DEPART DU DEFAUT: TROIS ENTREES RENDAIENT LA MEME FACTURE ──────────────────────── */

t('l illisible n est plus indiscernable du « zero declare » — c etait le defaut', () => {
  const zero = meterUsage([], { plan: PLAN, verdictCount: 0 });
  assert.strictEqual(zero.totalUsd, 750, 'zero DECLARE reste une reponse, pas un refus');
  /* Avant le correctif, la ligne suivante rendait `zero` octet pour octet. */
  refuse(() => meterUsage([], { plan: PLAN, verdictCount: '6,000' }), 'verdictCount',
    'l illisible doit sortir par un autre chemin que le zero declare');
});

t('NaN ne traverse plus AUCUNE borne: le surplus ne peut plus disparaitre en silence', () => {
  /* Le mecanisme exact: Math.max(0, 6000 - NaN) vaut NaN, et `NaN > 0` est faux, donc la ligne de
   * surplus n etait simplement pas poussee. Le total tombait de $1000 a $750 sans un mot. */
  refuse(() => meterUsage([], { plan: { ...PLAN, includedVerdicts: 'cinq mille' }, verdictCount: 6000 }),
    'plan.includedVerdicts', 'la borne illisible ne peut plus effacer le surplus');
  /* Et l abonnement ne peut plus etre facture a zero par round2(NaN). */
  refuse(() => meterUsage([], { plan: { ...PLAN, monthlyBaseUsd: 'sept cents' }, verdictCount: 6000 }),
    'plan.monthlyBaseUsd', 'l abonnement illisible ne peut plus se facturer $0');
});

/* ── PAR LE VRAI PRODUCTEUR: `till_meter` en -32602, pas un objet litteral ──────────────────────── */

(async () => {
  await tA('callTool(till_meter) facture toujours le cas valide a l identique', async () => {
    const j = await callTool('till_meter', { receipts: [], plan: PLAN, verdictCount: 6000 });
    assert.strictEqual(j.totalUsd, 1000);
    assert.strictEqual(j.selfReported.verdicts, 6000);
  });

  await tA('callTool(till_meter) refuse un chiffre illisible en NOMMANT le champ (invalidParams → -32602)', async () => {
    for (const [args, champ] of [
      [{ verdictCount: '6,000' }, 'verdictCount'],
      [{ plan: { ...PLAN, monthlyBaseUsd: 'sept cents' }, verdictCount: 10 }, 'plan.monthlyBaseUsd'],
      [{ plan: { ...PLAN, includedVerdicts: 'cinq mille' }, verdictCount: 10 }, 'plan.includedVerdicts'],
    ]) {
      let jete = null;
      try { await callTool('till_meter', { receipts: [], plan: PLAN, ...args }); } catch (e) { jete = e; }
      assert.ok(jete, 'till_meter devait refuser ' + champ);
      assert.strictEqual(jete.invalidParams, true, champ + ': sans ce drapeau le serveur rend un -32603 muet');
      assert.ok(jete.message.includes(champ), champ + ' doit etre nomme — recu: ' + jete.message);
    }
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
