'use strict';
/**
 * meme.js — "which contract is the REAL memecoin, and is it safe to ape?" — BIII genuineness for memes.
 * =====================================================================================================
 * A meme symbol has many look-alike contracts across chains (BRETT = 10, TOSHI = 8, proven live). Aping the
 * wrong one = total loss. This returns a FAIL-CLOSED verdict from live market data (DexScreener, free), the
 * same discipline as our RWA `assessAsset`: never falsely certify "this is the real one" — ABSTAIN when the
 * top candidates are tied, and flag look-alikes. Advisory + re-verifiable (DexScreener/basescan links).
 *
 * Layer 2: holders health (on-chain distribution) to detect rugs/pump schemes.
 *
 * Pure + dependency-free: the HTTP fetch is injectable (fetchImpl) so it unit-tests offline.
 */
const https = require('node:https');
const { checkHoldersHealth } = require('./holders-health');
const { observationThin } = require('./thin-risk');   // la mesure de RISQUE, servie a cote du verdict d IDENTITE
const { readingFor } = require('./funder-history');   // ce que NOTRE base sait deja: la borne sans un appel reseau

const LIQ_FLOOR = 10000;          // below this = not a credible contract
const DOMINANCE = 3;              // canonical must hold >= 3x the runner-up's liquidity
const CAND_CAP = 12;              // `candidates` est PLAFONNE ici; son total voyage dans `candidatesTotal`

