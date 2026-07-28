'use strict';
// meme-scan.js — the meme-genuineness HARVESTER. Pulls the tokens being BOOSTED/promoted right now on
// DexScreener (any chain — the freshest impersonation surface, where paid-boost scams live) + a Base seed,
// and runs the fail-closed vetMeme verdict on each. Deterministic (no LLM) → $0 no_agent cron; stdout = brief.
const https = require('node:https');
const { vetMeme } = require('../../lib/meme');

const SEED = (process.env.MEME_WATCH || 'BRETT,TOSHI,DEGEN,SPX,ANDY,KEYCAT').split(',').map((s) => s.trim()).filter(Boolean);
const CHAINS = (process.env.MEME_CHAINS || 'base,solana,ethereum,bsc').split(',');   // harvest surface

function getJSON(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); })
      .on('error', () => resolve(null));
  });
}

// The FRESH surface: tokens being paid-boosted RIGHT NOW (promotion = where impersonation scams live).
/* ⚠️ UNE RECOLTE QUI N'A PAS EU LIEU RENDAIT UNE COCHE VERTE.
 * `getJSON` resout `null` sur erreur reseau ET sur corps non-parsable. `Array.isArray(null)` etant faux,
 * la liste retombait a `[]`, et le titre imprimait:
 *
 *   ✓ meme-watch harvest: 0 boosted tokens scanned, no impersonation/ambiguity among the promoted ones.
 *
 * Une coche verte et une phrase rassurante sur une liste jamais lue. C'est le pire endroit possible pour
 * ce defaut: la sortie est un ✓ que personne ne relit.
 *
 * Et la seconde requete — celle qui donne le symbole — pouvait echouer token par token: ces tokens
 * disparaissaient de `out`, donc le denominateur affiche etait deja plus petit que la realite, sans le
 * dire. Trois etats desormais separes: liste NON LUE, tokens perdus au resolvage, tokens retenus. */
async function boostedTokens(limit = 12, lire = getJSON) {
  const boosts = await lire('https://api.dexscreener.com/token-boosts/latest/v1');
  if (!Array.isArray(boosts)) return { tokens: [], harvestRead: false, dropped: 0, picked: 0 };
  const pick = boosts.filter((b) => CHAINS.includes(b.chainId)).slice(0, limit);
  const out = [];
  let dropped = 0;
  for (const b of pick) {
    const t = await lire('https://api.dexscreener.com/latest/dex/tokens/' + b.tokenAddress);
    const sym = t && t.pairs && t.pairs[0] && t.pairs[0].baseToken && t.pairs[0].baseToken.symbol;
    if (sym) out.push({ symbol: sym.toUpperCase(), address: b.tokenAddress, chain: b.chainId });
    else dropped++;
  }
  return { tokens: out, harvestRead: true, dropped, picked: pick.length };
}

/**
 * summarise — le titre. Extrait pur, parce que c'est la phrase que quelqu'un lira sans lire le reste, et
 * que rien ne l'epinglait. Un ✓ doit dire de combien de tokens il parle, et se taire quand il n'en a
 * examine aucun.
 */
function summarise({ alerts, examined, harvestRead, dropped = 0, skipped = 0, picked = 0 }) {
  if (!harvestRead) return '⚠️ meme-watch harvest: the boost list could NOT be read — nothing was scanned, '
    + 'which is not the same as nothing found.';
  if (alerts) return '🚩 meme-watch harvest: ' + alerts + ' FRESH trap(s) among ' + examined
    + ' boosted token(s) examined — aping the wrong contract = total loss.';
  const manques = [];
  if (dropped) manques.push(dropped + ' had no readable symbol');
  if (skipped) manques.push(skipped + ' could not be vetted');
  if (!examined) return '⚠️ meme-watch harvest: the boost list was read (' + picked + ' candidate(s)) but '
    + 'NOT ONE could be examined' + (manques.length ? ' — ' + manques.join(', ') : '') + '. No verdict.';
  return '✓ meme-watch harvest: ' + examined + ' boosted token(s) examined, no impersonation/ambiguity '
    + 'among them' + (manques.length ? ' — but ' + manques.join(', ') + ', so this is PARTIAL' : '') + '.';
}

