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

/* ═══ POURQUOI SIX PAGES ET PAS UNE — LE COMPTEUR ETAIT UN PLANCHER, PAS UNE MESURE ═══
 *
 * Une seule page etait lue, et une page vaut 50 TRANSACTIONS. Mais `siblingCount` compte des
 * DESTINATAIRES DISTINCTS. Un financeur qui renvoie plusieurs fois aux memes portefeuilles remplit donc
 * la page en paraissant minuscule. Mesure du 2026-08-04, 42 financeurs reels du DB re-parcourus a 12
 * pages (262 appels, zero 429) — a gauche ce que la lecture d'une page avait enregistre, a droite le
 * compte reel une fois la pagination suivie jusqu'a son terme:
 *
 *      4 -> 56 (termine)    11 -> 52 (termine)    12 -> 64 (termine)    15 -> 41 (termine)
 *      6 -> 18 (termine)     8 -> 15 (termine)    17 -> 18 (termine)
 *
 * Ce n'est PAS seulement un chiffre flou du cote DANGER. Quatre de ces sept sont enregistres SOUS le
 * seuil industriel de 20 et le franchissent une fois lus: la lecture d'une page FABRIQUE DES VERDICTS
 * « SAFE ». Dans la base, 144 tokens portent un compte censure inferieur a 20 — autant d'appels rassurants
 * emis sur un plancher. C'est la faute la plus chere des deux, parce qu'un faux DANGER coute une occasion
 * et un faux SAFE coute l'utilisateur.
 *
 * PROFONDEUR DE TERMINAISON, mesuree sur ces 42: [1×17, 2×2, 3×2, 4, 6, 10, 11]. Une page en lit 17/42
 * en entier; trois pages 21/42; six pages 23/42; douze pages 25/42. Le rendement s'effondre apres trois
 * et le budget est reel, donc SIX — au-dela de la crete des terminaisons, et au-dela de la profondeur ou
 * les franchissements du seuil de 20 apparaissent (page 2 a 3 pour la plupart).
 *
 * ⚠️ CE QUE CA NE REPARE PAS, ET IL FAUT LE DIRE AVANT LE RESULTAT. Au-dessus d'une vingtaine de freres,
 * les financeurs ne terminent PAS: ils croissent lineairement (27 -> 307, 46 -> 398 a 12 pages, toujours
 * plus). Ce sont des portefeuilles chauds — routeurs, teneurs de marche, echanges — dont le compte est
 * proportionnel a ce qu'on lit, pas une propriete de la chaine. Pour eux la censure demeure; elle est
 * simplement repoussee de 50 a la borne explicite, et `morePages` continue de la publier. Le compte
 * devient une MESURE sur la plage qui decide (0 a ~60) et reste un PLANCHER au-dela. La borne est donc
 * publiee avec le chiffre (`siblingPageCap`, `siblingPagesRead`), parce qu'un plancher dont on ignore
 * l'instrument n'est pas interpretable.
 *
 * ═══ ET LE SEUIL DERIVE N'EST TOUJOURS PAS SAUVE. MESURE, PAS ESPERE. ═══
 *
 * Les 206 financeurs distincts de la base ont ete re-parcourus avec CET instrument le 2026-08-04
 * (345 appels, zero 429), et les quantiles compares a ceux que la lecture d'une page avait produits,
 * ponderes par token comme le fait la marche prequentielle:
 *
 *     p75 sur TOUS les comptes            50  ->  300      (le plafond, deplace — pas retire)
 *     p75 sur les comptes LUS EN ENTIER    1  ->    3      (p90: 2 -> 18, max: 44 -> 64)
 *     tokens lus en entier            160/981 -> 223/981
 *
 * La premiere ligne est le resultat qui compte, et il est NEGATIF: approfondir la lecture ne rend pas la
 * regle « p75 sur tous les comptes » derivable. Elle rend toujours une CONSTANTE, et c'est toujours la
 * borne de l'instrument — 300 au lieu de 50. La cause est structurelle et se lit dans la concentration:
 * 25 financeurs portent 800 des 981 tokens, et ce sont EXACTEMENT les 25 qui atteignent la borne. Tant
 * que 4 token-lignes sur 5 pointent vers un portefeuille chaud dont le compte croit avec la profondeur de
 * lecture, aucun quantile sur cette variable ne mesure le marche: il mesure notre budget.
 *
 * La seconde ligne bouge pour de vrai (la queue s'ouvre: p90 passe de 2 a 18) mais reste tres en dessous
 * du seuil de 20 utilise a la main. La correlation censure/valeur est affaiblie, pas brisee.
 *
 * CE QUI EST DONC REPARE ICI EST LA COLLECTE, PAS LA STATISTIQUE. Les 144 faux « SAFE » cesseront d'etre
 * produits, ce qui est la faute la plus chere; le seuil de 20 reste HORS D'ATTEINTE d'une derivation a
 * partir de cette variable, et continue d'etre etiquete « choisi a la main » dans lib/prequential.js.
 * Le declarer derivable sur la foi de ce changement serait la meme faute qu'il corrige. */
