#!/usr/bin/env node
'use strict';
/**
 * recovery — the tool for the SECOND theft, at 33 % coverage until today.
 *
 * WHY THIS ONE MATTERS MORE THAN ITS SIZE
 * Every other module here tries to stop a first loss. This one runs after it, when the victim is already
 * findable — a drained wallet is a public lead, and there is a market for leads. A false negative here does
 * not cost someone a bad trade; it costs a person who has already lost money the rest of what they have.
 *
 * WHAT MAKES IT ANSWERABLE WITH CERTAINTY
 * The ask itself is the tell. Recovering stolen funds happens through the thief returning them, or a court,
 * an exchange, or a token issuer freezing and reassigning them. NONE of those routes requires anything from
 * the victim's wallet. So a "recovery" needing a signature or an upfront fee is not a service that might be
 * dishonest — it is structurally impossible as described. That is a fact about custody, not a probability,
 * and it holds however credible the person sounds.
 *
 * THE PROPERTY THESE TESTS DEFEND ABOVE ALL
 * This tool must NEVER return anything a frightened person could read as "safe". Absence of evidence is the
 * normal state here: operations use FRESH addresses precisely because a fresh address has no history to
 * incriminate it. An empty chain read must never soften the verdict.
 *
 * No network: the three explorer calls are injected via fetchImpl.
 */
const assert = require('node:assert');
const { assessRecoveryOffer, HARD_RULES, MANY_SENDERS, FUNNEL_RATIO } = require('../lib/recovery.js');

let pass = 0, fail = 0;
const t = (name, fn) => fn().then(() => { pass++; console.log('  ok   ' + name); })
  .catch((e) => { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); });

const ADDR = '0x' + 'a1'.repeat(20);
const ETH = (n) => String(Math.round(n * 1e18));

/** Un explorateur simule: 3 appels dans l'ordre — entrants, sortants, infos d'adresse. */
function explorateur({ ins = [], outs = [], info = {} } = {}) {
  return async (url) => {
    if (/filter=to/.test(url)) return { items: ins };
    if (/filter=from/.test(url)) return { items: outs };
    return info;
  };
}
const entrant = (from, eth) => ({ from: { hash: from }, value: ETH(eth) });
const sortant = (eth) => ({ to: { hash: '0x' + 'ff'.repeat(20) }, value: ETH(eth) });

