'use strict';
/**
 * BIII local vet — the LOCAL safe-to-pay verdict, extracted ONCE so every surface judges identically.
 * ================================================================================================
 * The same composition (known-bad screen → trust-core classifier → floor provenance) used to live inside
 * bin/biii-mcp.js only; extracting it here lets the MCP tool, the REST endpoint (GET /trust), and any
 * embedder share ONE code path — surfaces can't drift apart (the same drift-kill discipline as trust-core
 * itself: one judgment, many mouths).
 *
 * Everything is LOCAL + pure-ish (fs read at load, no network): the known-bad floor is this node's own
 * file, trust-core is this node's own classifier. Fail-closed all the way down:
 *   - floor file absent   ⇒ available:false ⇒ "screening UNAVAILABLE", never a silent "clean".
 *   - trust-core absent   ⇒ classifier:null (disclosed) — the screen-based BLOCK path still fires.
 *   - no behavioral score ⇒ a clean read caps at PROCEED_LOW_VALUE, never a confident PROCEED.
 */
const { loadScreen, screenAddress, screenMeta, floorProvenance } = require('./screen');
const fs = require('node:fs'), path = require('node:path');

// trust-core — MainStreet's JUDGMENT extracted PURE (same classifier, zero DB/network). Resilient resolve:
// the published package name, else the local sibling repo; neither present ⇒ null (classifier lens absent,
// screen BLOCK independent — safety NEVER depends on trust-core being installed).
/* ⚠️ DEUX `catch` AVALAIENT LA RAISON. « trust-core absent » et « trust-core present mais impossible a
 * charger » rendaient tous deux `TC = null`, donc `classifier: null` — et la doc de ce fichier annonce
 * « trust-core absent ⇒ classifier:null (disclosed) ». La divulgation affirmait donc ABSENT y compris
 * quand la verite etait PRESENT-MAIS-CASSE. Mesure du 2026-07-28, resolve bouchonne:
 *
 *   present -> classifier: objet
 *   absent  -> classifier: null      indiscernables
 *   casse   -> classifier: null
 *
 * La distinction est operationnelle, pas cosmetique: « pas installe » est l'etat NORMAL d'un deploiement
 * leger et n'appelle rien; « installe mais qui jette » veut dire qu'une copie vendoree est corrompue ou
 * qu'un deploiement est partiel — et c'est le MOTEUR DE JUGEMENT local, donc chaque verdict local se
 * degrade en silence.
 *
 * La securite ne bouge pas: le BLOCK par le crible reste independant de trust-core. C'est un correctif de
 * DIVULGATION, pas de verdict. */
