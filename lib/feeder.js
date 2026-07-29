'use strict';
/**
 * feeder.js — "who paid for this launch, and what else did they pay for?"
 * =======================================================================
 * `rugsignals` asks what the deployer CAN do. This asks who the deployer IS — by following the money
 * backwards. A token contract names its creator; a creator wallet minutes old names the wallet that funded
 * it; and that funder usually funded others. Three free queries and a cluster appears that no retail buyer
 * can see from a chart.
 *
 * Proven on a live launch while writing this: token -> creator (funded once, 15.02 ETH, seven minutes before
 * the pool existed) -> funder, which had sent the SAME 15.020 ETH to twenty-six other fresh wallets. Nobody
 * funds twenty-six wallets to the milli-ETH by hand; that is a machine running a launch factory.
 *
 * WHAT THIS DOES NOT CLAIM. A shared funder is not proof of fraud. The same signature fits a launchpad, a
 * market maker, or a serial rug operation, and we cannot tell which from the graph alone. So this reports
 * STRUCTURE, never intent: these tokens share a paymaster, therefore they share fate. That is decision-
 * relevant on its own — and calling it "scammer" without evidence would be the same unfounded certainty we
 * refuse everywhere else. Intent only gets asserted when a sibling has actually rugged, which token-radar
 * records over time.
 *
 * Source: Blockscout's public Base instance (no key, no quota registration).
 */
const https = require('node:https');

const BLOCKSCOUT = { base: 'https://base.blockscout.com/api/v2',
  // Robinhood chain — verified live: /addresses, /tokens and /transactions all answer the Blockscout v2 shape.
  robinhood: 'https://robinhoodchain.blockscout.com/api/v2' };
const FRESH_FUNDING_WINDOW_MS = 6 * 60 * 60 * 1000;   // funded <6h before deploying = wallet made for the job
const SIBLING_ALERT = 5;                              // a funder this prolific is infrastructure, not a person

const getJSON = (url) => new Promise((resolve) => {
  https.get(url, { headers: { accept: 'application/json' } }, (res) => {
    let d = ''; res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
  }).on('error', () => resolve(null));
});

/**
 * traceFeeder — token -> deployer -> funder -> siblings.
 * @returns { ok, deployer, funder, fundedEth, fundedAt, freshDeployer, siblings, siblingCount, morePages,
 *            identicalAmountSiblings, pattern, note }
 */
