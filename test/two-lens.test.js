'use strict';
// BIII two-lens discipline (LAWBOR verbatim) — reputation is shown as LOCAL (verified here) and ORACLE
// (MainStreet, reported) kept SEPARATE, never merged into one score. The cardinal test: an oracle PROCEED
// can NEVER dilute a local BLOCK. Offline. Run: node test/two-lens.test.js
const assert = require('node:assert');
const LAZARUS = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';   // in data/known-bad.json
const CLEAN = '0x' + '11'.repeat(20);

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

// The oracle enthusiastically says PROCEED for EVERY address — including the sanctioned one.
global.fetch = async (url) => {
  if (String(url).includes('/api/agent/preflight')) return { ok: true, json: async () => ({ decision: 'PROCEED', score: 99 }) };
  throw new Error('unexpected ' + url);
};
const { callTool } = require('../bin/biii-mcp');

(async () => {
  console.log('BIII two-lens — a local BLOCK is never diluted by an oracle PROCEED:');

  await t('THE CARDINAL RULE: Lazarus + oracle says PROCEED(99) → STILL unsafe (local BLOCK is decisive)', async () => {
    const r = await callTool('till_trust', { counterparty: LAZARUS });
    assert.equal(r.triangle.trust, 'unsafe');
    assert.equal(r.triangle.payable, false);
    assert.equal(r.sources.reputation.local.blocked, true);
    // the oracle was NOT consulted (short-circuit) — its PROCEED never even entered the picture
    assert.match(JSON.stringify(r.sources.reputation.oracle), /not consulted|decisive/i);
  });

  await t('the two lenses are SEPARATE fields, never a single merged score', async () => {
    const r = await callTool('till_trust', { counterparty: CLEAN });
    const rep = r.sources.reputation;
    assert.ok(rep.local && typeof rep.local.blocked === 'boolean', 'a distinct local lens');
    assert.ok(rep.oracle, 'a distinct oracle lens');
    assert.match(rep.note, /never merged/i);
    // no combined/overall/score field laundering the two into one
    for (const k of Object.keys(rep)) assert.ok(!/^(combined|merged|overall|score)$/i.test(k), 'no merged field: ' + k);
  });

  await t('a clean address: the oracle lens is CONSULTED and LABELED ORACLE-REPORTED (advisory, not local proof)', async () => {
    const r = await callTool('till_trust', { counterparty: CLEAN });
    assert.equal(r.sources.reputation.oracle.decision, 'PROCEED');
    assert.match(r.sources.reputation.oracle.disclosure, /ORACLE-REPORTED/);
    assert.match(r.sources.reputation.oracle.disclosure, /never overrides the local floor/);
    // and a clean-but-PROCEED address is legitimately trusted (the oracle CAN raise trust; it just can't lower a block)
    assert.equal(r.triangle.trust, 'trusted');
    assert.match(r.sources.reputation.local.disclosure, /overrides any oracle answer/);
  });

  /* ── LE RAIL, CABLE JUSQU'AU TOOL ────────────────────────────────────────────────────────────────
   * `not_observable` a d'abord ete ajoute dans lib/trust.js — et RIEN ne pouvait le produire: aucun
   * appelant ne passait `offChain`. Exactement la faute corrigee le matin meme dans feeder
   * (FRESH_FUNDING_WINDOW_MS defini, exporte, utilise nulle part). Un etat inatteignable n'est pas une
   * capacite, c'est du code mort avec des tests.
   *
   * Ces cas passent donc par le HANDLER, pas par la fonction pure: c'est le maillon qui manquait. */
  await t('★ un rail non temoignable remonte jusqu au verdict du tool', async () => {
    const r = await callTool('till_trust', { counterparty: CLEAN, rail: 'mastercard-agent-pay' });
    const s = r.triangle.vertices.settlement;
    assert.equal(s.status, 'not_observable');
    assert.equal(s.rail, 'mastercard-agent-pay', 'le rail nomme doit revenir au lecteur');
    assert.equal(r.triangle.complete, false, 'un rail invisible rend le triangle incomplet');
    assert.ok(r.triangle.unqueriedVertices.includes('settlement'));
  });

  await t('un rail inconnu vaut NON TEMOIGNABLE, jamais on-chain (fail-closed sur le nom)', async () => {
    /* Une faute de frappe — 'bse' pour 'base' — ne doit pas envoyer chercher sur Base un paiement qui
     * n'y sera pas, puis conclure a un echec. Se tromper dans ce sens dit « je ne peux pas voir ». */
    const r = await callTool('till_trust', { counterparty: CLEAN, rail: 'bse' });
    assert.equal(r.triangle.vertices.settlement.status, 'not_observable');
  });

  await t('« base » reste le rail temoignable, et la casse ne compte pas', async () => {
    /* La borne inverse: si tout devenait non temoignable, BIII perdrait la seule chose qu il sait
     * vraiment prouver. */
    for (const rail of ['base', 'BASE', ' usdc-base ']) {
      const r = await callTool('till_trust', { counterparty: CLEAN, rail });
      assert.notEqual(r.triangle.vertices.settlement.status, 'not_observable',
        'rail ' + JSON.stringify(rail) + ' doit rester le chemin on-chain');
    }
  });

  await t('sans rail, le comportement d avant ne bouge pas', async () => {
    const r = await callTool('till_trust', { counterparty: CLEAN });
    assert.equal(r.triangle.vertices.settlement.status, 'pending',
      'aucun rail nomme = on ne suppose rien de nouveau');
  });

  /* ── AUCUN VERDICT POUR UNE ENTREE QUE LE CRIBLE NE PEUT PAS JUGER ────────────────────────────────
   * lib/server.js:265 rend 400 sur une adresse malformee (« no verdict for a malformed address »); le
   * handler MCP, lui, composait le triangle sur n'importe quelle chaine — la chaine vide comprise, qui
   * partait interroger l'oracle et le noeud LAWBOR a propos de rien.
   *
   * Rien de dangereux n'en sortait (tout tombait unknown / payable:false), MAIS la lentille locale
   * affichait alors available:true, blocked:false, reason:"not a 0x address": un lecteur y lit « liste a
   * jour, pas bloque » quand rien n'a ete crible. `available` decrit la LISTE, `reason` decrit le CRIBLE.
   *
   * Ce cas est ce qui reste d'un champ `screen` ajoute puis retire: une fois l'entree validee, ce champ
   * s'accordait toujours avec `available` — variance nulle. Un test rougit; un champ decoratif, non. */
  await t('aucun verdict n\'est compose pour une entree que le crible ne peut pas juger', async () => {
    for (const cp of ['pas-une-adresse', '0x123', '', '0x' + '1'.repeat(39), '0x' + 'g'.repeat(40)]) {
      const r = await callTool('till_trust', { counterparty: cp });
      assert.ok(r.error, JSON.stringify(cp) + ' devrait etre refuse, pas juge');
      assert.ok(!r.triangle, 'un refus ne doit porter AUCUN triangle — sinon le refus se lit comme un verdict');
    }
    /* Sanity: le refus n'avale pas les entrees valides. Sans ce cas, tout casser passerait pour un fix. */
    const bon = await callTool('till_trust', { counterparty: '0x' + '1'.repeat(40) });
    assert.ok(!bon.error && bon.triangle, 'une adresse valide reste jugee');
    /* La casse majuscule est acceptee: l'entree est minusculisee AVANT le test, donc une adresse a
     * checksum EIP-55 ne se fait pas refuser sur sa casse. */
    const maj = await callTool('till_trust', { counterparty: '0X' + 'A'.repeat(40) });
    assert.ok(!maj.error && maj.triangle, 'une adresse en majuscules reste jugee');
  });

  /* Une panne RPC est un sommet NON LU, pas la fin du triangle. L'appel on-chain etait le seul des trois
   * sans try/catch (l'oracle en a un, le standing aussi), donc un RPC injoignable faisait remonter une
   * exception jusqu'au handler: reponse -32000 « check arguments », et la reputation et le standing DEJA
   * calcules jetes avec. Le module savait se degrader par sommet; le handler ne lui en laissait pas
   * l'occasion. */
  await t('un RPC Base injoignable rend le sommet NON LU — il ne tue pas le triangle', async () => {
    const avant = process.env.BASE_RPC_URL;
    process.env.BASE_RPC_URL = 'http://127.0.0.1:9/dead';
    try {
      const r = await callTool('till_trust', { counterparty: '0x' + '1'.repeat(40), amountMicro: '1000000' });
      assert.ok(r.triangle, 'le triangle doit exister: une panne reseau n\'est pas une erreur d\'argument');
      assert.strictEqual(r.triangle.vertices.settlement.status, 'unqueried');
      /* ⚠️ PAS `failed`. Sans la branche lectrice ajoutee a settlementVertex, cette forme tombait dans le
       * return final et sortait « not paid »: une panne RPC AFFIRMANT l'echec du paiement. */
      assert.notStrictEqual(r.triangle.vertices.settlement.status, 'failed');
      assert.strictEqual(r.triangle.complete, false, 'un sommet non lu rend le triangle incomplet');
      /* ⚠️ AUCUNE assertion sur `payable` ici. Premier jet: `payable === false`. Rouge par intermittence —
       * il depend de l'ORACLE, qui est un appel reseau: oracle injoignable => reputation nulle =>
       * payable false; oracle joignable et favorable => payable true, avec le MEME sommet settlement non
       * lu. Un cas qui bascule pour une raison qui n'est pas le code entraine a ignorer le rouge.
       *
       * Ce que ca met au jour est un CHOIX DE CONCEPTION, pas un defaut: `payable` ne branche pas sur
       * l'ensemble UNREAD — un settlement non lu n'empeche pas un paiement dont la reputation repond,
       * et le triangle le DIT via complete:false. A porter a Phil, pas a modifier en douce ici. */
    } finally {
      if (avant === undefined) delete process.env.BASE_RPC_URL; else process.env.BASE_RPC_URL = avant;
    }
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