const SIBLING_MAX_PAGES = 6;

/* Le cout fixe d'une trace: le token, les entrants du deployeur, l'horodatage de creation. En dessous,
 * la trace ne peut meme pas atteindre le financeur — la commencer depenserait des appels pour rien. */
const TRACE_FIXED_CALLS = 3;

/**
 * planTrace — « avec ce qu'il me reste, est-ce que je trace, et jusqu'ou ? »
 *
 * Extrait de la boucle de token-radar plutot que laisse dans sa closure, pour la raison que
 * run-prequential.js donne pour lib/prequential.js: un calcul qu'on PUBLIE doit etre exerce par la suite
 * de tests et non par un script lance a la main une fois. Ici le calcul decide combien de tokens sont
 * regardes un soir de budget serre — s'il se trompe, le radar rend moins de signal et rien ne le dit.
 *
 * La politique, et c'est un choix qui se defend a voix haute: le budget rogne la PROFONDEUR avant de
 * refuser le token. Un financeur lu sur deux pages est une mesure partielle honnete; un token pas trace
 * du tout est un trou. On garantit donc toujours au moins une page des qu'on se lance.
 *
 * @returns { trace: boolean, pages: number }  — `pages` n'a de sens que si `trace` est vrai.
 */
function planTrace(remaining, maxPages = SIBLING_MAX_PAGES) {
  const plafond = Number.isInteger(maxPages) && maxPages > 0 ? maxPages : SIBLING_MAX_PAGES;
  if (!Number.isFinite(remaining) || remaining < TRACE_FIXED_CALLS) return { trace: false, pages: 0 };
  return { trace: true, pages: Math.max(1, Math.min(plafond, Math.floor(remaining) - TRACE_FIXED_CALLS)) };
}

/* 2026-08-13: no deadline. `on('error')` fires on a refused or broken connection, never on a host that
 * ACCEPTS and stays silent — and this promise only resolves, so that case hung forever. Measured on a
 * local server that accepts and never answers: without `timeout` still pending at 2.5s where 700ms was
 * asked; with a handler that DESTROYS it gave up at 712ms; a handler that only listens hangs the same.
 * Shape and the 12s figure come from agent-vet.js:158, already correct in this directory. */
const getJSON = (url, timeout = 12000) => new Promise((resolve) => {
  const req = https.get(url, { headers: { accept: 'application/json' }, timeout }, (res) => {
    let d = ''; res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
  });
  req.on('timeout', () => { req.destroy(); resolve(null); });
  req.on('error', () => resolve(null));
});

/**
 * traceFeeder — token -> deployer -> funder -> siblings.
 *
 * Explorer calls: 2 fixed (token, deployer's incoming) + 1 for the creation timestamp when the token
 * records one + up to `maxPages` for the funder's outgoing history. Budget accordingly; the caller may
 * lower the page bound via `opts.maxPages`.
 *
 * @returns { ok, deployer, funder, fundedEth, fundedAt, freshDeployer, siblings, siblingCount, morePages,
 *            siblingPagesRead, siblingPageCap, siblingTxScanned, siblingScanStoppedBy,
 *            identicalAmountSiblings, pattern, note }
 */
