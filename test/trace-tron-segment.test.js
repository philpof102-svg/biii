#!/usr/bin/env node
'use strict';
/**
 * Une adresse fournie par un LLM entrait BRUTE dans l'URL d'un hote tiers.
 * ========================================================================
 * `followTron` construisait `TRONGRID + '/v1/accounts/' + current`, et l'appelant MCP
 * (`till_trace_theft`) ne verifiait que la PRESENCE du champ — jamais sa forme. Mesure du
 * 2026-08-15, hors ligne via le `lireJson` injectable:
 *
 *   '../../wallet/generateaddress' -> .../v1/accounts/../../wallet/generateaddress
 *   'TABC?limit=9999&secret=1'     -> .../accounts/TABC?limit=9999&secret=1
 *                                     puis .../TABC?limit=9999&secret=1/transactions?limit=40
 *   'TABC#frag'                    -> le fragment TRONQUE tout ce qui suit
 *   'T ABC'                        -> une espace crue dans une URL
 *
 * 🔴 LES DEUX DU MILIEU SONT LES PIRES, ET PAS POUR LA RAISON EVIDENTE. Le segment `/transactions`
 * se retrouve AVALE par la query (ou coupe par le `#`), donc c'est l'endpoint COMPTE qui repond
 * pendant que le code croit lire des TRANSACTIONS. `txsLues` vaut alors true sur le mauvais contenu,
 * la boucle ne voit aucune sortie, et l'adresse est rapportee comme TERMINUS — c'est-a-dire comme la
 * destination des fonds. Le module ecrit lui-meme qu'un faux terminus est « le defaut le plus couteux
 * du module », et il a servi sur un vol reel.
 *
 * ⚖️ Valider ne coute RIEN a une entree legitime: une adresse TRON est du base58 (ni 0, ni O, ni I,
 * ni l), 34 caracteres, commencant par T — deja sur-safe pour une URL. C'est exactement ce que fait
 * `classifyB20` (`not a well-formed address`) depuis toujours: la convention de la maison.
 *
 * ⚖️ BORNES. Zero reseau: `lireJson` est injecte, aucune requete ne part vers TronGrid. Ce fichier ne
 * dit rien de la JUSTESSE d'une trace — seulement que rien ne part sur une valeur qui n'est pas une
 * adresse, et qu'un saut refuse ne se lit jamais comme une destination.
 */
const assert = require('node:assert');
const T = require('../lib/trace.js');

let pass = 0; let fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const ta = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('trace tron — ce qui entre dans l URL:');

const VALIDE = 'TJRabPVfqLuNsCfBRuGjRGVvkFqZDoWTHu';
const HOSTILES = ['../../wallet/generateaddress', 'TABC?limit=9999&secret=1', 'TABC#frag', 'T ABC',
  '', null, undefined, 42, 'TJRabPVfqLuNsCfBRuGjRGVvkFqZDoWTH', 'XJRabPVfqLuNsCfBRuGjRGVvkFqZDoWTHu'];

/* Stub: note l URL demandee, rend un compte LU sans aucune transaction sortante. */
function mouchard(reponses) {
  const vues = [];
  /* ⚠️ `(reponses && reponses(url)) || defaut` avalait le `null` que ce stub doit pouvoir rendre pour
   * simuler une lecture RATEE — le defaut le reprenait, et « illisible » devenait « lu et vide ».
   * C'est exactement le motif que ce fichier teste, commis dans son propre outil de mesure. */
  const lire = async (url) => {
    vues.push(url);
    if (!reponses) return { data: [{ balance: 0 }] };
    return reponses(url);
  };
  return { vues, lire };
}