async function traceFeeder(chain, tokenAddress, { fetchImpl } = {}) {
  const api = BLOCKSCOUT[String(chain).toLowerCase()];
  const fetchJSON = fetchImpl || getJSON;
  if (!api) return { ok: false, reason: 'no public explorer wired for chain "' + chain + '"' };

  // 1. The contract names its creator.
  const tok = await fetchJSON(api + '/addresses/' + tokenAddress);
  const deployer = tok && tok.creator_address_hash;
  if (!deployer) return { ok: false, reason: 'could not resolve the deploying wallet' };

  // 2. The creator's incoming transfers name whoever paid for it. A wallet with exactly one incoming
  //    transfer was created for this launch and nothing else — which is itself the signal.
  const inc = await fetchJSON(api + '/addresses/' + deployer + '/transactions?filter=to');
  /* ⚠️ `(inc && inc.items) || []` REPLIAIT DEUX CAS SUR LE MEME TABLEAU VIDE: l'explorateur MUET et un
   * deployeur REELLEMENT sans transfert entrant. Mesure du 2026-07-29 en appelant cette fonction avec un
   * explorateur injecte — les deux reponses etaient identiques a `JSON.stringify` pres:
   *
   *   ok:true · funder:null · siblingCount:0 · « no incoming value transfer found for the deployer »
   *
   * Une panne reseau etait donc rendue comme un CONSTAT SUR LA CHAINE, et `till_launch_funder` la servait
   * telle quelle a des agents. Ce fichier avait deja corrige exactement cette faute sur la lecture de la
   * FRATRIE (voir `siblingsRead` plus bas, 2026-07-28) et ne l'avait jamais appliquee un cran plus haut,
   * sur la lecture qui identifie le financeur lui-meme. Un `items` absent compte comme une non-reponse:
   * fail-closed, parce qu'ici le silence se lit autrement comme une innocence. */
  if (inc == null || !Array.isArray(inc.items)) return { ok: false, fundingRead: false,
    reason: 'the explorer did not answer for the deployer\'s incoming transfers — the funding of this '
      + 'launch is UNREAD, not absent' };
  const incoming = inc.items;                       // lu, et prouve lu: `freshDeployer` en depend plus bas
  const funders = incoming.filter((t) => parseFloat(t.value || 0) > 0);
  /* Et `siblingCount: 0` disait ici « ce financeur n'a paye personne d'autre » alors qu'AUCUN financeur
   * n'a ete identifie — rien n'a ete compte. `null` est le seul chiffre honnete quand la question n'a
   * meme pas pu etre posee. Meme correction que pour le `0` de la fratrie. */
  if (!funders.length) return { ok: true, deployer, funder: null, siblings: [], siblingCount: null,
    siblingsRead: null, fundingRead: true,
    note: 'no incoming value transfer found for the deployer — it may be funded via a contract or bridged' };

  /* L'explorateur rend du plus recent au plus ancien, donc le DERNIER element est le plus ancien —
   * mais seulement DE CETTE PAGE. Sur un deployeur qui a recu beaucoup de transferts, la page 1 contient
   * les plus recents, et son dernier element n'est pas le premier financeur: c'est le cinquantieme en
   * partant de la fin. On nommait alors une adresse qui n'a pas paye ce lancement, sans le dire — alors
   * que le meme fichier divulgue soigneusement `morePages` du cote des siblings.
   * Une adresse fausse dans un rapport de financement est une accusation. */
  const incompletIncoming = !!(inc && inc.next_page_params);
  const first = funders[funders.length - 1];
  const funder = first.from && first.from.hash;
  const fundedEth = parseFloat(first.value || 0) / 1e18;
  const fundedAt = first.timestamp || null;

  // 3. What else that funder paid for. One page is enough to see the shape; we say when there are more
  //    rather than paging forever, because an unbounded crawl on a free endpoint is how we lose it.
  const out = await fetchJSON(api + '/addresses/' + funder + '/transactions?filter=from');
  /* ═══ UN BALAYAGE DE FRATRIE QUI ECHOUE RENDAIT « CE FINANCEUR N'A FINANCE PERSONNE » ═══
   * `getJSON` resout `null` sur erreur reseau ET sur corps non-parsable (une page HTML de 502, un corps
   * de 429) — il ne rejette jamais. Donc `out` falsy retombait sur `[]`, et le retour disait `ok: true`,
   * financeur nomme, `siblingCount: 0`, `morePages: false`. Mesure du 2026-07-28, trois cas opposes:
   *
   *   usine (26 wallets)     -> siblingCount 26, pattern « scripted launch factory »
   *   vide  (vraiment aucun) -> siblingCount 0,  pattern « single funder, no repeated pattern »
   *   panne (429/502)        -> siblingCount 0,  pattern « single funder, no repeated pattern »   IDENTIQUE
   *
   * Les deux derniers sortaient identiques octet pour octet. Ce n'est pas seulement un compteur neutre:
   * la phrase publiee ATTESTE l'absence du signal a partir d'une lecture qui n'a pas eu lieu.
   *
   * Ce que ca coute: « le financeur a paye 20+ portefeuilles » est l'une des deux conditions qui, dans nos
   * propres donnees, precedent 85 % des rugs. Une nuit ou l'explorateur limite le debit, le radar annote
   * chaque lancement comme finance par un dormeur solitaire — et l'annotation est ecrite en base, donc la
   * lecture manquee survit a la panne.
   *
   * Trois etats, comme `freshlyFunded` juste en dessous: lu / lu-et-vide / PAS LU. */
  const siblingsRead = out != null;
  const sent = ((out && out.items) || []).filter((t) => parseFloat(t.value || 0) > 0);
  const byTarget = {};
  for (const t of sent) {
    const to = t.to && t.to.hash;
    if (!to || to.toLowerCase() === String(funder).toLowerCase()) continue;
    byTarget[to] = (byTarget[to] || 0) + parseFloat(t.value || 0) / 1e18;
  }
  const siblings = Object.entries(byTarget).map(([addr, eth]) => ({ addr, eth: +eth.toFixed(4) }))
    .sort((a, b) => b.eth - a.eth);

  // An identical amount repeated across many fresh wallets is a script, not a person deciding each time.
  const rounded = siblings.map((s) => s.eth.toFixed(3));
  const counts = {};
  for (const r of rounded) counts[r] = (counts[r] || 0) + 1;
  const [topAmount, identical] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [null, 0];

  /* ═══ `deployedAt` PORTAIT LA DATE DE FINANCEMENT ═══
   * L'ancienne ligne etait
   *
   *     const deployedAt = tok.creation_transaction_hash ? (first.timestamp || null) : null;
   *
   * — `first` est le transfert entrant, donc `deployedAt` valait `fundedAt`, toujours. Mesure: les deux
   * champs sortaient identiques sur toute entree. Un appelant calculant l'ecart obtenait ZERO a chaque
   * fois, c'est-a-dire « finance et deploye dans la meme seconde »: la lecture la plus incriminante qui
   * soit, servie sur tous les tokens indistinctement. Encore un champ a variance nulle presente comme
   * une mesure.
   *
   * Et FRESH_FUNDING_WINDOW_MS — « finance <6h avant le deploiement = portefeuille fait pour la tache » —
   * etait definie et exportee mais utilisee NULLE PART: l'heuristique que le commentaire decrit n'avait
   * jamais ete ecrite. Elle ne pouvait pas l'etre, faute d'une vraie date de deploiement.
   *
   * On va donc chercher l'horodatage REEL de la transaction de creation. Un appel de plus, borne (jamais
   * de pagination), sur le seul hash que le contrat nous a deja donne. */
  let deployedAt = null;
  if (tok.creation_transaction_hash) {
    const creation = await fetchJSON(api + '/transactions/' + tok.creation_transaction_hash);
    deployedAt = (creation && creation.timestamp) || null;
  }

  /* Le signal que la constante decrivait, enfin calcule. Trois etats: mesure / pas mesurable (une des
   * deux dates manque) — jamais un `false` qui se lirait « verifie, et ce n'est pas le cas ». */
  let fundingToDeployMs = null;
  if (fundedAt && deployedAt) {
    const d = new Date(deployedAt).getTime() - new Date(fundedAt).getTime();
    if (Number.isFinite(d)) fundingToDeployMs = d;
  }
  const freshlyFunded = fundingToDeployMs == null
    ? null                                              // indeterminable, pas « non »
    : (fundingToDeployMs >= 0 && fundingToDeployMs <= FRESH_FUNDING_WINDOW_MS);

  const freshDeployer = incoming.length === 1;
  let pattern;
  if (!siblingsRead) pattern = 'the funder\'s outgoing history could NOT be read (the explorer did not answer). '
    + 'This is NOT "no siblings found" — the scan did not happen, so no factory pattern can be ruled out.';
  else if (identical >= SIBLING_ALERT) pattern = 'the funder sent an identical ' + topAmount + ' ETH to ' + identical +
    ' different wallets — a scripted launch factory, not a person funding launches one by one';
  else if (siblings.length >= SIBLING_ALERT) pattern = 'the funder has bankrolled ' + siblings.length + ' distinct wallets';
  else pattern = 'single funder, no repeated pattern on this page';

  return { ok: true, deployer, funder, fundedEth: +fundedEth.toFixed(4), fundedAt, deployedAt,
    fundingToDeployMs, freshlyFunded, freshFundingWindowMs: FRESH_FUNDING_WINDOW_MS,
    /* Le financeur nomme n'est prouvablement le PREMIER que si toute l'historique entrante tenait sur une
     * page. Sinon c'est le plus ancien QU'ON AIT VU, ce qui n'est pas la meme affirmation. */
    funderIsProvablyFirst: !incompletIncoming,
    freshDeployer, siblings: siblings.slice(0, 12),
    /* `null` = PAS LU, `0` = lu et vraiment vide. Les deux compteurs, parce que `identicalAmountSiblings`
     * gouverne l'autre moitie du drapeau industriel et tombait a 0 par le meme chemin. */
    siblingsRead, siblingCount: siblingsRead ? siblings.length : null,
    morePages: siblingsRead ? !!(out && out.next_page_params) : null,
    identicalAmountSiblings: siblingsRead ? identical : null, identicalAmount: topAmount,
    pattern,
    note: 'STRUCTURE ONLY. A shared funder proves shared control or shared infrastructure, never fraud — a launchpad and a rug factory look identical here. It means these tokens share fate: judge them together, not in isolation.'
      + (incompletIncoming
        ? ' ⚠️ The deployer has MORE incoming transfers than one page holds, so the wallet named as "funder" is the oldest one WE SAW, not provably the first that ever paid it. Do not present it as the original funder.'
        : '')
      + (freshlyFunded === null
        ? ' The funding-to-deploy gap could not be computed (a timestamp was missing), so freshlyFunded is null — unknown, not false.'
        : '') };
}

module.exports = { traceFeeder, SIBLING_ALERT, FRESH_FUNDING_WINDOW_MS };