(async () => {
  console.log('recovery: la demande EST le signe — pas un score, une certitude');

  await t('demander une SIGNATURE est fatal, meme sans aucune donnee chaine', async () => {
    /* Le point central du module: la regle decide SEULE, sans que l adresse ait la moindre histoire.
     * C est ce qui la rend utile contre une operation qui vient d ouvrir un wallet neuf. */
    const r = await assessRecoveryOffer({ asksForSignature: true });
    assert.equal(r.verdict, 'fraud');
    assert.equal(r.fatal.length, 1);
    assert.match(r.reason, /cannot pull funds back/i, 'la raison doit expliquer POURQUOI c est impossible');
    assert.equal(r.chainEvidence, null, 'aucune adresse fournie: aucune preuve chaine, et ca ne change rien');
  });

  await t('demander des FRAIS D AVANCE est fatal', async () => {
    const r = await assessRecoveryOffer({ asksForUpfrontPayment: true });
    assert.equal(r.verdict, 'fraud');
    assert.match(r.reason, /bills the victim in advance/i);
  });

  await t('demander une SEED ou une CLE est fatal, et nomme ce que c est', async () => {
    const r = await assessRecoveryOffer({ asksForSeedOrKey: true });
    assert.equal(r.verdict, 'fraud');
    assert.match(r.reason, /theft itself, restated as help/i,
      'la formulation doit dire que c est le vol lui-meme, pas juste un risque');
  });

  await t('demander d INSTALLER quelque chose est fatal — la seconde compromission', async () => {
    const r = await assessRecoveryOffer({ asksToInstall: true });
    assert.equal(r.verdict, 'fraud');
    assert.match(r.reason, /second time/i);
  });

  await t('les quatre demandes ensemble restent fraud, et les QUATRE sont listees', async () => {
    /* Le verdict ne peut pas monter plus haut que fraud, mais la victime doit voir les quatre raisons:
     * elle en reconnaitra peut-etre une qu elle n avait pas identifiee comme un probleme. */
    const r = await assessRecoveryOffer({ asksForSignature: true, asksForUpfrontPayment: true,
      asksForSeedOrKey: true, asksToInstall: true });
    assert.equal(r.verdict, 'fraud');
    assert.equal(r.fatal.length, 4, 'aucune raison ne doit etre avalee par les autres');
  });

  console.log('\nle chiffre ne peut JAMAIS blanchir: rien de conclusif != rassurant');

  await t('une adresse VIERGE ne produit aucun soulagement', async () => {
    /* Le piege exact que les operations exploitent: elles ouvrent un wallet neuf. Si le vide se lisait
     * comme un bon signe, l outil recompenserait la methode qu il doit denoncer. */
    const r = await assessRecoveryOffer({ address: ADDR, fetchImpl: explorateur({}) });
    assert.equal(r.verdict, 'unverified', 'jamais "safe", jamais "clean"');
    assert.match(r.reason, /NOT a clearance/i, 'la sortie doit dire explicitement que ce n est pas un feu vert');
    assert.match(r.chainEvidence.note, /Absence of a pattern is NOT evidence of legitimacy/i);
    assert.equal(r.chainEvidence.readsAsHarvesting, false);
  });

  await t('aucun verdict du module n est jamais "safe" — balaye sur toutes les combinaisons', async () => {
    /* L invariant de survie de ce fichier. Balaye plutot que teste sur trois cas: une branche rassurante
     * ajoutee par megarde se cacherait dans la combinaison qu on n aurait pas ecrite. */
    const vus = new Set();
    for (const sig of [true, false, undefined]) {
      for (const fee of [true, false, undefined]) {
        for (const key of [true, false, undefined]) {
          for (const inst of [true, false, undefined]) {
            for (const adr of [ADDR, undefined]) {
              const r = await assessRecoveryOffer({ address: adr, asksForSignature: sig,
                asksForUpfrontPayment: fee, asksForSeedOrKey: key, asksToInstall: inst,
                fetchImpl: explorateur({}) });
              vus.add(r.verdict);
            }
          }
        }
      }
    }
    assert.deepStrictEqual([...vus].sort(), ['fraud', 'unverified'],
      'seuls fraud et unverified doivent exister ici, jamais un verdict rassurant');
  });

  console.log('\nl entonnoir: beaucoup de payeurs, presque rien qui ressort');

  await t('un entonnoir de collecte est repere — assez de payeurs ET presque aucun retour', async () => {
    const ins = Array.from({ length: MANY_SENDERS }, (_, i) => entrant('0x' + String(i).repeat(40), 1));
    const r = await assessRecoveryOffer({ address: ADDR,
      fetchImpl: explorateur({ ins, outs: [sortant(0.01)] }) });
    assert.equal(r.verdict, 'high_risk');
    assert.equal(r.chainEvidence.readsAsHarvesting, true);
    assert.equal(r.chainEvidence.distinctSenders, MANY_SENDERS);
    assert.match(r.reason, /collection funnel, not a service with clients/i);
  });

  await t('les DEUX conditions sont requises — un seul critere ne suffit pas', async () => {
    // beaucoup de payeurs MAIS l argent ressort: ce n est pas un entonnoir
    const insMany = Array.from({ length: MANY_SENDERS + 3 }, (_, i) => entrant('0x' + String(i).repeat(40), 1));
    const quiRend = await assessRecoveryOffer({ address: ADDR,
      fetchImpl: explorateur({ ins: insMany, outs: [sortant(7)] }) });
    assert.equal(quiRend.chainEvidence.readsAsHarvesting, false, 'l argent ressort: pas un entonnoir');
    assert.equal(quiRend.verdict, 'unverified');

    // un seul payeur ET rien qui ressort: une relation, pas un entonnoir
    const unSeul = await assessRecoveryOffer({ address: ADDR,
      fetchImpl: explorateur({ ins: [entrant('0x' + 'b'.repeat(40), 5)], outs: [] }) });
    assert.equal(unSeul.chainEvidence.readsAsHarvesting, false, 'un payeur unique n est pas un entonnoir');
  });

  await t('le meme payeur repete ne compte QUE POUR UN', async () => {
    /* Sinon un attaquant enverrait cinq fois depuis la meme adresse pour... rien. Mais l inverse compte:
     * une victime seule qui paie en plusieurs fois ne doit pas fabriquer un faux entonnoir non plus. */
    const memeType = Array.from({ length: 8 }, () => entrant('0x' + 'c'.repeat(40), 1));
    const r = await assessRecoveryOffer({ address: ADDR, fetchImpl: explorateur({ ins: memeType, outs: [] }) });
    assert.equal(r.chainEvidence.distinctSenders, 1, 'huit paiements, un seul payeur distinct');
    assert.equal(r.chainEvidence.readsAsHarvesting, false);
  });

  await t('la REGLE bat toujours la chaine — un entonnoir propre reste fraud si la demande est fatale', async () => {
    const r = await assessRecoveryOffer({ address: ADDR, asksForSignature: true,
      fetchImpl: explorateur({ ins: [entrant('0x' + 'd'.repeat(40), 1)], outs: [sortant(1)] }) });
    assert.equal(r.verdict, 'fraud', 'une chaine irreprochable ne rachete pas une demande impossible');
  });

  console.log('\nfail-closed sur la lecture de chaine');

  await t('un explorateur MUET ne fabrique pas de soulagement', async () => {
    const r = await assessRecoveryOffer({ address: ADDR, fetchImpl: async () => null });
    assert.equal(r.verdict, 'unverified');
    assert.equal(r.chainEvidence.readsAsHarvesting, false);
    assert.match(r.reason, /NOT a clearance/i, 'ne rien avoir pu lire ne doit pas se lire comme rien a trouver');
  });

  await t('une chaine non cablee: pas de preuve chaine, et la regle decide seule', async () => {
    const r = await assessRecoveryOffer({ address: ADDR, chain: 'dogecoin', asksForUpfrontPayment: true });
    assert.equal(r.chainEvidence, null);
    assert.equal(r.verdict, 'fraud', 'la regle n a jamais eu besoin de la chaine');
  });

  console.log('\nce que la victime emporte');

  await t('les cinq regles dures sont TOUJOURS jointes, meme quand rien n est fatal', async () => {
    /* Elles servent apres coup: la personne les relira quand la prochaine approche arrivera. */
    const r = await assessRecoveryOffer({});
    assert.equal(r.rules.length, HARD_RULES.length);
    assert.ok(r.rules.length >= 5);
    assert.ok(r.rules.some((x) => /Knowing the details of your theft proves nothing/i.test(x)),
      'la regle qui desamorce la fausse preuve d initie doit etre presente');
  });

  await t('la divulgation dit que l outil ne rend JAMAIS "safe"', async () => {
    const r = await assessRecoveryOffer({});
    assert.match(r.disclosure, /never returns "safe"/i);
    assert.match(r.disclosure, /never through the victim/i, 'et par ou passe une vraie recuperation');
  });

  await t('les seuils sont ceux annonces', async () => {
    assert.equal(MANY_SENDERS, 5);
    assert.ok(FUNNEL_RATIO > 0 && FUNNEL_RATIO < 1, 'une part, pas un multiple');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
