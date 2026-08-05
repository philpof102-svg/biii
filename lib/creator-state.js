'use strict';
/**
 * creator-state.js — qui a deploye ce token, ou l'aveu honnete qu'on ne le sait pas.
 * ================================================================================================
 * ⛔ CE QUE CE FICHIER REMPLACE. Cinq lignes de scoring dans launchers-integration-v2/v3 posaient la
 * question « createur inconnu ? » de DEUX facons differentes, dont une qui ne pouvait jamais etre vraie:
 *
 *     if (!token.creator || token.creator === '0x000...') score += 40;   // trois sites
 *     if (!launch.creator) score += 50;                                  // deux sites
 *
 * `'0x000...'` contient des POINTS litteraux: c'est une forme d'AFFICHAGE, pas une adresse. Un createur
 * reel fait `0x` + 40 caracteres hex, donc cette clause etait morte — elle se lisait comme une garde
 * active sans jamais en etre une. Le vrai trou qu'elle laissait ouvert: un `creator` valant l'adresse
 * zero passait les cinq sites sans marquer un seul point.
 *
 * 🧬 LA MEME FORME D'EXPRESSION A DEJA ETE UN DEFAUT MESURE ICI. Voir test/owner-state.test.js:10 —
 * `if (!o || o === '0x000…0') return false;` testait DEUX etats sur un champ qui en a TROIS, et le
 * correctif fut de les separer (`ownerState()`, lib/rugsignals.js). C'est la meme conflation.
 *
 * ⚠️ NE PAS CONFONDRE AVEC `ownerState()`. Elle repond a une question DIFFERENTE et rend un verdict
 * OPPOSE sur la meme valeur:
 *   - owner   === 0x0  ->  'renounced'  : plus personne ne peut tirer. C'est une BONNE nouvelle, et le
 *                                          dire est vrai.
 *   - creator === 0x0  ->  'unknown'    : personne n'a pu deployer depuis cette adresse. Ce n'est PAS
 *                                          une observation, c'est un bouche-trou emis par l'API.
 * Renoncer a la propriete est un acte qu'on peut signer; « avoir deploye depuis l'adresse zero » n'en
 * est pas un. Sur une chaine EVM l'adresse zero n'a pas de cle privee et ne peut donc signer aucune
 * transaction de deploiement. Un `creator: 0x0...0` rendu par un launchpad est un PLACEHOLDER — le
 * meme etat epistemique qu'un champ absent, jamais un signal plus fort.
 *
 * 📐 POURQUOI LA FORME EST VALIDEE, ET PAS SEULEMENT LA NULLITE. Une valeur qui n'est pas `0x` + 40 hex
 * n'est pas un createur sur lequel on peut agir: `'0x000...'` lui-meme, une adresse tronquee a
 * l'affichage, ou les 41 caracteres que la watchlist ecrite a la main a deja produits une fois
 * (cf. l'entete de hermes/agents/biii-monitor/watchlist.json). Toutes retombent sur 'unknown'. La
 * garde echoue donc FERMEE: dans le doute on marque les points, on ne les offre pas.
 *
 * ⚖️ PORTEE — ce que ce module ne fait PAS. Il normalise la QUESTION, jamais le BAREME. Chaque site
 * d'appel garde exactement les points qu'il avait (+40, +50, +35): aucun palier n'est promu ni modifie.
 * Et il ne prononce rien sur ce que « createur inconnu » DEVRAIT valoir — accorder des points de risque
 * parce qu'on n'a pas su lire un champ reste un choix produit discutable, laisse tel quel ici.
 */

/** Adresses qui ne peuvent avoir signe aucun deploiement: aucune n'a de cle privee. */
const SANS_CLE = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x',
]);

const FORME_ADRESSE = /^0x[0-9a-f]{40}$/;

/**
 * Deux etats, et un seul d'entre eux autorise a nommer quelqu'un.
 * @param {*} creator valeur brute telle que rendue par l'API amont
 * @returns {'known'|'unknown'}
 */
function creatorState(creator) {
  if (creator == null) return 'unknown';
  const c = String(creator).trim().toLowerCase();
  if (c === '') return 'unknown';
  if (SANS_CLE.has(c)) return 'unknown';
  if (!FORME_ADRESSE.test(c)) return 'unknown';   // tronquee, mal formee, forme d'affichage
  return 'known';
}

/** Predicat d'appel pour les sites de scoring. */
function creatorIsUnknown(creator) {
  return creatorState(creator) === 'unknown';
}

module.exports = { creatorState, creatorIsUnknown };
