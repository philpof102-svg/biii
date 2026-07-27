'use strict';
/**
 * paygraph — quand un paiement entre agents compte comme réputation, et quand il n'est qu'un aller-retour.
 * =======================================================================================================
 * L'IDÉE QUI REND CECI POSSIBLE, et pourquoi la version précédente était morte.
 * `lawbor-killed-designs` avait tué « token de confiance » et « traces gratuites » pour une raison unique :
 * UNE NOTE GRATUITE EST FARMABLE. Dix agents, une boucle de 5/5 mutuels, réputation à valeur nulle.
 *
 * Un PAIEMENT change ça — c'est une note qui coûte. Mais il ne suffit pas seul, et ce fichier existe pour
 * les trois façons dont il échoue quand même.
 *
 *   1. LE LAVAGE.  A paie B, B rembourse A. Coût net ≈ frais. Détecté par les CYCLES.
 *   2. LE SYBIL.   Un opérateur, dix wallets, financés séparément. Le graphe de financeurs ne voit rien.
 *                  Détecté par le CLUSTER (financeur, hôte, fenêtre de création).
 *   3. PAYER POUR RIEN. La chaîne prouve le paiement, JAMAIS la livraison. Hors de portée d'ici : c'est le
 *                  rôle de l'engagement `deliverableHash` avant paiement.
 *
 * ═══ CE QUE CE MODULE NE FAIT PAS ═══
 * Il ne déplace aucun fonds, ne signe rien, ne détient aucune clé. Il lit un graphe de paiements DÉJÀ
 * survenus et dit lesquelles de ses arêtes sont porteuses d'information. Pur, déterministe, hors-ligne.
 *
 * ═══ FAIL-CLOSED ═══
 * Une arête dont on ne peut pas établir l'indépendance des extrémités n'est pas « probablement bonne » :
 * elle est ÉCARTÉE. Compter une arête douteuse gonfle une réputation ; l'écarter ne fait que la retarder.
 * L'erreur asymétrique se paie d'un seul côté.
 */

/** Deux acteurs sont du même cluster s'ils partagent une origine observable. Un seul indice suffit —
 *  exiger une conjonction ferait passer un Sybil qui varie un attribut. */
function sameCluster(a, b) {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (a.funder && b.funder && a.funder.toLowerCase() === b.funder.toLowerCase()) return true;
  if (a.host && b.host && a.host === b.host) return true;
  if (a.owner && b.owner && a.owner === b.owner) return true;
  return false;
}

/**
 * Cycles dirigés de longueur <= maxLen. Un paiement qui revient à son point de départ n'ajoute aucune
 * information : il déplace de l'argent en rond, et le solde net est nul aux frais près.
 * Retourne des listes d'identifiants, cycle canonicalisé (rotation minimale) pour dédupliquer.
 */
function findCycles(edges, maxLen = 4) {
  const out = new Map();
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const walk = (start, node, path, seen) => {
    if (path.length > maxLen) return;
    for (const next of (adj.get(node) || [])) {
      if (next === start && path.length >= 2) {
        // canonicalise: rotation qui place le plus petit id en tete
        const i = path.indexOf([...path].sort()[0]);
        const canon = path.slice(i).concat(path.slice(0, i)).join('>');
        if (!out.has(canon)) out.set(canon, path.slice(i).concat(path.slice(0, i)));
        continue;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      walk(start, next, path.concat(next), seen);
      seen.delete(next);
    }
  };
  for (const start of adj.keys()) walk(start, start, [start], new Set([start]));
  return [...out.values()];
}

/**
 * assess — quelles arêtes comptent, et pourquoi chaque exclusion est nommée.
 *
 * @param {Array} payments  [{ from, to, amount, at }]
 * @param {Object} actors   { id: { funder, host, owner } }
 * @param {Object} opts     { maxCycleLen, reciprocityWindowMs }
 * @returns { counted[], excluded[], reputation{}, coverage, disclosure }
 */
function assess(payments, actors = {}, opts = {}) {
  const maxCycleLen = opts.maxCycleLen == null ? 4 : opts.maxCycleLen;
  const window = opts.reciprocityWindowMs == null ? 24 * 3600 * 1000 : opts.reciprocityWindowMs;

  const edges = (Array.isArray(payments) ? payments : []).filter((p) => p && p.from && p.to);
  const counted = [];
  const excluded = [];
  const drop = (p, reason) => excluded.push({ ...p, reason });

  /* Les cycles se calculent AVANT toute autre exclusion: un cycle est une propriete de la topologie,
   * et le retirer arete par arete masquerait la boucle qu'on cherche. */
  const cycles = findCycles(edges, maxCycleLen);
  const inCycle = new Set();
  for (const c of cycles) {
    for (let i = 0; i < c.length; i++) inCycle.add(c[i] + '>' + c[(i + 1) % c.length]);
  }

  /* Reciprocite: A->B puis B->A dans la fenetre. La SECONDE arete ne compte pas. La premiere reste, parce
   * qu'au moment ou elle a eu lieu elle etait de l'information — c'est le retour qui l'annule. */
  const byPair = new Map();
  for (const p of [...edges].sort((a, b) => (a.at || 0) - (b.at || 0))) {
    const back = byPair.get(p.to + '>' + p.from);
    if (back != null && (p.at || 0) - back <= window) { drop(p, 'reciprocity'); continue; }
    byPair.set(p.from + '>' + p.to, p.at || 0);
  }
  const reciprocal = new Set(excluded.map((e) => e.from + '>' + e.to + '@' + (e.at || 0)));

  for (const p of edges) {
    const key = p.from + '>' + p.to;
    if (reciprocal.has(key + '@' + (p.at || 0))) continue;             // deja exclu ci-dessus
    if (p.from === p.to) { drop(p, 'self_payment'); continue; }
    if (sameCluster(actors[p.from], actors[p.to])) { drop(p, 'same_cluster'); continue; }
    if (inCycle.has(key)) { drop(p, 'cycle'); continue; }
    /* FAIL-CLOSED: sans profil d'acteur des deux cotes, on ne peut pas etablir l'independance. Non
     * comptee — retarder une reputation coute moins que la gonfler. */
    if (!actors[p.from] || !actors[p.to]) { drop(p, 'unknown_actor'); continue; }
    counted.push(p);
  }

  const reputation = {};
  for (const p of counted) reputation[p.to] = (reputation[p.to] || 0) + (Number(p.amount) || 0);

  return {
    counted, excluded, cycles, reputation,
    coverage: edges.length ? counted.length / edges.length : 0,
    disclosure: 'La reputation ne compte QUE les paiements entre acteurs dont l independance est etablie. '
      + 'Une arete non comptee n est pas une accusation: elle peut etre un cluster legitime ou un acteur '
      + 'inconnu. Un paiement prouve qu de l argent a bouge, JAMAIS qu un service a ete rendu — c est le role '
      + 'de l engagement de livraison, hors de portee de ce module. Aucun fonds n est deplace ici.',
  };
}

module.exports = { assess, findCycles, sameCluster };
