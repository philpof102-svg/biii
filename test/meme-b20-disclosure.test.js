#!/usr/bin/env node
'use strict';
/**
 * « genuine » est le mot le plus rassurant de vetMeme, et il ne disait pas tout.
 *
 * Mesure du 2026-08-04, appel reel: `vetMeme({symbol:'STEAKHOUSE B20', chainId:'base'})` rend
 * `genuine` sur `0xb200…d3cB2Af1e481a8B072`, raison « one contract dominates », rien de plus. Ce
 * contrat est un B20 NATIF: son EMETTEUR peut geler et bruler le solde de n'importe quel porteur au
 * niveau du standard — plus fort qu'une mise a jour de proxy, et invisible a tout scanner ERC-20.
 *
 * ⚠️ CE QUE LA MESURE A TUE EN CHEMIN, et qui compte autant. L'hypothese de depart etait que vetMeme
 * raterait les B20 ou couronnerait un imposteur. Sur les six natifs vivants les plus liquides, aucune
 * reponse ne designe un autre contrat que celui interroge; les cinq `thin` sont CORRECTS, leur
 * liquidite est nulle depuis des jours. La premiere lecture les croyait vivants parce qu'elle
 * comparait une requete LIVE au champ `lastLiq`, qui est la liquidite AU DERNIER PASSAGE. Le defaut
 * reel est donc une DIVULGATION manquante sur un verdict positif, pas une erreur d'aiguillage.
 *
 * Ces cas sont purs: `classifyB20` est injecte, aucun reseau.
 */
const assert = require('node:assert');
const { annoterNatifB20 } = require('../lib/meme.js');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const NATIF = '0xb200000000000000000000d3cB2Af1e481a8B072';
const ORDINAIRE = '0x4ed4e862860bed51a9570b96d89af5e1b0efefed';
const base = (addr) => ({ status: 'genuine', reason: 'one contract dominates', canonical: { address: addr } });
const classifieur = (verdict, extra = {}) => async () => ({ verdict, ...extra });

async function main() {
  console.log('vetMeme: un verdict « genuine » sur un B20 natif doit dire le pouvoir de l\'emetteur');

  await t('★ natif -> la note NOMME le pouvoir, et le verdict ne bouge pas', async () => {
    const r = await annoterNatifB20(base(NATIF), { chainId: 'base', classifyImpl: classifieur('native_b20') });
    assert.strictEqual(r.nativeB20, true);
    assert.strictEqual(r.b20Check, 'ok');
    assert.ok(/freeze-and-burn/i.test(r.b20Note || ''), 'la note doit nommer le pouvoir: ' + r.b20Note);
    assert.ok(/precompile/i.test(r.b20Note || ''), 'et dire pourquoi les controles ERC-20 ne s appliquent pas');
    // ⛔ Un B20 authentique reste authentique: sa nature n'est pas une accusation.
    assert.strictEqual(r.status, 'genuine', 'le verdict NE DOIT PAS bouger');
    assert.strictEqual(r.reason, 'one contract dominates', 'ni la raison d origine');
  });

  await t('★ imposteur de prefixe -> dit qu il n EST PAS un B20', async () => {
    const r = await annoterNatifB20(base(NATIF), { chainId: 'base', classifyImpl: classifieur('prefix_impostor', { codeBytes: 4509 }) });
    assert.strictEqual(r.nativeB20, false);
    assert.ok(/is NOT a B20/i.test(r.b20Note || ''), r.b20Note);
    assert.ok(/4509/.test(r.b20Note || ''), 'la taille lue doit voyager, c est la preuve');
  });

  await t('★ classement NON CONCLUANT -> se dit, au lieu de disparaitre', async () => {
    const r = await annoterNatifB20(base(NATIF), { chainId: 'base', classifyImpl: classifieur('unknown') });
    assert.strictEqual(r.b20Check, 'unread');
    assert.notStrictEqual(r.nativeB20, true, 'on ne classe pas ce qu on n a pas lu');
    assert.ok(/not a clearance/i.test(r.b20Note || ''), 'et l absence de lecture n est pas un feu vert');
  });

  await t('un classifieur qui JETTE tombe dans le meme etat « non lu »', async () => {
    const r = await annoterNatifB20(base(NATIF), { chainId: 'base', classifyImpl: async () => { throw new Error('rpc down'); } });
    assert.strictEqual(r.b20Check, 'unread');
    assert.notStrictEqual(r.nativeB20, true);
  });

  /* Les cas OPPOSES. Sans eux, une annotation posee sur TOUT passerait les cas ci-dessus et
   * n'informerait plus de rien. On verifie aussi qu'aucune cle n'est AJOUTEE — un champ `b20Check`
   * sur un token ordinaire ferait croire qu'un controle B20 a eu lieu. */
  await t('★ adresse ordinaire -> aucun appel, aucune cle ajoutee', async () => {
    let appele = false;
    const r = await annoterNatifB20(base(ORDINAIRE), { chainId: 'base', classifyImpl: async () => { appele = true; return { verdict: 'native_b20' }; } });
    assert.strictEqual(appele, false, 'le prefiltre par prefixe doit eviter tout appel reseau');
    assert.strictEqual(r.b20Check, undefined, 'aucune cle ne doit apparaitre sur un token ordinaire');
    assert.strictEqual(r.nativeB20, undefined);
  });

  await t('hors Base, le prefixe n est qu une adresse qui commence pareil', async () => {
    let appele = false;
    const r = await annoterNatifB20(base(NATIF), { chainId: 'solana', classifyImpl: async () => { appele = true; return { verdict: 'native_b20' }; } });
    assert.strictEqual(appele, false);
    assert.strictEqual(r.nativeB20, undefined);
  });

  await t('sans canonique (thin/ambiguous), rien n est annote', async () => {
    const r = await annoterNatifB20({ status: 'thin', canonical: null }, { chainId: 'base', classifyImpl: classifieur('native_b20') });
    assert.strictEqual(r.b20Check, undefined);
    assert.strictEqual(r.status, 'thin');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
