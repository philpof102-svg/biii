'use strict';
/**
 * basetill chain watcher — turns the Base chain into the till's source of truth.
 * =============================================================================
 * One job: find the USDC Transfer that pays a charge, as an immutable FACT the core can
 * verify (lib/till.verifyPayment stays the only judge). Injectable fetch, no key, read-only.
 * RPC discipline from the mainstreet indexer war: default to mainnet.base.org, tolerate
 * rate limits by narrowing ranges, never trust a fact below the requested confirmations.
 */
const { USDC_BASE } = require('./till');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_RPC = 'https://mainnet.base.org';

const hex = (n) => '0x' + BigInt(n).toString(16);
const addrTopic = (a) => '0x' + '0'.repeat(24) + String(a).toLowerCase().slice(2);

async function rpc(url, method, params, f, timeoutMs = 8000) {
  // BOUND the outbound call: a free public RPC that accepts the connection but stalls (rate-limited/overloaded)
  // would otherwise hang /status forever — the PWA polls every 3s, so hung requests pile up instead of the
  // intended fast, honest 502 degrade. Mirrors the AbortSignal.timeout(8000) used in bin/biii-mcp.js.
  const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`rpc ${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

/**
 * ═══ blockTimeOf — LE CHAMP QUE LES LIVRES DU MARCHAND FILTRENT, ET QUE PERSONNE NE PRODUISAIT ═══
 *
 * Ce fichier rendait un `blockNumber` et jamais un `blockTime`. Or `lib/till.receipt` pose
 * `blockTime: Number(fact.blockTime) || null` et les livres (`ledger.summary`, `export`, `meter`)
 * filtrent une fenetre DATEE dessus. Un numero de bloc n'est pas une date: le recu partait donc sans
 * horodatage, et toute fenetre datee le faisait disparaitre des comptes en silence. Mesure du
 * 2026-08-05, a travers le vrai producteur (test/receipt-blocktime-producer.test.js).
 *
 * `eth_getBlockByNumber` porte le `timestamp` (secondes unix) et c'est le seul endroit ou l'aller
 * chercher: le bloc est deja connu, l'appel est UN aller-retour de plus, et uniquement sur la branche
 * ou un paiement a ete trouve — jamais sur les sondages qui ne trouvent rien.
 *
 * ⚠️ FAIL-SOFT, et l'asymetrie est deliberee. Partout ailleurs ce fichier est fail-closed, parce qu'y
 * echouer voudrait dire affirmer un paiement non prouve. Ici le paiement est DEJA prouve quand on
 * demande sa date: une lecture ratee ne doit donc pas retracter un reglement. Elle rend `null`, le recu
 * voyage sans date — et les livres DIVULGUENT desormais cette absence (ledger.summary → undatedExcluded)
 * au lieu de laisser tomber la ligne sans un mot.
 *
 * ⛔ On n'invente jamais: un horodatage illisible vaut `null`. Jamais `Date.now()` (l'heure du lecteur
 * n'est pas celle du bloc), jamais le numero de bloc deguise en secondes.
 */
async function blockTimeOf(rpcUrl, blockNumber, f) {
  try {
    const b = await rpc(rpcUrl, 'eth_getBlockByNumber', [hex(blockNumber), false], f);
    const t = b && b.timestamp != null ? Number(BigInt(b.timestamp)) : NaN;
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch { return null; }
}

/**
 * Look once for a Transfer of ≥ minMicro USDC to `to` since `fromBlock` (or the last ~N
 * blocks). Returns the BEST fact ({txHash, chainId, token, to, from, valueMicro,
 * confirmations, blockNumber, blockTime}) or null. The caller re-polls; we never invent.
 */
async function findPayment({ to, minMicro = '0', fromBlock, lookbackBlocks = 900, excludeTxHashes,
  rpcUrl = process.env.BASE_RPC_URL || DEFAULT_RPC, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(to || ''))) throw new Error('findPayment needs the merchant address');
  // txHashes already applied to ANOTHER charge — so one on-chain transfer can satisfy at most one charge
  // (the two-register / cross-charge false-PAID guard; the server owns this set). Newest UNCONSUMED wins.
  const skip = excludeTxHashes instanceof Set ? excludeTxHashes
    : new Set((excludeTxHashes || []).map((h) => String(h).toLowerCase()));
  const head = BigInt(await rpc(rpcUrl, 'eth_blockNumber', [], f));
  const from = fromBlock != null ? BigInt(fromBlock) : (head > BigInt(lookbackBlocks) ? head - BigInt(lookbackBlocks) : 0n);
  const logs = await rpc(rpcUrl, 'eth_getLogs', [{
    address: USDC_BASE, fromBlock: hex(from), toBlock: 'latest',
    topics: [TRANSFER_TOPIC, null, addrTopic(to)],               // Transfer(*, to=merchant)
  }], f);
  let best = null;
  const want = BigInt(String(minMicro || '0'));
  const toLc = String(to).toLowerCase();
  for (const log of logs || []) {
    try {
      if (!log || !Array.isArray(log.topics) || log.topics.length < 3) continue;  // malformed log — skip
      // VERIFY the log's OWN contract (log.address) is USDC — never trust the RPC's `address` filter alone.
      // A misfiltering/hostile RPC returning a Transfer from a SCAM token (same event signature) to the
      // merchant must NOT be stamped as a USDC payment (the fact hardcodes token:USDC_BASE below).
      if (String(log.address || '').toLowerCase() !== USDC_BASE) continue;
      // VERIFY the log's OWN event signature (topic[0]) — the third dimension of the very RPC filter the
      // checks either side of this one refuse to trust. It was left unverified until 2026-07-28 while the
      // sister function verifyTxHash (below, same file) had always checked it. The collision is exact:
      // USDC's Approval(owner, spender, value) carries the same topic arity and its `data` is also a
      // uint256 amount, so an Approval naming the merchant passed every remaining check and was stamped a
      // payment FACT — "1 USDC received" off an event that moves nothing at all. Proven at runtime against
      // a stubbed misfiltering RPC before the fix; an arbitrary topic0 was accepted just the same.
      if (String(log.topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue;
      // VERIFY the log's OWN recipient (topic[2]) — never trust the RPC's topic filter alone. A misfiltering
      // or hostile RPC returning a Transfer to a DIFFERENT address must NOT be stamped as paid-to-merchant.
      const logTo = ('0x' + String(log.topics[2]).slice(26)).toLowerCase();
      if (logTo !== toLc) continue;
      if (skip.has(String(log.transactionHash || '').toLowerCase())) continue;   // already applied to another charge
      const valueMicro = BigInt(log.data).toString();               // malformed data → throws → caught → skip
      if (BigInt(valueMicro) < want) continue;                      // too small for this charge
      const bn = BigInt(log.blockNumber);
      const fact = {
        txHash: log.transactionHash, chainId: 8453, token: USDC_BASE,
        to: logTo, from: ('0x' + String(log.topics[1]).slice(26)).toLowerCase(),
        valueMicro, blockNumber: Number(bn),
        confirmations: Number(head - bn + 1n),
      };
      if (!best || bn > BigInt(best.blockNumber)) best = fact;     // newest matching transfer wins
    } catch { /* one malformed log can neither crash the poll nor forge a fact */ }
  }
  // La date, une seule fois, pour le SEUL log retenu — et seulement si un paiement a ete trouve. Un
  // sondage qui ne trouve rien ne paie pas cet aller-retour.
  return best ? { ...best, blockTime: await blockTimeOf(rpcUrl, best.blockNumber, f) } : null;
}

/**
 * verifyTxHash — retrieve ONE transaction by its hash and confirm, straight from the chain, that it is a real,
 * confirmed USDC-on-Base payment: from / to / amount. For ACCOUNTING (even off-crypto books): given a receipt's
 * txHash, prove the payment is real — the chain, not our record, is the source of truth. Read-only, no key.
 * Returns { found, paid, txHash, from, to, valueMicro, valueUsd, token, chainId, confirmations, blockNumber, blockTime, reason }.
 * FAIL-CLOSED: not-found / reverted / no-USDC-transfer-log ⇒ paid:false (never invents a settlement).
 */
async function verifyTxHash({ txHash, rpcUrl = process.env.BASE_RPC_URL || DEFAULT_RPC, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) return { found: false, paid: false, reason: 'not a 32-byte txHash' };
  const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [txHash], f);
  if (!receipt) {
    /* ═══ UN RECU ABSENT RECOUVRE TROIS ETATS, ET ON N'EN PUBLIAIT QU'UN — CELUI QUI ACCUSE ═══
     *
     * `eth_getTransactionReceipt` rend `null` pour une transaction inconnue MAIS AUSSI pour une
     * transaction encore en attente de minage. C'est un `result: null` conforme au protocole, donc pas
     * une erreur: `rpc()` ne jette pas et le rend tel quel. Les deux arrivaient ici par le meme chemin
     * et repartaient tous deux en « transaction not found on Base » — une affirmation sur la CHAINE
     * la ou nous n'avions qu'une absence de reponse.
     *
     * Ce que ca coute est sur la route PAYANTE. `settleOnce` transforme ce resultat en « no confirmed
     * USDC payment on Base ». Un agent qui vient de payer, appelle avec son txHash avant le minage, et
     * lit que sa transaction n'existe pas, a une raison de croire son paiement perdu et de REPAYER.
     * La difference entre « n'existe pas » et « pas encore minee » est une seconde mise.
     *
     * Les deux etats sont distinguables pour un appel de plus: `eth_getTransactionByHash` connait la
     * transaction en attente et ignore l'inconnue. `paid` ne bouge pas — il reste `false` dans tous les
     * cas, donc aucun consommateur ne change de branche; seule la RAISON cesse d'affirmer plus que ce
     * qu'on sait.
     *
     * ⚠️ ET LE TROISIEME ETAT: si cet appel supplementaire tombe, on ne sait pas non plus s'il s'agit
     * d'une attente. On le DIT, au lieu de retomber sur « introuvable » — ce qui reviendrait a fabriquer
     * la certitude qu'on vient de perdre. */
    let tx = null, attenteIndeterminable = false;
    try { tx = await rpc(rpcUrl, 'eth_getTransactionByHash', [txHash], f); }
    catch { attenteIndeterminable = true; }
    if (tx) return { found: false, paid: false, pending: true, txHash,
      reason: 'transaction is known to the node but NOT yet mined (pending) — this is not proof it does '
        + 'not exist, and it is not a payment yet either: retry once it has a receipt' };
    if (attenteIndeterminable) return { found: false, paid: false, txHash,
      reason: 'no receipt on Base, and whether the transaction is still pending could NOT be determined '
        + '(the follow-up read failed) — this is not proof that the transaction does not exist' };
    return { found: false, paid: false, reason: 'transaction not found on Base' };
  }
  if (String(receipt.status) !== '0x1') return { found: true, paid: false, txHash, reason: 'transaction reverted (status != 1)' };
  const head = BigInt(await rpc(rpcUrl, 'eth_blockNumber', [], f));
  const bn = BigInt(receipt.blockNumber);
  for (const log of receipt.logs || []) {
    try {
      // only a USDC-contract Transfer log counts — never trust another contract's event (impersonation guard).
      if (String(log.address || '').toLowerCase() !== USDC_BASE) continue;
      if (!Array.isArray(log.topics) || log.topics.length < 3 || String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
      const valueMicro = BigInt(log.data).toString();
      const { microToUsd } = require('./till');
      // La date du bloc — un aller-retour de plus, sur la branche PAYEE uniquement (les sondages qui ne
      // trouvent rien, les tx en attente et les tx revertees sont deja repartis plus haut).
      const blockTime = await blockTimeOf(rpcUrl, bn, f);
      return { found: true, paid: true, txHash, chainId: 8453, token: USDC_BASE,
        from: ('0x' + String(log.topics[1]).slice(26)).toLowerCase(), to: ('0x' + String(log.topics[2]).slice(26)).toLowerCase(),
        valueMicro, valueUsd: microToUsd(valueMicro), confirmations: Number(head - bn + 1n), blockNumber: Number(bn),
        blockTime,
        explorer: 'https://basescan.org/tx/' + txHash };
    } catch { /* a malformed log can neither crash nor forge a fact */ }
  }
  return { found: true, paid: false, txHash, reason: 'transaction has no USDC transfer log — not a USDC payment' };
}

module.exports = { findPayment, verifyTxHash, blockTimeOf, TRANSFER_TOPIC, DEFAULT_RPC };