function getJSON(url, fetchImpl) {
  if (fetchImpl) return fetchImpl(url);
  return new Promise((resolve, reject) => {
    /* 2026-08-13: no deadline. dexscreener accepting the connection and never answering does not fire
     * `on('error')`, so this promise hung forever — and the caller's own timeout, if any, is not this
     * one's business. Measured: 700ms requested, still pending at 2.5s without a handler that
     * DESTROYS; 712ms with. This module REJECTS on failure (unlike feeder/recovery which resolve
     * null), so the timeout rejects too — following its own contract rather than importing another. */
    const req = https.get(url, { timeout: 12000 }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
      if (res.statusCode !== 200) return reject(new Error('dexscreener http ' + res.statusCode));
      try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('timeout', () => { req.destroy(); reject(new Error('dexscreener timeout after 12000ms')); });
    req.on('error', reject);
  });
}

/**
 * Les identifiants de chaine cotes DexScreener sont des SLUGS ('base', 'solana', 'ethereum'), jamais des
 * nombres. Un appelant, lui, ecrit naturellement 8453. On accepte donc les deux et on ramene tout au slug.
 *
 * ⚠️ `null` = « je ne sais pas ce que cette chaine designe », et ce n'est PAS « pas de filtre ».
 * Confondre les deux est exactement la faute mesuree ci-dessous.
 */
const SLUG_PAR_ID = {
  1: 'ethereum', 8453: 'base', 137: 'polygon', 42161: 'arbitrum', 10: 'optimism', 56: 'bsc', 43114: 'avalanche',
};
function slugDeChaine(v) {
  if (v == null || v === '') return undefined;                       // aucun filtre demande
  if (typeof v === 'number' || /^\d+$/.test(String(v))) return SLUG_PAR_ID[Number(v)] || null;
  return String(v).toLowerCase();
}

/**
 * Collapse DexScreener pairs to one row per token contract (best pair's liquidity wins).
 *
 * ═══ CORRIGE LE 2026-07-27: LE FILTRE DE CHAINE NE FILTRAIT RIEN, OU FILTRAIT TOUT ═══
 * bin/biii-mcp.js passait `Number(a.chainId)`. Or DexScreener rend des slugs:
 *
 *   chainId: 'base'  ->  Number('base') = NaN  ->  `if (chainId && ...)` est FAUX  ->  AUCUN filtre
 *   chainId: 8453    ->  'base' !== 8453       ->  TOUT est ecarte
 *
 * Mesure sur le service en production, symbole DEGEN:
 *   sans chainId       status=genuine   canonical.chain=solana   11 candidats
 *   chainId:'base'     status=genuine   canonical.chain=solana   11 candidats   <- le filtre est mort
 *   chainId:8453       status=thin      canonical=null            0 candidat    <- tout efface
 *
 * Un appelant demandant Base se voyait certifier un contrat SOLANA comme « genuine ». L'autre forme
 * rendait « thin », qui se lit « ce token existe a peine ici » alors que le filtre avait tout supprime.
 * Les deux sens faux, aucune erreur levee. C'est aussi pourquoi la couche 2 (holders-health) ne
 * s'executait jamais: elle est gardee par `canonical.chain === 'base'`.
 */
function candidatesFrom(pairs, symbol, chainId) {
  const S = String(symbol || '').toUpperCase();
  const slug = slugDeChaine(chainId);
  /* FAIL-CLOSED: une chaine demandee mais non reconnue ne doit pas se degrader en « toutes les chaines ».
   * Rendre l'ensemble vide fait remonter un verdict `thin`/`ambiguous`, jamais un `genuine` sur une chaine
   * que l'appelant n'a pas demandee. */
  if (slug === null) return [];
  const byTok = {};
  for (const p of (pairs || [])) {
    if (!p.baseToken || String(p.baseToken.symbol || '').toUpperCase() !== S) continue;
    if (slug && String(p.chainId || '').toLowerCase() !== slug) continue;
    const k = p.chainId + ':' + p.baseToken.address;
    /* ⚠️ « LIQUIDITE NON RAPPORTEE » DEVENAIT « ZERO DOLLAR ».
     * `(p.liquidity && p.liquidity.usd) || 0` ecrasait un champ ABSENT sur la valeur la plus
     * incriminante possible. Le contrat tombait alors sous LIQ_FLOOR, sortait de `credible`, et si
     * c'etait le VRAI contrat dominant qui disparaissait, l'usurpateur devenait `top`: un appelant
     * verifiant l'usurpateur recevait `genuine`. Le detecteur d'usurpation certifiait l'usurpateur.
     *
     * Sonde de l'API REELLE le 2026-07-28, sur les six symboles que ce module surveille: DexScreener
     * omet le champ `liquidity` sur certaines paires (3 sur 30 pour DEGEN, 1 sur 30 pour BRETT). Apres
     * deduplication par le MAXIMUM, 6 tokens sur 91 n'avaient AUCUNE paire rapportant sa liquidite —
     * 6,6 %, lus « 0 $ ». Ce n'est pas une hypothese de schema, c'est ce que l'API rend.
     *
     * `null` = pas mesure. `0` = mesure, et il n'y a rien. */
    const liq = p.liquidity && typeof p.liquidity.usd === 'number' ? p.liquidity.usd : null;
    /* Une valeur MESUREE l'emporte toujours sur une non mesuree, quel que soit son montant: entre
     * « 0 $ constate » et « on ne sait pas », c'est le constat qui informe. */
    const mieux = !byTok[k]
      || (liq != null && byTok[k].liquidityUsd == null)
      || (liq != null && byTok[k].liquidityUsd != null && byTok[k].liquidityUsd < liq);
    if (mieux) byTok[k] = {
      chain: p.chainId, address: p.baseToken.address, name: p.baseToken.name || '',
      liquidityUsd: liq, volume24: (p.volume && p.volume.h24) || 0, pairCreatedAt: p.pairCreatedAt || 0,
      dexscreener: p.url || ('https://dexscreener.com/' + p.chainId + '/' + p.baseToken.address),
    };
  }
  /* Les non mesures vont en FIN de tri: ils ne peuvent pretendre a la premiere place, qui decide du
   * contrat canonique. On ne certifie pas ce qu'on n'a pas pu mesurer — dans les deux sens. */
  return Object.values(byTok).sort((a, b) => {
    if (a.liquidityUsd == null && b.liquidityUsd == null) return 0;
    if (a.liquidityUsd == null) return 1;
    if (b.liquidityUsd == null) return -1;
    return b.liquidityUsd - a.liquidityUsd;
  });
}

/**
 * vetMeme — fail-closed verdict for a meme symbol (+ optional chain + a specific address to judge).
 * @param {object} opts - { symbol, chainId, address, fetchImpl, holderHealthImpl }
 * @returns { status, reason, canonical, candidates, disclosure, health, ...mesure }
 *   status: 'genuine' | 'impersonation' | 'ambiguous' | 'thin' | 'unknown'
 *   health: holders health metrics for the canonical candidate (if available)
 */
async function vetMemeCore({ symbol, chainId, address, fetchImpl, holderHealthImpl } = {}) {
  if (!symbol) return { status: 'unknown', reason: 'a symbol is required' };
  let pairs;
  try { pairs = (await getJSON('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(symbol), fetchImpl)).pairs; }
  /* ⛔ UNE LISTE VIDE PARCE QU'ON N'A PAS PU LIRE N'EST PAS UNE LISTE VIDE. Ce chemin rendait
   * `candidates: []` tout court: octet pour octet la meme reponse qu'un symbole reellement sans contrat.
   * `candidatesTotal: null` dit « inconnu », distinct du `0` que rend une vraie lecture sans resultat —
   * les trois etats, ici aussi. Et la cause de l'echec voyage desormais avec le refus, au lieu d'etre
   * avalee: « market data unavailable » ne disait pas si c'etait un DNS, un 429 ou un JSON casse. */
  catch (e) {
    return { status: 'unknown',
      reason: 'market data unavailable — the DexScreener search could not be read (' + String(e && e.message || e).slice(0, 120) + '), so NOTHING was measured for this symbol',
      canonical: null, candidates: [], candidatesTotal: null, candidatesCapped: false };
  }

  const cands = candidatesFrom(pairs, symbol, chainId);
  /* Explicite plutot qu'implicite: `null >= LIQ_FLOOR` est deja faux, mais s'appuyer sur la coercition
   * pour un fail-closed, c'est un garde qui tient par accident. Et on COMPTE les non mesures, parce
   * qu'un « un contrat domine » calcule en ignorant N concurrents illisibles n'est pas la meme
   * affirmation selon que N vaut 0 ou 4. */
  const credible = cands.filter((c) => typeof c.liquidityUsd === 'number' && c.liquidityUsd >= LIQ_FLOOR);
  const unmeasured = cands.filter((c) => c.liquidityUsd == null).length;
  const mesure = { unmeasured, unmeasuredNote: unmeasured
    ? unmeasured + ' contract(s) carrying this symbol report NO liquidity figure at all. They are NOT '
      + 'counted as $0 and NOT certified — they are simply unread, so any dominance claim below is made '
      + 'among the contracts that could be measured.'
    : null };
  const disclosure = 'ADVISORY, fail-closed: "genuine" = one contract dominates liquidity (>=' + DOMINANCE + 'x the runner-up); tied leaders are AMBIGUOUS (never certified); look-alikes/thin never read as safe. Re-verify each on DexScreener/Basescan — a verdict is a pointer to the chain, not a badge. `candidates` is CAPPED at ' + CAND_CAP + ' entries; `candidatesTotal` carries the real count and `candidatesCapped` says whether anything was cut.';

  /* ⛔ UNE LISTE SERVIE PLAFONNEE DOIT PORTER SON TOTAL. Les sept retours de cette fonction rendaient
   * `candidates: <liste>.slice(0, 12)` sans dire nulle part combien il y en avait vraiment. Le VERDICT
   * n'en souffre pas — `canonical` se calcule sur la liste COMPLETE — mais un appelant qui enumere
   * `candidates` pour juger lui-meme travaille alors sur une troncature muette, et rien dans la reponse
   * ne le lui apprend. C'est la meme faute que le compte de freres borne par une page, en forme de
   * liste au lieu d'un nombre.
   *
   * La forme canonique existe deja dans ce depot: `rugsignals.js:333` rend `slice(0, 4)` suivi de
   * `', …'` et du nombre total. On la reprend ici en champs plutot qu'en texte, parce que ces reponses
   * sont lues par des agents.
   *
   * ⚠️ CE QUI N'EST PAS MESURE: a quelle frequence la coupe MORD en production. Il faudrait des donnees
   * de marche reelles pour compter les symboles portant plus de douze contrats credibles. La troncature
   * est structurelle — le code coupe toujours — mais sa portee reste inconnue et n'est pas revendiquee. */
  const liste = (arr) => ({
    candidates: arr.slice(0, CAND_CAP),
    candidatesTotal: arr.length,
    candidatesCapped: arr.length > CAND_CAP,
  });

  /* `canonical: null` EXPLICITE, comme dans les autres chemins. Il manquait ici, donc la reponse `thin`
   * n'avait tout simplement pas la cle: un appelant ecrivant `r.canonical === null` lisait faux, alors
   * que le meme test sur un verdict `ambiguous` lisait vrai. Une forme de reponse qui change selon le
   * verdict oblige a deviner, et « la cle est absente » ne dit pas « il n'y a pas de contrat canonique ». */
  if (!credible.length) return { status: 'thin', reason: 'no contract with credible liquidity for "' + symbol + '"' + (chainId ? ' on ' + chainId : ''), canonical: null, ...liste(cands), disclosure, ...mesure };

  const top = credible[0], second = credible[1];
  const clearWinner = !second || top.liquidityUsd >= DOMINANCE * second.liquidityUsd;
  const canonical = clearWinner ? { chain: top.chain, address: top.address, liquidityUsd: top.liquidityUsd, dexscreener: top.dexscreener } : null;

  // Layer 2: holders health check (only for Base chain candidates with clear winner)
  let health = null;
  if (canonical && canonical.chain === 'base' && (holderHealthImpl || checkHoldersHealth)) {
    try {
      const healthCheck = holderHealthImpl || checkHoldersHealth;
      health = await healthCheck(canonical.address, { fetchImpl });
    } catch (e) {
      health = { healthy: false, score: 100, error: 'health check failed: ' + e.message };
    }
  }

  // Judging a SPECIFIC address the caller is about to ape:
  if (address) {
    const a = String(address).toLowerCase();
    /* ⚠️ UNE FAUTE DE FRAPPE RECEVAIT UNE ACCUSATION D'USURPATION.
     * Toute adresse qui n'etait pas `top` tombait sur `impersonation` — « this is NOT the dominant
     * contract ». Mesure du 2026-07-28, meme jeu de paires:
     *
     *   le vrai contrat dominant  -> genuine
     *   un sosie reel             -> impersonation
     *   '0x123'                   -> impersonation      IDENTIQUES au sosie, octet pour octet
     *   'pas-une-adresse'         -> impersonation
     *
     * L'accusation EST le produit de cet outil, et elle sortait sur une chaine qui n'est meme pas une
     * adresse. Une adresse malformee n'usurpe rien: elle n'existe pas. */
    if (!/^0x[0-9a-f]{40}$/.test(a)) {
      return { status: 'unknown', reason: 'the address to judge is not a 0x address (40 hex) — nothing is '
        + 'asserted about it, and no impersonation is alleged. This is a REJECTED INPUT, not a finding.',
        canonical, ...liste(credible), disclosure, health, ...mesure };
    }
    const isTop = top.address.toLowerCase() === a;
    if (!clearWinner) return { status: 'ambiguous', reason: 'the top contracts are within ' + DOMINANCE + 'x liquidity of each other — cannot certify a single real one', canonical: null, ...liste(credible), disclosure, health, ...mesure };
    if (isTop) return { status: 'genuine', reason: 'this IS the dominant-liquidity contract for "' + symbol + '"', canonical, ...liste(credible), disclosure, health, ...mesure };
    const asCand = cands.find((c) => c.address.toLowerCase() === a);
    /* DEUX CHOSES TRES DIFFERENTES SORTAIENT EN `impersonation`.
     *   - vue portant CE symbole, mais pas la dominante   -> c'est bien un sosie. L'accusation tient, y
     *     compris sous le plancher de liquidite: `cands` precede le filtre de credibilite, donc un vrai
     *     sosie minuscule reste attrape — c'est la prise qu'on ne veut surtout pas perdre.
     *   - jamais vue portant ce symbole                   -> on ne sait pas ce que c'est. Un contrat sur
     *     une autre chaine, un contrat sans marche, une adresse copiee de travers. Dire « ce n'est pas
     *     le contrat dominant de X » sous-entend qu'elle pretend l'etre; rien ne le montre.
     * Le second n'est pas une prise, c'est une absence de donnee — et nommer un tiers sur une absence
     * est exactement ce que ce depot refuse partout ailleurs. */
    if (!asCand) {
      return { status: 'not_a_candidate', reason: 'this address does not carry the symbol "' + symbol
        + '" in the market data we read — it is NOT alleged to be a look-alike, we simply never saw it '
        + 'under this symbol. Check the address and the chain before concluding anything.',
        canonical, thisContract: { address: a, note: 'never seen carrying this symbol in the pairs read' },
        ...liste(credible), disclosure, health, ...mesure };
    }
    return { status: 'impersonation', reason: 'this is NOT the dominant contract — the real one holds far more liquidity', canonical, thisContract: asCand, ...liste(credible), disclosure, health, ...mesure };
  }

  // No specific address: report which is canonical, or abstain.
  if (!clearWinner) return { status: 'ambiguous', reason: credible.length + ' contracts, top two within ' + DOMINANCE + 'x liquidity — no single real one can be certified', canonical: null, ...liste(credible), disclosure, health, ...mesure };
  return { status: 'genuine', reason: 'one contract dominates for "' + symbol + '"', canonical, ...liste(credible), disclosure, health, ...mesure };
}

/* ═══ « GENUINE » EST LE MOT LE PLUS RASSURANT DE CE TOOL, ET IL NE DISAIT PAS TOUT ═══
 *
 * Mesure du 2026-08-04, appel reel: `vetMeme({symbol:'STEAKHOUSE B20', chainId:'base'})` rend
 * `genuine` sur `0xb200…d3cB2Af1e481a8B072` avec pour seule raison « one contract dominates ». Or ce
 * contrat est un B20 NATIF — le standard natif de Base — dont l'EMETTEUR peut geler et bruler le
 * solde de n'importe quel porteur au niveau du standard. C'est un pouvoir plus fort qu'une mise a
 * jour de proxy, et un acheteur a qui l'on dit « authentique » ne l'apprend nulle part.
 *
 * ⚠️ CE N'ETAIT PAS une cecite d'aiguillage, et il a fallu le mesurer pour le savoir. L'hypothese de
 * depart etait que `vetMeme` raterait les B20 ou couronnerait un imposteur; sur les six natifs
 * vivants les plus liquides, aucune reponse ne designe un autre contrat que celui interroge, et les
 * cinq `thin` sont CORRECTS — leur liquidite est nulle depuis des jours. La premiere lecture les
 * croyait vivants parce qu'elle comparait une requete LIVE a `lastLiq`, qui est la liquidite AU
 * DERNIER PASSAGE et non la liquidite actuelle. Le defaut restant est donc une divulgation manquante
 * sur un verdict POSITIF, pas une erreur de designation. Les deux se corrigent differemment.
 *
 * L'annotation vit ICI, en un seul endroit, et pas dans les trois branches qui nomment un canonique:
 * c'est exactement la divergence entre routes soeurs que ce depot passe son temps a retirer.
 *
 * COUT: `classifyB20` n'est appelee que si l'adresse PRESENTE le prefixe B20 — un filtre gratuit, donc
 * zero appel reseau supplementaire sur la quasi-totalite des verdicts. La regle « pas d'appel tiers
 * dans le chemin de paiement » a deja coute trois refus d'outreach; ici l'appel est le notre, il est
 * unitaire, et il ne se declenche pas sur un token ordinaire.
 *
 * ⛔ Le verdict NE BOUGE PAS. Un B20 natif authentique reste `genuine` — sa nature n'est pas une
 * accusation. Seule s'ajoute la phrase que le lecteur doit avoir avant d'engager des fonds. */
const { classifyB20 } = require('./b20');

async function annoterNatifB20(r, { chainId, classifyImpl } = {}) {
  const canon = r && r.canonical && r.canonical.address;
  if (!canon || !/^0xb200/i.test(String(canon))) return r;
  // B20 n'existe que sur Base; ailleurs le prefixe n'est qu'une adresse qui commence pareil.
  const surBase = chainId == null || /^base$/i.test(String(chainId)) || String(chainId) === '8453';
  if (!surBase) return r;

  let b = null;
  try { b = await (classifyImpl || classifyB20)('base', String(canon)); } catch { b = null; }

  /* Trois etats. Un classement non concluant se DIT au lieu de disparaitre: sans cette branche, une
   * panne RPC rendrait un `genuine` visuellement identique a un `genuine` sur contrat ordinaire. */
  if (!b || b.verdict === 'unknown') {
    return { ...r, b20Check: 'unread',
      b20Note: 'This address wears the native-B20 prefix, but its code could NOT be read, so whether '
        + 'it is a native B20 is unresolved here. That is a gap in this answer, not a clearance.' };
  }
  if (b.verdict === 'native_b20') {
    return { ...r, b20Check: 'ok', nativeB20: true,
      b20Note: 'This is a NATIVE B20 (Base\'s own token standard, code is a single 0xef byte because the '
        + 'logic lives in a precompile). Its ISSUER holds standard-level freeze-and-burn over any '
        + 'holder\'s balance — a power no ERC-20 scanner can see, and a stronger one than a proxy '
        + 'upgrade. That is a certainty about the standard, not a finding about this token.' };
  }
  if (b.verdict === 'prefix_impostor') {
    return { ...r, b20Check: 'ok', nativeB20: false,
      b20Note: 'This address wears the B20 prefix while carrying ' + b.codeBytes + ' bytes of ordinary '
        + 'ERC-20 code — it is NOT a B20, it bought an address that looks like one.' };
  }
  return { ...r, b20Check: 'ok' };
}

async function vetMeme(opts = {}) {
  const r = await vetMemeCore(opts);
  const avecB20 = await annoterNatifB20(r, opts);

  /* ── CE QUE `thin` A MESURE, SERVI A COTE DU VERDICT ET JAMAIS DEDANS ──────────────────────────────
   * Le statut ci-dessus repond a une question d'IDENTITE. La mesure de risque attachee a `thin` est une
   * autre question, et ce depot a deja retire `impersonation` du risque pour avoir confondu les deux.
   * Elle arrive donc dans son propre champ, avec sa borne, et le module RETIENT son taux tant que la
   * borne n'est pas verifiee — ce qui est le cas par defaut, puisque `vetMeme` ne trace pas le
   * financeur. Un appelant qui connait `siblingCount` le passe et obtient le chiffre borne.
   * ⛔ Le verdict `status` n'est pas touche: aucun appelant existant ne voit son resultat changer. */
  /* ── LA TRACE DU FINANCEUR, PRISE LA OU ELLE NE COUTE RIEN ────────────────────────────────────────
   * Sans `siblingCount`, le taux reste RETENU pour toujours et le champ ne dit jamais rien. Mais tracer
   * un financeur coute des appels sur le seul endpoint qui serve des `getLogs` larges sur Base, et ce
   * depot n'a pas de repli gratuit.
   *
   * Or ce noeud a DEJA observe des milliers de lancements. Quand le token en fait partie, la valeur est
   * sur le disque — zero appel reseau. C'est ce chemin-la qu'on branche, et lui seul: un appelant qui
   * veut la trace vive passe `siblingCount` lui-meme, en connaissance du cout.
   * ⛔ La PROVENANCE voyage avec la valeur. Un chiffre servi sans dire d'ou il vient laisse croire qu'il
   * a ete verifie a l'instant, alors qu'il peut dater de la derniere observation de ce token. */
  /* ⛔ Chaines SERVIES en anglais — le reste de cette reponse l'est, et `till_vet_meme` est expose a des
   * agents tiers via le MCP heberge. Les commentaires restent en francais. */
  let freres = opts.siblingCount;
  let source = typeof freres === 'number' ? 'supplied by the caller' : null;
  let vu = null;
  /* ⛔ TROIS ETATS POUR LA CENSURE, et le choix par defaut est une DECISION, pas un detail.
   *   · lu dans NOTRE base  -> le drapeau `siblingCountCensored` dit si le compte est un PLANCHER;
   *   · fourni par l'APPELANT -> on ne peut PAS le verifier. La description de `till_vet_meme` promet
   *     depuis toujours que fournir le compte LEVE la retenue; retenir ici casserait ce contrat sans
   *     que personne l'ait decide. On prend donc l'appelant au mot, et `siblingCountSource` le DIT —
   *     un lecteur voit d'ou vient le chiffre et peut en tirer ses propres conclusions.
   *   · l'appelant peut desormais declarer lui-meme `siblingCountCensored: true` s'il sait que sa
   *     trace est incomplete: c'est la seule facon honnete de lui laisser la main. */
  let censure = typeof opts.siblingCountCensored === 'boolean' ? opts.siblingCountCensored
    : (typeof freres === 'number' ? false : null);
  if (typeof freres !== 'number') {
    const cible = typeof opts.address === 'string' ? opts.address : avecB20.canonical;
    /* `dbPath` traverse jusqu'ici pour qu'un test soit HERMETIQUE: sans ca il lirait la vraie base du
     * noeud, et son resultat changerait a chaque run du radar — un test dont la reponse bouge toute
     * seule ne prouve rien et finit par etre desactive. */
    const lu = readingFor(cible, { dbPath: opts.dbPath });
    if (lu.state === 'hit' && typeof lu.siblingCount === 'number') {
      freres = lu.siblingCount; source = 'this node own observation'; vu = lu.observedAt;
      /* Le drapeau voyage AVEC le chiffre: un compte sans son statut de completude est un plancher
       * qu'on ne sait pas reconnaitre, et c'est exactement ce qui a fabrique une branche « sure » a
       * 50,6 pct la ou les comptes prouves donnent 76,8. */
      if (typeof opts.siblingCountCensored !== 'boolean') censure = lu.siblingCountCensored;
    } else {
      source = lu.detail || lu.state;
    }
  }

  const risque = observationThin({ status: avecB20.status, siblingCount: freres,
    siblingCountCensored: censure, gradedForward: opts.gradedForward });
  return { ...avecB20,
    observedRisk: risque && { ...risque, siblingCountSource: source, siblingCountObservedAt: vu } };
}

module.exports = { vetMeme, vetMemeCore, annoterNatifB20, candidatesFrom };