async function traceFeeder(chain, tokenAddress, { fetchImpl, maxPages: maxPagesOpt } = {}) {
  const api = BLOCKSCOUT[String(chain).toLowerCase()];
  /* Le cout de cette trace n'est plus constant: il depend du nombre de pages que le financeur a demande.
   * L'appelant porte un budget d'appels pour tout le run et ne peut plus le deduire d'une multiplication.
   * On COMPTE donc ce qu'on depense, au lieu de laisser le budget etre une estimation. */
  let explorerCalls = 0;
  const brut = fetchImpl || getJSON;
  const fetchJSON = (url) => { explorerCalls++; return brut(url); };
  /* La borne est un ARGUMENT, pas seulement une constante: l'appelant porte le budget d'appels du run et
   * doit pouvoir l'abaisser sans editer ce fichier. Une valeur absurde retombe sur la constante mesuree
   * plutot que de laisser un `0` desactiver silencieusement tout le balayage. */
  const maxPages = Number.isInteger(maxPagesOpt) && maxPagesOpt > 0 ? maxPagesOpt : SIBLING_MAX_PAGES;
  if (!api) return { ok: false, explorerCalls, reason: 'no public explorer wired for chain "' + chain + '"' };

  // 1. The contract names its creator.
  const tok = await fetchJSON(api + '/addresses/' + tokenAddress);
  /* ⚠️ ET LA MEME CHOSE UNE LIGNE PLUS HAUT — trouvee par la correction d'en dessous, pas par lecture.
   * Des l'installation du drapeau `funderTrace`, la premiere passe reelle du radar (2026-07-29 15:59) a
   * rendu 8 echecs sur 24 traces, TOUS avec la meme phrase « could not resolve the deploying wallet ».
   * Or `tok && tok.creator_address_hash` la produisait pour deux situations sans rapport:
   *   · l'explorateur n'a pas repondu du tout            -> on ne sait rien, il faut REESSAYER
   *   · l'explorateur a repondu, sans creator enregistre  -> ce n'est peut-etre pas un contrat, RIEN A REESSAYER
   * A un tiers des traces, la difference decide s'il faut lever le pied sur l'explorateur ou changer ce
   * qu'on lui demande. Une seule phrase pour les deux rendait ce choix impossible. */
  if (tok == null) return { ok: false, explorerCalls, tokenRead: false,
    reason: 'the explorer did not answer for this token address — the deploying wallet is UNREAD, not unknown' };
  const deployer = tok.creator_address_hash;
  if (!deployer) return { ok: false, explorerCalls, tokenRead: true,
    reason: 'the explorer answered but records no creator for this address — it may not be a contract, '
      + 'or its creation predates the index' };

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
  if (inc == null || !Array.isArray(inc.items)) return { ok: false, explorerCalls, fundingRead: false,
    reason: 'the explorer did not answer for the deployer\'s incoming transfers — the funding of this '
      + 'launch is UNREAD, not absent' };
  const incoming = inc.items;                       // lu, et prouve lu: `freshDeployer` en depend plus bas
  const funders = incoming.filter((t) => parseFloat(t.value || 0) > 0);
  /* Et `siblingCount: 0` disait ici « ce financeur n'a paye personne d'autre » alors qu'AUCUN financeur
   * n'a ete identifie — rien n'a ete compte. `null` est le seul chiffre honnete quand la question n'a
   * meme pas pu etre posee. Meme correction que pour le `0` de la fratrie. */
  if (!funders.length) return { ok: true, explorerCalls, deployer, funder: null, siblings: [], siblingCount: null,
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

  // 3. What else that funder paid for. Paged to an EXPLICIT bound — far enough that the count is a
  //    measurement over the range that decides, and never unbounded, because an unbounded crawl on a free
  //    endpoint is how we lose it. What we stopped short of is published rather than absorbed.
  const sibRoot = api + '/addresses/' + funder + '/transactions';
  const byTarget = {};
  let sibUrl = sibRoot + '?filter=from';
  let pagesRead = 0, txScanned = 0, moreAfterUs = false, stoppedBy = 'end';
  for (let p = 0; p < maxPages; p++) {
    const page = await fetchJSON(sibUrl);
    /* Une page qui tombe EN COURS de balayage n'est pas la meme chose qu'une page 1 qui tombe. La
     * premiere laisse un compte partiel REEL (un plancher, comme la borne de pages); la seconde ne laisse
     * rien du tout. Les replier sur le meme etat rendrait « lu jusqu'a la page 4 puis panne » comme
     * « jamais lu » — on jetterait une mesure — ou pire, comme « lu en entier ». */
    if (page == null || !Array.isArray(page.items)) { if (p > 0) { moreAfterUs = true; stoppedBy = 'read_error'; } break; }
    pagesRead++;
    txScanned += page.items.length;
    for (const t of page.items) {
      const to = t.to && t.to.hash;
      if (!to || to.toLowerCase() === String(funder).toLowerCase()) continue;
      if (!(parseFloat(t.value || 0) > 0)) continue;
      byTarget[to] = (byTarget[to] || 0) + parseFloat(t.value || 0) / 1e18;
    }
    if (!page.next_page_params) { stoppedBy = 'end'; break; }          // l'historique tenait: c'est un COMPTE
    if (p === maxPages - 1) { moreAfterUs = true; stoppedBy = 'page_cap'; break; }   // sinon c'est un PLANCHER
    /* `filter` en TETE et repris de la racine: l'explorateur renvoie le filtre dans `next_page_params`, et
     * le remettre en premier garde chaque page reconnaissable a la meme sous-chaine que la page 1. Verifie
     * en direct le 2026-08-04: page 2 ainsi construite rend 50 elements, zero recouvrement avec la page 1,
     * et toutes les transactions bien emises PAR le financeur. */
    const suite = { ...page.next_page_params }; delete suite.filter;
    sibUrl = sibRoot + '?filter=from&' + new URLSearchParams(suite).toString();
  }
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
   * Trois etats, comme `freshlyFunded` juste en dessous: lu / lu-et-vide / PAS LU.
   * La boucle ci-dessus conserve exactement cette propriete: `pagesRead === 0` veut dire que meme la
   * PREMIERE page n'a pas repondu, donc rien n'a ete compte. */
  const siblingsRead = pagesRead > 0;
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
  /* « at least » n'est plus une devinette du lecteur: la boucle SAIT si elle a atteint la fin. */
  const aumoins = moreAfterUs ? 'at least ' : '';
  const etendue = ' (' + pagesRead + (pagesRead === 1 ? ' page, ' : ' pages, ') + txScanned + ' transactions scanned'
    + (moreAfterUs ? ', and there are MORE — this is a floor' : ', which was all of them') + ')';
  let pattern;
  if (!siblingsRead) pattern = 'the funder\'s outgoing history could NOT be read (the explorer did not answer). '
    + 'This is NOT "no siblings found" — the scan did not happen, so no factory pattern can be ruled out.';
  else if (identical >= SIBLING_ALERT) pattern = 'the funder sent an identical ' + topAmount + ' ETH to ' + aumoins
    + identical + ' different wallets — a scripted launch factory, not a person funding launches one by one' + etendue;
  else if (siblings.length >= SIBLING_ALERT) pattern = 'the funder has bankrolled ' + aumoins + siblings.length
    + ' distinct wallets' + etendue;
  /* L'ancienne phrase disait « on this page » — au singulier, et c'etait la seule trace de la borne dans
   * toute la sortie. Elle devient fausse des qu'on en lit six, et elle etait de toute facon le mauvais
   * endroit pour porter cette information: une phrase que seul un humain relit. La borne voyage desormais
   * en CHAMPS (`siblingPagesRead`, `siblingPageCap`, `siblingScanStoppedBy`), lisibles par machine. */
  else pattern = 'single funder, no repeated pattern' + etendue;

  return { ok: true, explorerCalls, deployer, funder, fundedEth: +fundedEth.toFixed(4), fundedAt, deployedAt,
    fundingToDeployMs, freshlyFunded, freshFundingWindowMs: FRESH_FUNDING_WINDOW_MS,
    /* Le financeur nomme n'est prouvablement le PREMIER que si toute l'historique entrante tenait sur une
     * page. Sinon c'est le plus ancien QU'ON AIT VU, ce qui n'est pas la meme affirmation. */
    funderIsProvablyFirst: !incompletIncoming,
    /* ⛔ LA MEME DOCTRINE QUE COTE FRATRIE, QUI MANQUAIT ICI. Plus bas, ce fichier explique que la
     * borne de la fratrie « voyage desormais en CHAMPS lisibles par machine » parce qu'« une phrase
     * que seul un humain relit » etait le mauvais endroit — et `siblingsRead` y gouverne SIX champs.
     * Cote ENTRANT, seul `funderIsProvablyFirst` portait le drapeau, alors que TROIS autres champs
     * derivent de la MEME liste tronquee: `fundedAt` (donc `fundingToDeployMs`, donc `freshlyFunded`).
     * Mesure du 2026-08-11: avec et sans `next_page_params`, ces trois-la sortaient IDENTIQUES.
     * ⚠️ Ce n'etait pas un mensonge — `funderIsProvablyFirst:false` etait publie — mais ca demandait
     * au consommateur de relier deux champs lui-meme. `incomingRead` porte la borne directement. */
    incomingRead: !incompletIncoming,
    freshDeployer, siblings: siblings.slice(0, 12),
    /* `null` = PAS LU, `0` = lu et vraiment vide. Les deux compteurs, parce que `identicalAmountSiblings`
     * gouverne l'autre moitie du drapeau industriel et tombait a 0 par le meme chemin. */
    siblingsRead, siblingCount: siblingsRead ? siblings.length : null,
    morePages: siblingsRead ? moreAfterUs : null,
    /* L'INSTRUMENT VOYAGE AVEC LA MESURE. Sans ces trois champs, un `siblingCount: 300` est indistinguable
     * d'un vrai 300 et d'une borne atteinte, et surtout le consommateur devait DEVINER la censure a partir
     * de la valeur (`>= 50`, la taille d'une page codee en dur ailleurs dans le depot). Un compte de 56
     * lu jusqu'a son terme se faisait ainsi tamponner « censure » a tort. La boucle sait; elle le dit.
     *   'end'        -> l'historique tenait dans la borne. C'est un COMPTE.
     *   'page_cap'   -> on s'est arrete nous-memes. C'est un PLANCHER, et on publie ou il est.
     *   'read_error' -> une page est tombee en cours. PLANCHER aussi, mais pour une raison reessayable. */
    siblingPagesRead: siblingsRead ? pagesRead : 0,
    siblingPageCap: maxPages,
    siblingTxScanned: siblingsRead ? txScanned : 0,
    siblingScanStoppedBy: siblingsRead ? stoppedBy : 'no_read',
    identicalAmountSiblings: siblingsRead ? identical : null, identicalAmount: topAmount,
    pattern,
    note: 'STRUCTURE ONLY. A shared funder proves shared control or shared infrastructure, never fraud — a launchpad and a rug factory look identical here. It means these tokens share fate: judge them together, not in isolation.'
      + (incompletIncoming
        ? ' ⚠️ The deployer has MORE incoming transfers than one page holds, so the wallet named as "funder" is the oldest one WE SAW, not provably the first that ever paid it. Do not present it as the original funder.'
          /* ⛔ ET LA DATE TOMBE AVEC LUI. `fundedAt` vient du meme `first`, donc `fundingToDeployMs` et
           * `freshlyFunded` en heritent. L'avertissement ne couvrait que le NOM du financeur; un
           * lecteur en deduisait que le reste tenait. Les trois champs sont nommes, pas sous-entendus. */
          + ' The same applies to the timing: `fundedAt` is that same oldest-seen transfer, so'
          + ' `fundingToDeployMs` and `freshlyFunded` are computed from a funding event that may not be'
          + ' the first one. An earlier funding hidden by the page bound would move all three.'
        : '')
      + (freshlyFunded === null
        ? ' The funding-to-deploy gap could not be computed (a timestamp was missing), so freshlyFunded is null — unknown, not false.'
        : '')
      /* La phrase qui manquait: le compte etait deja un plancher AVANT ce changement, et rien dans `note`
       * ne le disait — seul `morePages`, que peu de lecteurs croisaient avec le chiffre. */
      + (moreAfterUs
        ? ' ⚠️ siblingCount is a FLOOR, not a count: the scan stopped at ' + pagesRead + ' page(s) '
          + (stoppedBy === 'read_error' ? '(a page failed mid-scan) ' : '(the page cap) ')
          + 'with more history unread. The funder has AT LEAST this many siblings, possibly far more.'
        : '') };
}

module.exports = { traceFeeder, planTrace, SIBLING_ALERT, FRESH_FUNDING_WINDOW_MS, SIBLING_MAX_PAGES,
  TRACE_FIXED_CALLS };