module.exports = { boostedTokens, summarise };

if (require.main === module) (async () => {
  const recolte = await boostedTokens();
  const boosted = recolte.tokens;
  const lines = [];
  let alerts = 0, skipped = 0, examined = 0;

  // 1) FRESH harvest — is each promoted contract actually the real one for its symbol?
  for (const { symbol, address, chain } of boosted) {
    /* Un `continue` muet retirait le token du travail sans le retirer du COMPTE annonce. */
    let v; try { v = await vetMeme({ symbol, chainId: chain, address }); } catch { skipped++; continue; }
    examined++;
    const n = (v.candidates || []).length;
    if (v.status === 'impersonation') { alerts++; lines.push(`🚩 BOOSTED ${symbol} [${chain}] ${address.slice(0, 10)}…: IMPERSONATION — the promoted contract is NOT the dominant one. Paid-boost trap.`); }
    else if (v.status === 'ambiguous') { alerts++; lines.push(`🚩 BOOSTED ${symbol} [${chain}]: AMBIGUOUS — ${n} contracts, no clear real one (verify holders before aping).`); }
    /* La reserve des concurrents ILLISIBLES voyage jusqu'ici: « promoted = the dominant contract » est
     * une affirmation calculee parmi les contrats qu'on a pu mesurer, et ce n'est pas la meme phrase
     * selon qu'on en a ignore 0 ou 4. */
    else if (v.status === 'genuine') lines.push(`· boosted ${symbol} [${chain}]: promoted = the dominant contract${n > 1 ? ' (' + (n - 1) + ' look-alike(s) exist)' : ''}${v.unmeasured ? ' — among those measurable; ' + v.unmeasured + ' report no liquidity at all' : ''}.`);
    else if (v.status === 'thin') lines.push(`· boosted ${symbol} [${chain}]: thin liquidity — nothing credible${v.unmeasured ? ', and ' + v.unmeasured + ' contract(s) report no figure at all (unread, not empty)' : ''}.`);
    /* `unknown` est un statut DOCUMENTE de vetMeme (« market data unavailable »), pas une surprise. Le
     * confondre avec un statut inconnu ferait passer une panne de donnee pour un bug de notre cote. */
    else if (v.status === 'unknown') lines.push(`⚠️ boosted ${symbol} [${chain}]: market data unavailable — NOT scanned, which is not "nothing found".`);
    /* `not_a_candidate`: l'adresse promue ne porte pas ce symbole dans les paires lues. Ce n'est PAS une
     * usurpation — c'est une incohérence entre le boost et le marché, et elle mérite un œil sans mériter
     * une accusation. */
    else if (v.status === 'not_a_candidate') lines.push(`? boosted ${symbol} [${chain}]: the promoted address does not carry this symbol in the pairs read — mismatch, NOT an impersonation claim.`);
    /* Sans ce dernier cas, un statut inconnu ne produisait AUCUNE ligne: le token etait compte comme
     * examine et ne disait rien, ce qui se lit « rien a signaler ». Un etat qu'on ne sait pas nommer
     * doit s'annoncer, pas se taire. */
    else lines.push(`? boosted ${symbol} [${chain}]: unrecognised status "${v.status}" — NOT a clean read.`);
  }

  // 2) SEED watch — well-known memes, so a fresh fake on a big name still gets caught.
  for (const sym of SEED) {
    let v; try { v = await vetMeme({ symbol: sym }); } catch { continue; }
    const n = (v.candidates || []).length;
    if (v.status === 'ambiguous') lines.push(`  ~ ${sym}: ${n} contracts, top two tied (standing ambiguity).`);
    else if (v.status === 'genuine' && n > 1 && v.canonical) lines.push(`  ~ ${sym}: real = ${v.canonical.chain}:${v.canonical.address.slice(0, 8)}… · ${n - 1} look-alike(s).`);
  }

  console.log(summarise({ alerts, examined, harvestRead: recolte.harvestRead,
    dropped: recolte.dropped, skipped, picked: recolte.picked }));
  for (const l of lines) console.log('  ' + l);
})();
