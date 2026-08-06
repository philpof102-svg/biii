'use strict';
/**
 * code-only.js — rendre un source JavaScript lisible par un scanner, sans le detruire.
 *
 * Remplace commentaires, chaines et litteraux regex par des espaces, EN CONSERVANT la longueur totale
 * et chaque saut de ligne. Un `indexOf` ou un numero de ligne calcule sur la sortie reste donc valable
 * sur l'entree, ce qui est toute la raison d'etre de ce module.
 *
 * ⛔ POURQUOI UN AUTOMATE, ET PAS UNE REGEX. Ce depot a paye quatre fois pour la version regex:
 *   · une porte qui scanne du texte lit sa PROPRE documentation comme du code et s'accuse elle-meme —
 *     arrive dans quatre fichiers distincts;
 *   · `/\/\*[\s\S]*?\*\//g` applique au fichier entier a detruit du vrai code le 2026-08-05: une chaine
 *     contenant les deux caracteres de fin de bloc a fait demarrer la correspondance non-greedy au
 *     mauvais endroit, `indexOf` a rendu -1, et sept assertions sont passees au rouge contre du code
 *     parfaitement correct.
 * Une regex ne connait pas l'etat courant. Un automate caractere par caractere, si.
 *
 * ⚠️ CE QU'IL NE FAIT PAS: ce n'est pas un parser. La detection de litteral regex repose sur
 * l'heuristique habituelle — un `/` ouvre une regex seulement si le dernier caractere significatif ne
 * peut pas terminer une valeur. Elle peut neutraliser un peu trop dans un cas tordu, jamais trop peu:
 * l'erreur va vers le SILENCE (un site manque), pas vers la FAUSSE ALARME (du code invente). Pour un
 * scanner qui cherche des defauts, c'est le bon sens de l'erreur — il vaut mieux rater une ligne que
 * d'accuser du code qui n'existe pas.
 */

/** Un `/` peut ouvrir une regex si le dernier caractere significatif ne termine pas une valeur. */
const PEUT_PRECEDER_UNE_REGEX = '(,=:[!&|?{};+-*%~^<>';

/**
 * @param {string} src source JavaScript
 * @returns {string} meme longueur, memes sauts de ligne, tout le reste neutralise en espaces
 */
function codeOnly(src) {
  const out = src.split('');
  const blanc = (i) => { if (i < out.length && out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  let dernierSignificatif = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];

    if (c === '/' && d === '/') {                       // commentaire de ligne
      while (i < src.length && src[i] !== '\n') blanc(i++);
      continue;
    }
    if (c === '/' && d === '*') {                       // commentaire de bloc
      blanc(i++); blanc(i++);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blanc(i++);
      blanc(i++); blanc(i++);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {          // chaine ou gabarit
      const fin = c;
      blanc(i++);
      while (i < src.length && src[i] !== fin) {
        if (src[i] === '\\') blanc(i++);                // une echappee couvre DEUX caracteres
        blanc(i++);
      }
      blanc(i++);
      dernierSignificatif = 'x';                        // une chaine est une VALEUR
      continue;
    }
    if (c === '/' && (dernierSignificatif === '' || PEUT_PRECEDER_UNE_REGEX.includes(dernierSignificatif))) {
      const depart = i;
      blanc(i++);
      let ferme = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { blanc(i++); blanc(i++); continue; }
        if (src[i] === '[') { while (i < src.length && src[i] !== ']' && src[i] !== '\n') blanc(i++); }
        if (src[i] === '/') { blanc(i++); ferme = true; break; }
        blanc(i++);
      }
      /* Pas de fermeture sur la ligne: ce n'etait pas une regex mais une division. On rend le texte
       * d'origine plutot que de laisser un trou — se tromper ici doit couter zero. */
      if (!ferme) { for (let j = depart; j < i; j++) out[j] = src[j]; }
      dernierSignificatif = 'x';
      continue;
    }

    if (!/\s/.test(c)) dernierSignificatif = c;
    i++;
  }
  return out.join('');
}

module.exports = { codeOnly };