let TC = null;
let TC_STATE = 'absent';          // 'loaded' | 'absent' | 'unloadable'
let TC_ERROR = null;
for (const spec of ['trust-core', '../../trust-core']) {
  try { TC = require(spec); TC_STATE = 'loaded'; TC_ERROR = null; break; }
  catch (e) {
    /* MODULE_NOT_FOUND sur le module DEMANDE = il n'est pas la. Toute autre erreur — ou un
     * MODULE_NOT_FOUND venu d'une dependance INTERNE a trust-core — veut dire qu'il existe et refuse de
     * se charger. Confondre les deux, c'est appeler « pas installe » un fichier corrompu. */
    const introuvable = e && e.code === 'MODULE_NOT_FOUND'
      && new RegExp("'" + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'").test(String(e.message));
    if (!introuvable) { TC_STATE = 'unloadable'; TC_ERROR = (e && (e.name + ': ' + e.message)) || String(e); }
  }
}

/** loadFloor — this node's known-bad floor from data/known-bad.json (absent ⇒ available:false, disclosed). */
function loadFloor(file) {
  const p = file || path.join(__dirname, '..', 'data', 'known-bad.json');
  try { if (fs.existsSync(p)) return loadScreen(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch {}
  return loadScreen(null);
}

/**
 * localClassify — MainStreet's judgment run on THIS node via trust-core (pure, no oracle). The known-bad
 * screen supplies the fail-closed DENY lens; the endpoint URL (if known) supplies the phishing/http/admin
 * URL lens. No behavioral score locally ⇒ clean caps at PROCEED_LOW_VALUE. Returns null when trust-core
 * is not installed (callers disclose). knownBad/tc injectable for tests.
 */
function localClassify(address, { resourceUrl, knownBad, tc = TC } = {}) {
  if (!tc) return null;
  const kb = knownBad || loadScreen(null);
  const scr = screenAddress(address, kb);
  const meta = screenMeta(kb);
  /* ⛔ `available` doit decrire LE CRIBLE DE CETTE ENTREE, pas la LISTE. `meta.available` ne dit que
   * « la liste est chargee » — vrai meme quand l'entree n'est pas une adresse et que RIEN n'a ete
   * crible. `screenAddress` le signale correctement (`available:false`, « not a 0x address »,
   * cf. lib/screen.js:47 « fail-closed: never clean »), et cet appelant jetait cette divulgation POUR
   * LA DECISION: une chaine VIDE ressortait `PROCEED_LOW_VALUE / allowed:true / green`, soit le meme
   * verdict qu'une adresse propre. Le jumeau MCP `till_trust` avait deja ete corrige (two-lens.test.js);
   * ce chemin-ci — celui de `GET /trust`, CORS-ouvert — ne l'avait pas ete.
   * ⚠️ `asOf` continue de venir de `meta`: la FRAICHEUR decrit bien la liste, elle. */
  const deny = { available: scr.available === true, asOf: meta.asOf, entry: scr.blocked ? { reason: scr.reason, severity: 'high' } : null };
  const signals = { deny };
  if (resourceUrl) signals.bazaar = { resourcePath: String(resourceUrl) };
  // BIII's own screen + its own knowledge of the endpoint = a locally-trusted signal bag (trustedSignals).
  const v = tc.verdict(signals, null, { trustedSignals: true });
  return { decision: v.decision, allowed: v.allowed, color: v.shield.color, reasonShort: v.shield.reasonShort,
    flags: v.shield.flags, explainer: v.shield.explainer,
    disclosure: 'LOCAL CLASSIFIER — MainStreet\'s judgment reproduced on THIS node via trust-core (pure, zero-oracle). Known-bad screen + endpoint-URL lens only; no behavioral score locally ⇒ a clean read is PROCEED_LOW_VALUE (low-value only), never a confident PROCEED. Holds even when the oracle is down.' };
}

/**
 * vetLocal — the whole LOCAL verdict in one call: screen (decisive) + classifier (this node's trust-core
 * read) + floor provenance (which basis judged, how fresh). This is what GET /trust serves, and what any
 * embedding app should render. NO network, NO oracle: what this node can verify itself, honestly labeled.
 */
function vetLocal(address, { resourceUrl, knownBad, tc } = {}) {
  const kb = knownBad || loadFloor();
  const addr = String(address || '').toLowerCase();
  const screen = screenAddress(addr, kb);
  const meta = screenMeta(kb);
  const prov = floorProvenance(kb);
  return {
    address: addr,
    /* ⚠️ `available` VOYAGE AVEC, et c'est load-bearing. `screenAddress` rend TROIS etats
     * (`blocked` / `available` / `reason`), cette fonction s'en sert pour ecrire sa `disclosure`… et ne
     * transmettait que `blocked` et `reason`. Un consommateur ne pouvait donc PAS distinguer « crible,
     * rien trouve » de « jamais crible »: les deux arrivaient en `blocked:false`, et la seule difference
     * vivait dans une PHRASE ANGLAISE. Mesure du 2026-08-15: `web/p2p.html` — la page qui decide a qui on
     * paie — peignait tout verdict non nul en VERT avec « ✓ pas known-bad », puis tronquait cette phrase
     * a 80 caracteres, soit exactement la ou commence « This is NOT a clean verdict ».
     * 💎 Une divulgation qu'on ne peut que LIRE n'est pas une divulgation, c'est de la prose. Pour qu'un
     * appelant fasse le bon choix il lui faut un champ sur lequel BRANCHER. Le voici. */
    screen: { blocked: screen.blocked, available: screen.available === true, reason: screen.reason || null },
    classifier: localClassify(addr, { resourceUrl, knownBad: kb, tc }),
    /* ⚠️ POURQUOI le classifieur est absent, quand il l'est. `classifier: null` couvrait deux etats
     * opposes — jamais installe (normal) et installe mais impossible a charger (une PANNE). Le second
     * demande quelqu'un; le premier non. `classifierSource` porte desormais la difference, et l'erreur
     * de chargement voyage avec, parce qu'un « ca ne marche pas » sans message se repare au hasard. */
    classifierSource: tc ? 'injected' : TC_STATE,
    classifierNote: tc || TC_STATE === 'loaded' ? undefined
      : TC_STATE === 'unloadable'
        ? 'trust-core IS present but failed to load (' + String(TC_ERROR).slice(0, 120) + '). This is NOT '
          + '"not installed" — something is broken (a corrupt vendored copy, a partial deploy), and every '
          + 'local verdict is degraded until it is fixed. The known-bad BLOCK below is unaffected.'
        : 'trust-core is not installed on this node, so no local behavioural classification is computed. '
          + 'That is a normal lean deployment, not a fault. The known-bad BLOCK below is unaffected.',
    floor: { available: meta.available, asOf: meta.asOf || null, ageDays: meta.ageDays ?? null,
      stale: meta.stale === true, count: meta.count ?? null, fingerprint: prov.fingerprint || null },
    /* ⛔ TROIS ETATS, DONC TROIS BRANCHES. Ce ternaire n'en avait que DEUX — « liste chargee » et
     * « liste absente » — et testait `meta.available`, qui ne decrit QUE LA LISTE. L'etat « liste
     * chargee mais CETTE entree n'est pas criblable » n'avait pas de branche et tombait sur la
     * branche POSITIVE: `vetLocal('alice.base.eth')` servait « Not on this node's known-bad floor »,
     * MOT POUR MOT la phrase d'une adresse propre, alors que `screen.reason` disait « not a 0x
     * address ». Une AFFIRMATION fausse, pas seulement une valeur neutre.
     * ⚠️ Et corriger la DECISION (plus haut) n'avait pas corrige LE TEXTE — un humain lit la phrase,
     * pas le champ `allowed`. Deux surfaces, une seule reparee au premier passage.
     * 🔑 Les deux pannes restent DISTINCTES: « aucune liste » demande un ingest, « entree illisible »
     * demande une autre entree. Les fondre en une phrase ferait reparer au hasard. */
    disclosure: screen.available !== true
      ? (meta.available
        ? 'NOT SCREENED — this input is ' + (screen.reason || 'not screenable') + ', so the known-bad floor was never consulted for it. This is NOT a clean verdict, and NOT an accusation either: pass a 0x address to get a real read.'
        : 'SCREENING UNAVAILABLE — no known-bad floor is loaded on this node. This is NOT a clean verdict; ingest the floor (scripts/biii-known-bad-ingest.js) before trusting any read.')
      : (screen.blocked
        ? 'BLOCKED on this node\'s local known-bad floor — decisive, no oracle consulted.'
        : 'Not on this node\'s known-bad floor (' + (meta.count ?? '?') + ' addresses, ' + (meta.stale ? 'STALE — re-run the ingest' : 'current') + '). NOT a clean bill: no behavioral score is computed locally.'),
  };
}

module.exports = { loadFloor, localClassify, vetLocal, TC };
