'use strict';
/**
 * multicall.js — ask the chain forty questions in one request.
 * ===========================================================
 * Built because the wallet guard was blind on roughly a third of its own perimeter. Reading forty allowances
 * meant forty sequential `eth_call`s against a public RPC, and eleven to thirteen of them came back empty
 * every run. The guard reported that blindness honestly, which is the minimum — but a guard that cannot see
 * a third of the doors is not a guard, and an attacker's approval could sit precisely in the unread set.
 * Rate limiting was the whole problem, so the fix is to stop making forty requests.
 *
 * Multicall3 sits at the same address on every chain that has it, verified on Base before a line of this was
 * written (3808 bytes of code, registry name "Multicall3"). `aggregate3` takes a list of (target, allowFailure,
 * calldata) and returns a list of (success, returnData), so one round trip replaces the batch and a single
 * reverting call cannot poison its neighbours.
 *
 * The ABI encoding here is written by hand rather than pulled from a library, because this codebase takes no
 * dependencies — so it is verified against values already known from the sequential path rather than trusted.
 * A response is not a correct response: the first hand-rolled attempt returned 770 bytes of plausible-looking
 * data, which proves only that the node answered something.
 */
const https = require('node:https');

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const AGGREGATE3 = '0x82ad56cb';
const RPC = { base: 'https://mainnet.base.org', ethereum: 'https://ethereum-rpc.publicnode.com' };
const MAX_PER_BATCH = 60;   // keep the calldata comfortably inside any node's request limits

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');

/* 2026-08-13: same unbounded POST as approvals.js — the two helpers were byte-identical, so the
 * missing deadline was too. `on('error')` never fires for a server that accepts and stays silent, and
 * this promise only resolves, so that case hung forever. Measured: a native request without `timeout`
 * was still pending after 2.5s where 700ms had been asked; with a destroying handler it gave up in
 * 712ms; listening without destroying hangs just the same. Shape taken from agent-vet.js:158, which
 * already had it right in this same directory — twelve seconds, destroy, resolve(null). */
function post(url, body, timeout = 12000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname || '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(data);
  });
}

/**
 * Encode aggregate3((address,bool,bytes)[]). Dynamic structs, so the array is a list of offsets followed by
 * the structs themselves — each of which is in turn (address, bool, offset-to-bytes, length, padded data).
 */
function encodeAggregate3(calls) {
  const structs = calls.map((c) => {
    const cd = String(c.callData).replace(/^0x/, '');
    const padded = cd.padEnd(Math.ceil(cd.length / 64) * 64, '0');
    return addrWord(c.target) + word(c.allowFailure ? 1 : 0) + word(96) + word(cd.length / 2) + padded;
  });
  // Offsets are measured from the start of the array's element region, past the offset table itself.
  let cursor = 32 * structs.length;
  const offsets = structs.map((s) => { const at = cursor; cursor += s.length / 2; return word(at); });
  return AGGREGATE3 + word(32) + word(structs.length) + offsets.join('') + structs.join('');
}

/** Decode (bool success, bytes returnData)[] back into a flat list, preserving input order. */
function decodeAggregate3(hex, expected) {
  const h = String(hex).replace(/^0x/, '');
  if (h.length < 128) return null;
  const at = (i) => h.slice(i * 64, (i + 1) * 64);
  const arrayAt = Number(BigInt('0x' + at(0))) / 32;          // offset to the array
  const len = Number(BigInt('0x' + at(arrayAt)));
  if (len !== expected) return null;                           // shape mismatch: refuse rather than guess
  const out = [];
  for (let i = 0; i < len; i++) {
    const structAt = arrayAt + 1 + Number(BigInt('0x' + at(arrayAt + 1 + i))) / 32;
    const success = BigInt('0x' + at(structAt)) === 1n;
    const dataAt = structAt + Number(BigInt('0x' + at(structAt + 1))) / 32;
    const dataLen = Number(BigInt('0x' + at(dataAt)));
    const data = dataLen ? '0x' + h.slice((dataAt + 1) * 64, (dataAt + 1) * 64 + dataLen * 2) : '0x';
    out.push({ success, data });
  }
  return out;
}

/**
 * multiCall — run many read-only calls in as few round trips as possible.
 * @param {string} chain
 * @param {Array<{target:string, callData:string}>} calls
 * @returns {Promise<Array<{success:boolean,data:string}|null>>} same order as input; null where the batch itself failed
 */
async function multiCall(chain, calls) {
  const rpc = RPC[String(chain).toLowerCase()];
  if (!rpc || !calls.length) return calls.map(() => null);
  const out = [];
  for (let i = 0; i < calls.length; i += MAX_PER_BATCH) {
    const slice = calls.slice(i, i + MAX_PER_BATCH).map((c) => ({ ...c, allowFailure: true }));
    let decoded = null;
    for (let attempt = 0; attempt < 3 && !decoded; attempt++) {
      const res = await post(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: MULTICALL3, data: encodeAggregate3(slice) }, 'latest'] });
      if (res && typeof res.result === 'string') decoded = decodeAggregate3(res.result, slice.length);
      if (!decoded) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    // A failed BATCH yields nulls, never zeros — the caller must be able to tell "unread" from "empty",
    // which is the distinction that made the approval sweep honest in the first place.
    out.push(...(decoded || slice.map(() => null)));
  }
  return out;
}

/** allowance(owner, spender) for many (token, spender) pairs, in one or two round trips. */
async function allowancesBatch(chain, owner, pairs) {
  const calls = pairs.map(({ token, spender }) => ({
    target: token,
    callData: '0xdd62ed3e' + addrWord(owner) + addrWord(spender),
  }));
  const res = await multiCall(chain, calls);
  // Three return kinds on purpose. A BigInt is an answer; `null` means the node never answered and the pair
  // is genuinely unread; `false` means the call REVERTED, which is itself a definitive answer — the target
  // has no allowance() to read, or the pair is nonsense. Folding the last two together made one garbage
  // Approval event keep the whole sweep permanently short of "complete".
  return res.map((r) => {
    if (!r) return null;
    if (!r.success || r.data === '0x') return false;
    /* ═══ UN QUATRIEME CAS, LONGTEMPS RANGE AVEC LE MAUVAIS ═══
     * Ici `success` est VRAI et la donnee n'est pas vide: l'appel a abouti, mais son retour ne se lit
     * pas. Ce n'est PAS un revert — c'est une reponse illisible, donc un « non lu ». La version
     * precedente rendait `false`, c'est-a-dire « repondu definitivement: pas d'allocation ».
     *
     * La consequence traversait trois modules. approvals.js ne compte comme `unchecked` que les `null`
     * (ligne « if (a === null) »), donc un `false` rendait `complete: true`; wallet-watch remplace sa
     * reference des que le balayage est complet, donc l'allocation illisible SORTAIT de la memoire; et
     * au run suivant elle revenait en « NEW approval … Someone granted it since » — une affirmation
     * fausse sur la date d'octroi, nee d'une donnee qu'on n'avait jamais su lire.
     *
     * Le correctif du 2026-07-27 sur wallet-watch fermait la QUEUE de cette chaine. La tete etait ici.
     * Trouve par un balayage systematique des chemins d'echec rendant une valeur neutre, apres avoir
     * rencontre le meme motif une douzaine de fois dans la journee. */
    try { return BigInt(r.data); } catch { return null; }
  });
}

module.exports = { multiCall, allowancesBatch, encodeAggregate3, decodeAggregate3, MULTICALL3 };
