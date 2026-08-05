'use strict';
/**
 * announced-rules.js — ce qu'on a PARIÉ, écrit avant de savoir si on a raison.
 * ===========================================================================
 * Tous les chiffres mesurés dans ce dépôt sont in-sample: ils décrivent des issues déjà connues au
 * moment du calcul. Ça répond à « cette règle décrit-elle le passé », jamais à « cette règle
 * aurait-elle appelé ». Trois règles sont mortes ici de cette confusion, et les survivantes n'avaient
 * pas encore été soumises à la question dure.
 *
 * Ce fichier est l'engagement. Chaque entrée fige une règle, la date à partir de laquelle elle
 * compte, et le taux qu'elle PRÉDIT. Le grader ne note ensuite que les tokens apparus APRÈS cette
 * date — les autres sont, par construction, ceux qui ont servi à fabriquer le chiffre.
 *
 * ═══ POURQUOI EN SOURCE ET PAS DANS data/ ═══
 *
 * Le radar ÉCRIT dans data/. Une annonce que le système noté peut réécrire ne prouve rien: le jour où
 * un chiffre déçoit, rien n'empêcherait de « corriger » la prédiction et de présenter l'ajustement
 * comme un succès. En source, toute modification apparaît dans un diff et porte une date de commit.
 * Ce n'est pas nous qui rendons l'annonce infalsifiable, c'est git.
 *
 * ⛔ RÈGLES D'USAGE, non négociables:
 *   · une entrée ne se MODIFIE jamais — on en ajoute une nouvelle, l'ancienne reste notée ;
 *   · `announcedAt` doit être POSTÉRIEUR à la dernière observation connue au moment de l'écriture,
 *     sinon la « note vers l'avant » inclut des tokens déjà vus (le test le vérifie) ;
 *   · `predicted` est le chiffre in-sample tel qu'il était, y compris s'il se révèle faux. C'est le
 *     pari, pas une cible à ajuster.
 *
 * Au moment de l'écriture, l'observation la plus récente de la base est 2026-08-04T17:04:32.236Z.
 * La frontière est donc placée après, et le premier bulletin dira honnêtement « 0 token noté ».
 */

/** @typedef {{ key: string, label: string, announcedAt: string, predicted: object, basis: object, note: string }} Annonce */

const ANNOUNCED = Object.freeze([
  Object.freeze({
    key: 'verdict-caution-sans-natifs',
    label: 'caution SANS les natifs B20 — le seul signal bilateral du radar',
    announcedAt: '2026-08-05T00:00:00.000Z',
    // Cote SUR: la part des tokens marques `caution` (natifs exclus) qui ruggent. Cote DANGER: le reste.
    predicted: Object.freeze({ safeRate: 0.484, dangerRate: 0.854 }),
    basis: Object.freeze({ n: 1194, baseRate: 0.753, abstained: 148, sample: 'les 1859 tokens observes jusqu au 2026-08-04' }),
    note: 'Mesure in-sample. `caution` empile deux regimes: 517 non-natifs a 48,4 % et 148 natifs B20 a '
      + '87,2 %. Le pari est que la bande GARDE sa separation vers l avant une fois les natifs sortis.',
  }),
  Object.freeze({
    key: 'funder-20',
    label: 'financeur ayant paye >= 20 wallets (seuil CHOISI A LA MAIN)',
    announcedAt: '2026-08-05T00:00:00.000Z',
    predicted: Object.freeze({ dangerRate: 0.918, safeRate: 0.455 }),
    basis: Object.freeze({ n: 645, baseRate: 0.753, recall: 0.423, marked: 0.347 }),
    note: 'Le seuil 20 n a PAS pu etre derive: un quantile sur cette variable rend une constante, parce '
      + 'que 708 des 981 comptes sont des planchers colles au plafond de pagination (50) et que la '
      + 'censure est correlee a la valeur qu elle cache. C est donc un parametre choisi a la main, et '
      + 'c est precisement pour ca qu il doit etre note vers l avant.',
  }),
  /* Ajoutes le 2026-08-05 a 06h00Z — une entree s'AJOUTE, aucune ne se modifie, et les trois
   * precedentes gardent leur note. La frontiere reste posterieure a la derniere observation connue
   * (2026-08-04T17:04:32Z), donc ces paris aussi commencent a zero token note. */
  Object.freeze({
    key: 'owner-renounced',
    label: 'proprietaire RENONCE — le separateur le plus fort du jeu, cote sur',
    announcedAt: '2026-08-05T06:00:00.000Z',
    predicted: Object.freeze({ safeRate: 0.148, dangerRate: 0.789 }),
    basis: Object.freeze({ n: 1217, baseRate: 0.753, renounced: 54, abstained: 642,
      sample: 'les 1859 tokens observes jusqu au 2026-08-04, tous resolus (fenetre 4 h)' }),
    note: 'renounced 8/54 = 14,8 % contre une base de 75,3 % — 60 points sous la base, et le mecanisme '
      + 'tient seul: un proprietaire qui a renonce ne peut plus tirer les pouvoirs de propriete. C est '
      + 'la these fondatrice du depot, mesuree pour la premiere fois. Le pari est qu elle tient vers l avant.',
  }),
  Object.freeze({
    key: 'owner-unknown',
    label: 'proprietaire NON LU — le plus predictif, et le plus inconfortable',
    announcedAt: '2026-08-05T06:00:00.000Z',
    predicted: Object.freeze({ dangerRate: 0.909, safeRate: 0.549 }),
    basis: Object.freeze({ n: 1217, baseRate: 0.753, unknown: 999, abstained: 642 }),
    note: '⚠️ Annoncee en sachant ce qu elle a d inconfortable: l etat le plus PREDICTIF (999 tokens, '
      + '90,9 %) est celui ou l on n a RIEN lu. La doctrine interdit d accuser sur sa propre '
      + 'incompletude et elle reste juste — publier « les tokens dont on ne lit pas le proprietaire '
      + 'ruggent a 90,9 % » est une statistique de population; dire « CE token va rugger » serait une '
      + 'affirmation sur un actif. Le pari porte sur la premiere, jamais sur la seconde.',
  }),
  Object.freeze({
    key: 'natif-b20',
    label: 'token natif B20 (code exactement 0xef)',
    announcedAt: '2026-08-05T00:00:00.000Z',
    predicted: Object.freeze({ dangerRate: 0.839, safeRate: 0.745 }),
    basis: Object.freeze({ n: 155, baseRate: 0.753, recall: 0.093, marked: 0.083 }),
    note: '⚠️ Annoncee en sachant qu elle est PRECISE ET SANS PORTEE: rappel 9,3 % pour 8,3 % de la base '
      + 'marquee, soit un ratio de 1,12. On la note quand meme, parce qu une regle dont on attend peu '
      + 'est le meilleur controle de l instrument: si elle se met a « bien » separer vers l avant, c est '
      + 'l instrument qu il faut suspecter avant la regle.',
  }),
]);

/** La derniere observation connue au moment ou les annonces ci-dessus ont ete ecrites. */
const OBSERVATION_LA_PLUS_RECENTE_A_L_ANNONCE = '2026-08-04T17:04:32.236Z';

module.exports = { ANNOUNCED, OBSERVATION_LA_PLUS_RECENTE_A_L_ANNONCE };
