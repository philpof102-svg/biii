#!/usr/bin/env node
'use strict';
/**
 * UN MONTANT ILLISIBLE EST-IL DIT — SUR LES TROIS ROUTES, ET JUSQU'A L'APPELANT ?
 * ================================================================================================
 * Le jumeau exact de test/undated-receipts-disclosed.test.js, du cote de l'ARGENT. Le defaut mesure le
 * 2026-08-17 a travers le PRODUCTEUR (`appendReceipt`), pas une fixture:
 *
 *   temoin: deux recus a 10.00 .......... count=2  gross=20.00  undatedExcluded=0
 *   un a 10, un SANS amountMicro ........ count=2  gross=10.00  undatedExcluded=0
 *   un a 10, un a ZERO REEL ............. count=2  gross=10.00  undatedExcluded=0
 *   un a 10, un amountMicro NEGATIF ..... count=2  gross= 5.00  undatedExcluded=0
 *
 * Les deux lignes du milieu etaient identiques OCTET POUR OCTET, divulgation comprise: un montant qu'on
 * n'a pas su lire et une vente honnete a 0.00 rendaient les MEMES livres — avec `undatedExcluded: 0` qui
 * AFFIRME par-dessus que rien n'a ete tu. La derniere etait pire qu'une omission: un montant negatif
 * SOUSTRAYAIT du total prouvable, donc une seule ligne malformee pouvait effacer une vente reelle.
 *
 * ⚠️ LA BORNE BASSE EST LA MOITIE DU TEST. Un recu valant honnetement 0.00 ne doit RIEN declencher —
 * sans ce cas, « tout avertir » passerait, et un avertissement permanent n'informe plus (une divulgation
 * a variance nulle est une decoration). §A l'epingle dans les deux sens.
 *
 * ⛔ Aucun reseau: les recus sont des objets, aucun RPC n'est touche.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../lib/ledger.js');
const X = require('../lib/export.js');
const { meterUsage } = require('../lib/meter.js');
const { callTool, TOOLS } = require('../bin/biii-mcp.js');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const recu = (h, over = {}) => ({
  v: 1, kind: 'basetill-receipt',
  merchant: { name: 'M', address: '0x' + '11'.repeat(20) },
  amountUsd: '10.00', amountMicro: '10000000', paidMicro: '10000000', overpaidMicro: '0',
  token: 'USDC', chainId: 8453, txHash: '0x' + String(h).repeat(64), payer: '0x' + 'ee'.repeat(20),
  tier: 'confirmed', blockTime: 1_752_003_600, ...over,
});

// Le registre passe par le PRODUCTEUR: un test qui fabrique ses lignes ne prouve pas qu'elles existent.
const livre = (receipts) => {
  let rows = [];
  for (const r of receipts) { const res = L.appendReceipt(rows, r); if (res.entry) rows = res.rows; }
  return rows;
};

const BON = recu(1);
const SANS_MONTANT = recu(2, { paidMicro: undefined, amountMicro: undefined, amountUsd: undefined });
const ZERO_REEL = recu(3, { paidMicro: '0', amountMicro: '0', amountUsd: '0.00' });
const NEGATIF = recu(4, { paidMicro: '-5000000', amountMicro: '-5000000' });
const PAS_ENTIER = recu(5, { paidMicro: '1.5', amountMicro: '1.5' });

async function main() {
  console.log('unreadable amounts: un montant illisible est-il DIT, et distingue d un zero REEL ?');

  // ══ A. LES TROIS MODULES + LES DEUX BORNES ══════════════════════════════════════════════════
  console.log('\n  A. les trois modules ou vivait la coercition');

  await t('ledger.summary — le montant absent n est PAS somme, et il est COMPTE', () => {
    const s = L.summary(livre([BON, SANS_MONTANT]));
    assert.strictEqual(s.grossUsd, '10.00', 'le montant illisible ne s ajoute pas');
    assert.strictEqual(s.unreadableAmounts, 1, 'et il est SIGNALE, pas escamote');
    assert.strictEqual(s.count, 2, 'la ligne reste un recu: elle existe, on ne sait juste pas la totaliser');
  });

  await t('★ LA BORNE BASSE — un recu valant honnetement 0.00 ne declenche RIEN', () => {
    const s = L.summary(livre([BON, ZERO_REEL]));
    assert.strictEqual(s.grossUsd, '10.00');
    assert.strictEqual(s.unreadableAmounts, 0,
      'zero LU est une mesure, pas une absence — sinon la divulgation crierait sur des livres corrects');
  });

  await t('★ LES DEUX CAS SE DISTINGUENT — c est tout le defaut, en une assertion', () => {
    const illisible = L.summary(livre([BON, SANS_MONTANT]));
    const zero = L.summary(livre([BON, ZERO_REEL]));
    assert.strictEqual(illisible.grossUsd, zero.grossUsd, 'le total reste le meme (10.00) dans les deux cas');
    assert.notStrictEqual(illisible.unreadableAmounts, zero.unreadableAmounts,
      'donc SEUL ce compteur separe « je n ai pas su lire » de « il vaut zero ». Sans lui les deux jeux de '
      + 'livres sont identiques octet pour octet, et une absence devient une affirmation.');
  });

  await t('un montant NEGATIF ne SOUSTRAIT plus du total prouvable', () => {
    const s = L.summary(livre([BON, NEGATIF]));
    assert.strictEqual(s.grossUsd, '10.00',
      'un negatif retranchait 5.00: une ligne malformee pouvait effacer une vente reelle');
    assert.strictEqual(s.unreadableAmounts, 1);
  });

  await t('un montant NON ENTIER ne fait plus jeter BigInt au travers de TOUS les livres', () => {
    const s = L.summary(livre([BON, PAS_ENTIER]));   // jetait « Cannot convert 1.5 to a BigInt »
    assert.strictEqual(s.grossUsd, '10.00');
    assert.strictEqual(s.unreadableAmounts, 1, 'une ligne fautive se dit, elle n emporte pas le rapport');
  });

  await t('export.buildExport — la cellule dit UNREADABLE, et la projection relaie le compte', () => {
    const ex = X.buildExport(livre([BON, SANS_MONTANT]), {});
    /* ⚠️ LA LIGNE OU LA CORRECTION SERAIT MORTE: buildExport recopie summary champ par champ. */
    assert.strictEqual(ex.summary.unreadableAmounts, 1,
      'la projection doit relayer le champ — sinon il est produit et n atteint AUCUN appelant');
    assert.ok(/UNREADABLE/.test(ex.csv),
      'la cellule comptable ne doit pas afficher 0.00 pour un montant absent — QuickBooks l importerait');
    assert.ok(/unreadable amount/i.test(ex.disclosure), 'et la divulgation doit le dire en clair');
  });

  await t('meter.meterUsage — le volume PROUVABLE le dit aussi', () => {
    const m = meterUsage(livre([BON, NEGATIF]), { plan: { includedReceipts: 0, receiptOverageUsd: 1, monthlyBaseUsd: 0 } });
    assert.strictEqual(m.provable.settledVolumeUsd, '10.00', 'le negatif ne retranche pas du volume');
    assert.strictEqual(m.provable.unreadableAmounts, 1);
    assert.ok(/unreadable amount/i.test(m.disclosure));
  });

  await t('renderRoll — l avertissement est SUR le document, EN et FR', () => {
    const rows = livre([BON, SANS_MONTANT]);
    const en = L.renderRoll(rows, { merchantName: 'M' });
    assert.ok(/unreadable amount/i.test(en), 'en:\n' + en);
    /* ⚠️ ASSERTER SUR LA LIGNE, PAS SUR LE DOCUMENT. Une mutation qui retirait `UNREADABLE` de la ligne
     * a SURVECU a `/UNREADABLE/.test(en)`: la phrase de divulgation contient elle aussi le mot, donc le
     * document restait vert alors que la ligne reaffichait un montant que le total n avait pas somme.
     * C etait un trou dans CE test, pas un code correct — on vise donc la ligne du recu fautif. */
    const ligne = en.split('\n').find((l) => l.includes('B3-0002'));
    assert.ok(ligne, 'la ligne du recu illisible doit exister dans le document:\n' + en);
    assert.ok(/UNREADABLE/.test(ligne), 'la LIGNE doit le dire, sinon elle affiche un montant non somme: ' + ligne);
    assert.ok(!/\d+\.\d\d USDC/.test(ligne), 'et elle ne doit surtout pas afficher un chiffre credible: ' + ligne);
    const fr = L.renderRoll(rows, { merchantName: 'M', lang: 'fr' });
    assert.ok(/montant ILLISIBLE/i.test(fr), 'la version FR doit avertir aussi:\n' + fr);
  });

  await t('renderRoll — des livres entierement lisibles ne portent AUCUN avertissement', () => {
    const propre = L.renderRoll(livre([BON, ZERO_REEL]), { merchantName: 'M' });
    assert.ok(!/unreadable/i.test(propre),
      'sinon l avertissement est constant, donc il n observe rien:\n' + propre);
  });

  // ══ B. JUSQU'A L'APPELANT — le whitelist MCP ════════════════════════════════════════════════
  console.log('\n  B. la distinction atteint-elle l agent au bout du fil ?');

  await t('callTool(till_roll) porte le compte ET le dit', async () => {
    const out = await callTool('till_roll', { receipts: [BON, SANS_MONTANT], merchantName: 'M' });
    assert.strictEqual(out.summary.unreadableAmounts, 1, 'le champ doit traverser le whitelist');
    assert.strictEqual(out.summary.grossUsd, '10.00');
  });

  await t('callTool(till_export) le dit dans la note — ce qu un appelant lit en premier', async () => {
    const out = await callTool('till_export', { receipts: [BON, SANS_MONTANT] });
    assert.strictEqual(out.summary.unreadableAmounts, 1);
    assert.ok(/UNREADABLE amount/i.test(out.note), 'note: ' + out.note);
  });

  await t('callTool(till_meter) nomme le SENS de l erreur (UNDER-stated)', async () => {
    const out = await callTool('till_meter', { receipts: [BON, NEGATIF] });
    assert.strictEqual(out.provable.unreadableAmounts, 1);
    assert.ok(/UNDER-stated/i.test(out.note), 'la note doit dire de quel cote le chiffre penche: ' + out.note);
  });

  await t('les descriptions d outils ENUMERENT la regle — sinon elle n existe pas pour l agent', () => {
    for (const nom of ['till_export', 'till_meter']) {
      const d = (TOOLS.find((x) => x.name === nom) || {}).description || '';
      assert.ok(/unreadableAmounts/.test(d), `${nom} doit nommer le champ dans sa description`);
      assert.ok(/not an amount of zero|not summed|NOT added/i.test(d),
        `${nom} doit expliquer POURQUOI un montant illisible n est pas un zero`);
    }
  });

  // ══ C. LA GARDE ANTI-DIVERGENCE ═════════════════════════════════════════════════════════════
  console.log('\n  C. la coercition peut-elle repousser quelque part ?');

  await t('★ aucune copie de la coalescence `.<champ>Micro || …` ne subsiste dans lib/', () => {
    const dir = path.join(__dirname, '..', 'lib');
    const fautifs = [];
    let lus = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      lus += 1;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // On enleve les commentaires: ces fichiers CITENT la coercition pour expliquer pourquoi elle est
      // partie, et une citation ne doit pas faire echouer la garde.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\.(?:paidMicro|amountMicro|overpaidMicro)\s*\|\|/.test(code)) fautifs.push('lib/' + f);
    }
    // Un garde qui n'a RIEN examine passe au vert: on exige d'avoir lu le corpus.
    assert.ok(lus >= 10, 'garde en panne: seulement ' + lus + ' fichier(s) lus dans lib/');
    assert.deepStrictEqual(fautifs, [],
      'la coercition qui rendait un montant illisible egal a zero est revenue dans: ' + fautifs.join(', ')
      + '. Passer par ledger.amountMicroOf / tipMicroOf — UNE definition, pour qu il n y ait plus de'
      + ' jumelle a diverger.');
  });

  await t('★ les deux modules passent bien par LA lecture partagee (ledger.amountMicroOf)', () => {
    const racine = path.join(__dirname, '..');
    for (const f of ['lib/export.js', 'lib/meter.js']) {
      const src = fs.readFileSync(path.join(racine, f), 'utf8');
      assert.ok(/amountMicroOf/.test(src), f + ' doit lire les montants par la regle partagee, pas par une copie locale');
    }
  });

  await t('microStrict — la lecture elle-meme, cas par cas', () => {
    assert.strictEqual(L.microStrict('10000000'), 10000000n);
    assert.strictEqual(L.microStrict('0'), 0n, 'zero LU est une valeur, pas une absence');
    assert.strictEqual(L.microStrict(5), 5n, 'un nombre est lisible');
    for (const mauvais of [undefined, null, '', '  ', 'abc', '1.5', '-5', '0x10', [], {}, NaN, Infinity]) {
      assert.strictEqual(L.microStrict(mauvais), null, 'doit etre illisible: ' + JSON.stringify(mauvais));
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