(async () => {
  await ta('TEMOIN: une adresse valide produit exactement les deux URLs attendues', async () => {
    const m = mouchard();
    await T.followTron(VALIDE, { maxHops: 1, lireJson: m.lire });
    assert.deepStrictEqual(m.vues, [
      'https://api.trongrid.io/v1/accounts/' + VALIDE,
      'https://api.trongrid.io/v1/accounts/' + VALIDE + '/transactions?limit=40',
    ], 'une entree legitime ne doit RIEN changer — sinon la validation aurait un cout');
  });

  await ta('★ aucune valeur non conforme ne declenche la moindre requete', async () => {
    const partis = [];
    for (const h of HOSTILES) {
      const m = mouchard();
      const r = await T.followTron(h, { maxHops: 2, lireJson: m.lire });
      if (m.vues.length) partis.push(JSON.stringify(h) + ' -> ' + m.vues[0]);
      assert.strictEqual(r.stoppedBecause, 'not_an_address', 'et le refus doit se NOMMER, pour ' + JSON.stringify(h));
      assert.deepStrictEqual(r.hops, [], 'un refus ne produit aucun saut');
    }
    assert.deepEqual(partis, [],
      'requete(s) partie(s) sur une valeur qui n est pas une adresse:\n  ' + partis.join('\n  '));
  });

  await ta('★ le cas qui volait l endpoint: `/transactions` ne peut plus tomber dans la query', async () => {
    const m = mouchard();
    await T.followTron('TABC?limit=9999&secret=1', { maxHops: 1, lireJson: m.lire });
    assert.strictEqual(m.vues.length, 0, 'rien ne part');
    /* Et pour un cas valide, le segment reste bien un SEGMENT. */
    const m2 = mouchard();
    await T.followTron(VALIDE, { maxHops: 1, lireJson: m2.lire });
    const u = new URL(m2.vues[1]);
    assert.ok(u.pathname.endsWith('/transactions'), 'le chemin doit finir par /transactions, vu ' + u.pathname);
    assert.strictEqual(u.searchParams.get('limit'), '40', 'et limit doit valoir 40, pas une valeur d appelant');
  });

  await ta('★ un SAUT nomme par une reponse hostile arrete la piste, sans fabriquer de terminus', async () => {
    /* Le saut suivant vient d une reponse d API, pas de l appelant: il doit se revalider. */
    const m = mouchard((url) => url.endsWith('/transactions?limit=40') ? { data: [{
      block_timestamp: 1_780_000_000_000,
      raw_data: { contract: [{ type: 'TransferContract', parameter: { value: {
        /* Le sens est decide en comparant owner_address a tronToHex(current): un hex arbitraire
         * donnait une transaction ENTRANTE, donc zero sortie, donc `no_outbound` — mon montage
         * mesurait autre chose que ce qu il annoncait. On passe par le convertisseur du module. */
        amount: 5_000_000, owner_address: T.tronToHex(VALIDE), to_address: 'PAS_UNE_ADRESSE' } } }] },
    }] } : { data: [{ balance: 1_000_000 }] });
    const r = await T.followTron(VALIDE, { maxHops: 3, lireJson: m.lire });
    assert.notStrictEqual(r.stoppedBecause, 'no_outbound',
      'une sortie EXISTE: s arreter en disant « pas de sortie » designerait cette adresse comme destination');
    assert.ok(['hop_not_an_address', 'next_hop_unreadable', 'unread'].includes(r.stoppedBecause),
      'l arret doit se nommer, vu ' + r.stoppedBecause);
    for (const u of m.vues) {
      assert.ok(!/PAS_UNE_ADRESSE/.test(u), 'aucune URL ne doit porter la valeur non conforme: ' + u);
    }
  });

  await ta('CAS OPPOSE: les arrets honnetes du module marchent toujours', async () => {
    /* Sans ceci, un correctif qui refuserait TOUT passerait les tests precedents. */
    const m = mouchard();
    const r = await T.followTron(VALIDE, { maxHops: 1, lireJson: m.lire });
    assert.strictEqual(r.hops.length, 1, 'une adresse valide doit produire son saut');
    assert.ok(r.stoppedBecause, 'et l arret doit toujours porter une raison, vu ' + JSON.stringify(r.stoppedBecause));
    /* Une lecture RATEE reste une non-lecture, jamais un terminus. */
    const m2 = mouchard((url) => url.endsWith('/transactions?limit=40') ? null : { data: [{ balance: 0 }] });
    const r2 = await T.followTron(VALIDE, { maxHops: 1, lireJson: m2.lire });
    assert.strictEqual(r2.stoppedBecause, 'unread', 'une non-lecture ne fabrique pas de destination');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
