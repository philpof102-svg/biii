#!/usr/bin/env node
'use strict';
/**
 * thin-risk: ce qui se teste ici est la RETENUE, pas la publication.
 *
 * Servir 88,4 % est facile. Ce qui est difficile — et ce qui a tue des lectures dans ce depot — c'est
 * de NE PAS le servir quand la borne n'est pas verifiee. Hors de sa branche, la meme lecture ne separe
 * que de 15,1 points pour 20 disponibles: un appelant qui recoit le chiffre sans la borne l'appliquera
 * partout, et il aura raison de le faire puisqu'on le lui a donne.
 *
 * Les cas ci-dessous couvrent donc surtout les REFUS, et chacun exige que la raison soit rendue: un
 * retour neutre muet devient une affirmation chez l'appelant.
 *
 * ⚠️ Et deux gardes contre la derive silencieuse:
 *   · le taux servi doit etre CELUI DE L'ANNONCE, pas une copie — une copie derive le jour ou la mesure
 *     est refaite, et on servirait un chiffre qu'on n'a jamais parie ;
 *   · le seuil de la borne doit etre D'ACCORD avec la regle notee dans `lib/prequential.js`. Deux
 *     constantes egales a 20 aujourd'hui peuvent diverger demain, et alors la mesure et ce qu'on sert
 *     ne parleraient plus du meme sous-ensemble.
 */
const assert = require('node:assert');
const { observationThin, CLE, SEUIL_FRERES, DIVULGATION } = require('../lib/thin-risk');
const { ANNOUNCED } = require('../lib/announced-rules');
const { RULES, DANGER, SAFE, ABSTAIN } = require('../lib/prequential');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('thin-risk: publier un taux borne, ou ne rien publier du tout');

const PARI = ANNOUNCED.find((a) => a.key === CLE);

/* ── 1. LES REFUS, QUI SONT L ESSENTIEL ───────────────────────────────────────────────────────────── */

t('★ financeur NON trace: aucun taux, et la raison dit pourquoi', () => {
  for (const sc of [undefined, null, NaN, 'abc', Infinity]) {
    const o = observationThin({ status: 'thin', siblingCount: sc });
    assert.strictEqual(o.rate, null, 'siblingCount=' + String(sc) + ' ne doit rien publier');
    assert.strictEqual(o.boundChecked, false);
    assert.ok(/WITHHELD/.test(o.why), 'la raison doit dire que le taux est retenu: ' + o.why);
    assert.ok(typeof o.howToCheck === 'string', 'il faut dire COMMENT lever la retenue');
  }
});

t('★ financeur AU-DESSUS du seuil: la borne est verifiee et le taux reste retenu', () => {
  const o = observationThin({ status: 'thin', siblingCount: SEUIL_FRERES });
  assert.strictEqual(o.boundChecked, true, 'la borne EST verifiee, ce n est pas une ignorance');
  assert.strictEqual(o.applies, false);
  assert.strictEqual(o.rate, null, 'au-dessus du seuil, publier un taux serait publier un plafond');
  assert.ok(/ceiling/.test(o.why), o.why);
});

t('★ symbole NON verifie: « pas verifie » n est pas « pas thin »', () => {
  for (const s of ['not_a_candidate', 'unknown', undefined, null, 42]) {
    const o = observationThin({ status: s, siblingCount: 3, siblingCountCensored: false });
    assert.strictEqual(o.rate, null, 'status=' + String(s) + ' ne doit rien publier');
    assert.ok(/not "checked and not thin"/.test(o.why), o.why);
  }
});

/* ── 2. CE QUI SE PUBLIE, ET SEULEMENT LA ─────────────────────────────────────────────────────────── */

t('dans la branche mesuree, `thin` sert le taux DANGER de l annonce', () => {
  const o = observationThin({ status: 'thin', siblingCount: 3, siblingCountCensored: false });
  assert.strictEqual(o.applies, true);
  assert.strictEqual(o.side, 'danger');
  assert.strictEqual(o.rate, PARI.predicted.dangerRate, 'le taux servi doit etre CELUI DU PARI');
  assert.strictEqual(o.baseRate, PARI.basis.baseRate, 'la base doit voyager avec le taux');
  assert.strictEqual(o.funders, PARI.basis.dangerFunders);
});

t('dans la branche mesuree, un symbole VERIFIE non-thin sert le taux SUR', () => {
  const o = observationThin({ status: 'genuine', siblingCount: 3, siblingCountCensored: false });
  assert.strictEqual(o.side, 'safe');
  assert.strictEqual(o.rate, PARI.predicted.safeRate);
  assert.strictEqual(o.funders, PARI.basis.safeFunders);
});

t('★ TEMOIN — les deux cotes ne servent pas le meme chiffre', () => {
  const d = observationThin({ status: 'thin', siblingCount: 3, siblingCountCensored: false });
  const s = observationThin({ status: 'genuine', siblingCount: 3, siblingCountCensored: false });
  assert.notStrictEqual(d.rate, s.rate, 'sortie constante: le statut n est lu par personne');
  assert.ok(d.rate > s.rate, 'le cote thin doit etre le plus dangereux des deux');
});

/* ── 3. LES GARDES CONTRE LA DERIVE SILENCIEUSE ───────────────────────────────────────────────────── */

t('★ le seuil servi est D ACCORD avec la regle NOTEE — teste sur la definition, pas sur le litteral', () => {
  const regle = RULES.find((r) => r.key === CLE);
  assert.ok(regle, 'aucune regle notee ne porte la cle ' + CLE);
  const dedans = regle.predict({ siblingCount: SEUIL_FRERES - 1, symbolVerdict: 'thin' });
  const dehors = regle.predict({ siblingCount: SEUIL_FRERES, symbolVerdict: 'thin' });
  assert.strictEqual(dedans, DANGER, 'juste SOUS le seuil servi, la regle notee doit encore appeler');
  assert.strictEqual(dehors, ABSTAIN, 'AU seuil servi, la regle notee doit s abstenir');
  /* Sans ces deux assertions, `SEUIL_FRERES` pourrait deriver de la regle et on servirait un taux
   * mesure sur un sous-ensemble DIFFERENT de celui qu on annonce. */
});

t('★ la regle notee s abstient aussi sur un symbole non verifie — les deux pieces d accord', () => {
  const regle = RULES.find((r) => r.key === CLE);
  for (const s of ['not_a_candidate', 'unknown', undefined]) {
    assert.strictEqual(regle.predict({ siblingCount: 3, symbolVerdict: s }), ABSTAIN,
      'la regle notee doit s abstenir sur ' + String(s) + ', comme le fait le service');
  }
  assert.strictEqual(regle.predict({ siblingCount: 3, symbolVerdict: 'genuine' }), SAFE);
});

t('★ le chiffre est LU dans l annonce, pas recopie', () => {
  const o = observationThin({ status: 'thin', siblingCount: 1, siblingCountCensored: false });
  /* Si quelqu un recopiait 0.884 en dur ici, ce test passerait aujourd hui et mentirait le jour ou
   * l annonce serait remplacee par une entree neuve. On verifie donc l IDENTITE avec la source. */
  assert.strictEqual(o.rate, PARI.predicted.dangerRate);
  assert.strictEqual(o.announcedAt, PARI.announcedAt);
  /* ⛔ LA PROSE DE L ENGAGEMENT EST TOUJOURS SERVIE VERBATIM, sous un champ qui dit ce qu elle est.
   * `label` porte desormais notre propre description anglaise (l annonce est en francais et
   * `announced-rules.js` interdit de la modifier), mais `announcementLabel` relaie l originale — sinon
   * on servirait une reformulation en pretendant citer un engagement. */
  assert.strictEqual(o.announcementLabel, PARI.label,
    'la prose de l annonce doit rester servie TELLE QUELLE, sinon le pari n est plus citable');
  assert.notStrictEqual(o.label, PARI.label, 'et `label` doit etre notre description, pas un relais');
  assert.ok(o.label.length > 20, 'qui doit dire quelque chose: ' + o.label);
});

/* ── 4. CE QUE LA REPONSE DOIT DIRE D ELLE-MEME ───────────────────────────────────────────────────── */

t('★ l etat IN-SAMPLE est dit, pas cache — et il a TROIS etats, pas deux', () => {
  /* ⛔ CE CAS DISAIT `true`, ET IL CERTIFIAIT LE DEFAUT. `gradedForward = 0` par defaut transformait
   * « personne ne me l'a dit » en « rien n'a ete note ». Mesure du 2026-08-10: aucune des deux routes
   * servies ne fournit ce chiffre, donc l'affirmation etait GELEE — vraie aujourd'hui, fausse des la
   * premiere notation, et jamais corrigee. Non fourni => `null`. */
  const sansChiffre = observationThin({ status: 'thin', siblingCount: 3, siblingCountCensored: false });
  assert.strictEqual(sansChiffre.inSample, null, 'non fourni n est pas zero');
  assert.strictEqual(sansChiffre.gradedForward, null);
  assert.ok(/nobody told me/.test(sansChiffre.gradedForwardNote || ''),
    'et le silence doit se NOMMER, sinon un null se lit comme une donnee absente sans raison');

  /* TEMOIN — un zero EXPLICITE reste un vrai zero: sans ce cas, rendre `null` partout passerait. */
  const zeroDit = observationThin({ status: 'thin', siblingCount: 3, gradedForward: 0 });
  assert.strictEqual(zeroDit.inSample, true, 'un zero ANNONCE est une mesure, pas un silence');
  assert.strictEqual(zeroDit.gradedForward, 0);
  assert.strictEqual(zeroDit.gradedForwardNote, undefined, 'rien a expliquer quand le chiffre est la');

  const note = observationThin({ status: 'thin', siblingCount: 3, gradedForward: 12 });
  assert.strictEqual(note.inSample, false);
  assert.strictEqual(note.gradedForward, 12);
});

t('★ la divulgation refuse explicitement l affirmation sur l actif', () => {
  const o = observationThin({ status: 'thin', siblingCount: 3, siblingCountCensored: false });
  assert.strictEqual(o.disclosure, DIVULGATION);
  assert.ok(/POPULATION/.test(o.disclosure), 'la divulgation doit nommer la population');
  assert.ok(/never a claim about this asset/.test(o.disclosure),
    'elle doit interdire explicitement la lecture « ce token va rugger »');
  /* Toutes les formes, y compris les refus, portent la divulgation: c est precisement quand on ne
   * publie pas de taux qu un appelant est tente d en inferer un. */
  for (const o2 of [observationThin({ status: 'thin' }), observationThin({ status: 'unknown', siblingCount: 3, siblingCountCensored: false }),
    observationThin({ status: 'thin', siblingCount: 99 })]) {
    assert.strictEqual(o2.disclosure, DIVULGATION, 'un REFUS doit porter la divulgation lui aussi');
  }
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * LE CABLAGE: la borne devient-elle VRAIMENT verifiable en ligne ?
 *
 * Sans trace du financeur, `observedRisk` existe mais son taux est retenu POUR TOUJOURS — un champ servi
 * qui ne dit jamais rien. Le chemin branche est celui qui ne coute AUCUN appel reseau: notre propre base
 * d'observation. Ces cas verifient qu'il leve reellement la retenue, et qu'il dit d'ou vient le chiffre.
 *
 * ⚠️ Base FABRIQUEE et injectee: lire la vraie base ferait bouger la reponse a chaque run du radar, et un
 * test dont le resultat change tout seul finit desactive.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { vetMeme } = require('../lib/meme');
const { _clearCache } = require('../lib/funder-history');

const ADR = '0x' + 'a'.repeat(40);
const HORS = '0x' + 'b'.repeat(40);
const paires = (adr) => ({ pairs: [{ chainId: 'base', baseToken: { symbol: 'TEST', address: adr, name: 'T' },
  liquidity: { usd: 500000 }, volume: { h24: 1 }, url: 'https://x' }] });

/* ⛔ `siblingCountCensored` FAIT PARTIE DE LA FIXTURE, et son absence est un cas a part entiere.
 * Un enregistrement sans ce drapeau ne prouve PAS que le compte est complet — c'est le troisieme etat,
 * et le service retient desormais dessus. Le defaut par defaut est donc `false` ici (compte etabli),
 * et le cas « drapeau absent » est teste explicitement plus bas. */
function baseFabriquee(siblingCount, censored = false) {
  const p = path.join(os.tmpdir(), 'thin-risk-db-' + siblingCount + '-' + String(censored) + '.json');
  const ligne = { siblingCount, lastSeen: '2026-08-09T00:00:00.000Z' };
  if (censored !== null) ligne.siblingCountCensored = censored;
  fs.writeFileSync(p, JSON.stringify({ [ADR]: ligne }));
  return p;
}

t('★ CABLAGE — un token que ce noeud a deja observe leve la retenue, sans appel reseau', async () => {
  _clearCache();
  const db = baseFabriquee(3);
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', address: ADR, dbPath: db,
    fetchImpl: async () => paires(ADR) });
  assert.ok(r.observedRisk, 'le champ doit exister');
  assert.strictEqual(r.observedRisk.boundChecked, true, 'la borne doit etre verifiee depuis notre base');
  assert.strictEqual(r.observedRisk.siblingCount, 3);
  assert.strictEqual(r.observedRisk.siblingCountSource, 'this node own observation',
    'la PROVENANCE doit voyager: un chiffre sans elle se lit comme verifie a l instant');
  assert.strictEqual(r.observedRisk.siblingCountObservedAt, '2026-08-09T00:00:00.000Z');
  assert.ok(typeof r.observedRisk.rate === 'number', 'un taux doit sortir: ' + JSON.stringify(r.observedRisk));
});

t('★ CABLAGE, cas OPPOSE — un token jamais observe garde sa retenue et DIT pourquoi', async () => {
  _clearCache();
  const db = baseFabriquee(3);
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', address: HORS, dbPath: db,
    fetchImpl: async () => paires(HORS) });
  assert.strictEqual(r.observedRisk.rate, null, 'rien ne doit se publier sur un token inconnu de nous');
  assert.strictEqual(r.observedRisk.boundChecked, false);
  assert.ok(/never been observed/.test(r.observedRisk.siblingCountSource),
    'la source doit dire pourquoi la retenue tient: ' + r.observedRisk.siblingCountSource);
});

t('★ CABLAGE — un token observe AU-DESSUS du seuil ne publie toujours rien', async () => {
  _clearCache();
  const db = baseFabriquee(50);
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', address: ADR, dbPath: db,
    fetchImpl: async () => paires(ADR) });
  assert.strictEqual(r.observedRisk.boundChecked, true, 'la borne EST verifiee — ce n est pas une ignorance');
  assert.strictEqual(r.observedRisk.applies, false);
  assert.strictEqual(r.observedRisk.rate, null);
});

t('la valeur FOURNIE par l appelant prime sur la base, et le dit', async () => {
  _clearCache();
  const db = baseFabriquee(50);
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', address: ADR, dbPath: db, siblingCount: 2,
    fetchImpl: async () => paires(ADR) });
  assert.strictEqual(r.observedRisk.siblingCount, 2, 'l appelant a trace lui-meme, sa valeur est plus fraiche');
  assert.strictEqual(r.observedRisk.siblingCountSource, 'supplied by the caller');
  assert.strictEqual(r.observedRisk.applies, true);
});

/* ── LES DEUX ETATS QUE PERSONNE N'AVAIT BRANCHES AU BOUT: base ILLISIBLE et base ABSENTE ─────────────
 * `readingFor` les distingue depuis le 2026-07-28, `vetMeme` fait voyager `lu.detail` — mais aucun cas
 * ne l'ATTESTAIT dans la reponse payee. La distinction qui compte: « illisible » ne doit JAMAIS se lire
 * comme « jamais observe ». L'un accuse notre panne, l'autre decrit le token; les confondre fait porter
 * notre incident au token — never-accuse-on-own-incompleteness, dans une route facturee. */

t('★ base ILLISIBLE (0 octet): la panne voyage dans la source, et ne se lit PAS comme un miss', async () => {
  _clearCache();
  const zero = path.join(os.tmpdir(), 'thin-risk-db-zero.json');
  fs.writeFileSync(zero, '');
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', address: ADR, dbPath: zero,
    fetchImpl: async () => paires(ADR) });
  assert.strictEqual(r.observedRisk.rate, null, 'rien ne se publie sur une base en panne');
  assert.strictEqual(r.observedRisk.boundChecked, false);
  assert.ok(/cannot be read/.test(r.observedRisk.siblingCountSource),
    'la PANNE doit etre nommee: ' + r.observedRisk.siblingCountSource);
  assert.ok(/NOT a cold start/.test(r.observedRisk.siblingCountSource),
    'et distinguee d un demarrage a froid');
  assert.ok(!/never been observed/.test(r.observedRisk.siblingCountSource),
    'NOTRE panne ne doit jamais se lire comme une propriete du token');
});

t('★ base ABSENTE (noeud neuf): l etat NORMAL est nomme, sans accuser le token ni inventer une panne', async () => {
  _clearCache();
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', address: ADR,
    dbPath: path.join(os.tmpdir(), 'thin-risk-db-inexistante', 'tokens.json'),
    fetchImpl: async () => paires(ADR) });
  assert.strictEqual(r.observedRisk.rate, null);
  assert.ok(/no observation database/.test(r.observedRisk.siblingCountSource),
    'l absence est dite: ' + r.observedRisk.siblingCountSource);
  assert.ok(/NORMAL state/.test(r.observedRisk.siblingCountSource), 'et qualifiee de normale');
  assert.ok(!/cannot be read/.test(r.observedRisk.siblingCountSource),
    'absent et illisible ne sont pas la meme chose — dans la reponse servie aussi');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * LA GARDE DE LANGUE — et pourquoi elle vaut plus que la correction qu'elle protège.
 *
 * Mesuré le 2026-08-09: cet outil s'est mis à porter DEUX divulgations, celle de `vetMeme` en anglais
 * et la mienne en français. `till_vet_meme` est exposé à des agents TIERS via le MCP hébergé, et tout
 * le reste de la réponse — description de l'outil, `reason`, `disclosure` — est anglophone.
 *
 * ⛔ CE N'EST PAS COSMÉTIQUE. La divulgation est la pièce critique: c'est elle qui dit « jamais une
 * affirmation sur cet actif ». Une mise en garde que son lecteur ne peut pas lire n'est pas une mise
 * en garde. Et le défaut était INVISIBLE jusqu'à ce que quelqu'un compare les deux champs à la main.
 *
 * ⚠️ La garde teste la SORTIE RÉELLE de toutes les branches, jamais le texte source: un balayage du
 * fichier confondrait les commentaires — qui restent en français, c'est le style de la maison — avec
 * les chaînes servies. Elle appelle donc la fonction et regarde ce qui sort.
 *
 * ⚠️ Et les marqueurs sont choisis pour ne PAS crier au loup: des mots-outils français qui n'existent
 * pas isolés en anglais technique. Une garde qui produit des faux positifs se fait désactiver — ce
 * dépôt l'a déjà écrit à propos d'un autre garde.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */
/* ⚠️ LE JEU DE MARQUEURS A ÉTÉ CALIBRÉ EMPIRIQUEMENT, dans les deux sens, contre les 33 chaînes que ce
 * module sert réellement — pas choisi de tête. Mon premier jet (`les`, `n est`, `financeur`…) laissait
 * passer « le symbole n a pas ete verifie »: la mutation ne mordait pas, donc la garde était une
 * décoration. Ce sont des mots-outils français qui n'existent pas isolés en anglais technique. */
const MARQUEURS_FR = /\b(le|la|les|du|des|une|pas|est|sur|avec|sans|dans|pour|ce|cette|qui|par|ete|aucune?)\b/i;

/* ⛔ LES IDENTIFIANTS SONT EXCLUS, ET C'EST UNE DÉCISION, PAS UNE ÉCHAPPATOIRE.
 * `reading` nomme l'entrée gelée de `announced-rules.js` et doit rester littéralement identique des
 * deux côtés; `announcementLabel` est la prose de l'engagement, servie TELLE QUELLE pour qui veut la
 * source. Les traduire casserait la chose même qu'ils désignent. Tout le reste est de la prose servie
 * à un tiers et doit être lisible par lui. */
const IDENTIFIANTS = new Set(['reading', 'announcementLabel', 'announcedAt', 'side']);

const formesServies = () => [
  observationThin({ status: 'thin', siblingCount: 3, siblingCountCensored: false }),
  observationThin({ status: 'genuine', siblingCount: 3, siblingCountCensored: false }),
  observationThin({ status: 'thin', siblingCount: SEUIL_FRERES }),
  observationThin({ status: 'thin' }),
  observationThin({ status: 'unknown', siblingCount: 3, siblingCountCensored: false }),
  observationThin({ status: 'thin', siblingCount: 3, siblingCountCensored: false, gradedForward: 9 }),
];

const fautesDeLangue = (formes) => {
  const out = [];
  for (const o of formes) {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== 'string' || IDENTIFIANTS.has(k)) continue;
      const m = MARQUEURS_FR.exec(v);
      if (m) out.push(k + ': «' + m[1] + '» dans "' + v.slice(0, 70) + '…"');
    }
  }
  return out;
};

t('★ GARDE DE LANGUE — aucune chaine SERVIE ne part en francais', () => {
  const formes = formesServies();
  assert.strictEqual(formes.length, 6, 'sanity: les six branches doivent etre couvertes');
  const fautes = fautesDeLangue(formes);
  assert.deepStrictEqual(fautes, [],
    'chaine(s) servie(s) en francais — un agent tiers lit cette reponse:\n       ' + fautes.join('\n       '));
});

t('★ la garde MORD — teste sur les MEMES chaines, avec du francais injecte', () => {
  /* ⛔ Ce cas existe parce que la premiere version de cette garde a PASSE sa propre mutation. On ne
   * verifie donc pas la regex dans le vide: on rejoue la MEME fonction de detection sur les memes
   * formes, avec un champ remplace par du francais reel — celui-la meme qui etait passe. */
  const formes = formesServies().map((o) => ({ ...o, why: 'le symbole n a pas ete verifie' }));
  const fautes = fautesDeLangue(formes);
  assert.ok(fautes.length >= 6, 'la garde doit attraper le francais injecte dans CHAQUE forme, vu '
    + fautes.length + ' — sinon elle est une decoration');
  assert.ok(fautes.every((f) => f.startsWith('why:')), 'et elle doit nommer le champ fautif: ' + fautes[0]);
});

/* ── UN PLANCHER N'ETABLIT PAS UNE BORNE SUPERIEURE (mesure du 2026-08-10) ────────────────────────── */

t('★ cote SUR: un compte CENSURE ne prouve pas « < 20 » — le taux est RETENU', () => {
  /* `token-radar.js:660` pose `siblingCountCensored` quand l historique n a pas tenu dans le scan:
   * `siblingCount` n est alors qu une BORNE INFERIEURE. La branche « sure » etant definie par
   * `< SEUIL`, une borne SUPERIEURE, le plancher ne peut pas l etablir. Mesure: 44,2 pct de cette
   * branche reposait sur une borne absente, et les deux populations n ont rien a voir — 13,5 pct de
   * rugs cote planchers contre 76,8 cote comptes prouves. */
  const r = observationThin({ status: 'genuine', siblingCount: 5, siblingCountCensored: true });
  assert.strictEqual(r.rate, null, 'aucun taux sur une borne non etablie');
  assert.strictEqual(r.boundChecked, false);
  assert.ok(/FLOOR, not a count/.test(r.why), 'et la raison doit NOMMER le plancher: ' + r.why);
});

t('★ TEMOIN: un compte PROUVE sous le seuil sert toujours son taux', () => {
  /* Sans ce cas, retenir sur TOUS les comptes passerait le test ci-dessus et tuerait la lecture. */
  const r = observationThin({ status: 'genuine', siblingCount: 5, siblingCountCensored: false });
  assert.strictEqual(r.applies, true, 'un compte etabli reste dans la branche mesuree');
  assert.ok(typeof r.rate === 'number' && r.rate > 0, 'et il sert un taux: ' + r.rate);
});

t('★ LES DEUX COTES sont touches — toute la regle vit SOUS le seuil', () => {
  /* ⛔ J AVAIS ECRIT L INVERSE, ET C ETAIT FAUX. J ai d abord affirme une « asymetrie »: le cote danger
   * epargne parce qu un plancher de 50 prouve bien `>= 20`. Mais l annonce dit: « cote DANGER: les
   * `thin` SOUS le seuil; cote SUR: les non-`thin` SOUS le seuil ». LES DEUX cotes vivent sous 20 — le
   * `>= 20` est la branche SATUREE, ou rien ne se publie de toute facon. Mon « temoin » testait donc
   * `siblingCount: 50`, c est-a-dire ni l un ni l autre des deux cotes.
   * La censure atteint donc les DEUX cotes egalement, puisque toute la regle repose sur `< 20`. */
  for (const st of ['thin', 'genuine']) {
    const cens = observationThin({ status: st, siblingCount: 5, siblingCountCensored: true });
    assert.strictEqual(cens.rate, null, st + ': un plancher ne prouve pas « < 20 »');
    const vrai = observationThin({ status: st, siblingCount: 5, siblingCountCensored: false });
    assert.ok(typeof vrai.rate === 'number', st + ': un compte etabli sert son taux');
  }
  /* Et AU-DESSUS du seuil, la retenue vient de la SATURATION, pas de la censure — deux raisons
   * distinctes qui ne doivent pas se confondre dans le message. */
  const haut = observationThin({ status: 'thin', siblingCount: 50, siblingCountCensored: true });
  assert.strictEqual(haut.boundChecked, true, 'au-dessus du seuil, la borne EST etablie par le plancher');
  assert.ok(/ceiling dressed as a signal/.test(haut.why), 'et la raison est la saturation: ' + haut.why);
});

t('le TROISIEME etat (drapeau absent) retient aussi — « on ne sait pas » n est pas « etabli »', () => {
  const r = observationThin({ status: 'genuine', siblingCount: 5, siblingCountCensored: null });
  assert.strictEqual(r.rate, null);
  const s = observationThin({ status: 'genuine', siblingCount: 5 });   // champ totalement absent
  assert.strictEqual(s.rate, null, 'un champ ABSENT ne vaut pas `false`');
});

t('★ CABLAGE, le cas qui manquait — un token dont le compte est un PLANCHER retient', async () => {
  /* ⛔ 1183 des 2339 lignes de la vraie base n ont PAS ce drapeau, et 925 l ont a `true`. Ce cas verifie
   * que la retenue traverse toute la chaine `funder-history` -> `meme` -> `thin-risk`, et pas seulement
   * le module pur — c est la composition qui sert, pas la fonction isolee. */
  _clearCache();
  const db = baseFabriquee(3, true);
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', address: ADR, dbPath: db,
    fetchImpl: async () => paires(ADR) });
  assert.ok(r.observedRisk, 'le champ doit exister');
  assert.strictEqual(r.observedRisk.rate, null, 'aucun taux sur une borne non etablie');
  assert.strictEqual(r.observedRisk.boundChecked, false);
  assert.ok(/FLOOR, not a count/.test(r.observedRisk.why), r.observedRisk.why);
});

/* 22 -> 24 le 2026-08-16: les deux etats jamais attestes dans la reponse payee — base ILLISIBLE
 * (la panne voyage et ne se lit pas comme un miss) et base ABSENTE (l etat normal est nomme). */
/* ══ LE REPLI SUR LE CANONIQUE — LE CHEMIN QUE LA FICHE VEND, ET LE SEUL QUI NE LISAIT RIEN ═══════
 * `address` est OPTIONNEL sur `till_vet_meme`, et sa description promet: « omit it and this node checks
 * its own observation database for free ». Or le repli passait `canonical`, un OBJET, la ou
 * `readingFor` attend une chaine — il tombait donc sur la garde d entree et rendait `miss` SANS
 * jamais ouvrir la base. Mesure du 2026-08-19, meme token et meme base fabriquee:
 *     avec `address`  -> siblingCount=3, boundChecked=true,  rate=0.189
 *     sans `address`  -> siblingCount=undef, boundChecked=false, rate=null
 * ⚠️ Les quatre cas ci-dessous tiennent les DEUX bornes: le repli doit LIRE, et il ne doit surtout pas
 * elargir le refus — une adresse malformee FOURNIE par l appelant garde sa phrase d entree rejetee. */

t('★ REPLI — sans `address`, un token observe leve la retenue VIA LE CANONIQUE', async () => {
  _clearCache();
  const db = baseFabriquee(3);
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', dbPath: db,
    fetchImpl: async () => paires(ADR) });
  assert.strictEqual(r.canonical.address, ADR, 'le canonique est bien celui de la base fabriquee');
  assert.strictEqual(r.observedRisk.siblingCount, 3,
    'le repli doit LIRE: il passait un objet a une garde qui attend une chaine');
  assert.strictEqual(r.observedRisk.boundChecked, true);
  assert.strictEqual(r.observedRisk.siblingCountSource, 'this node own observation');
  assert.ok(typeof r.observedRisk.rate === 'number', 'le taux doit sortir sans appel reseau');
  assert.ok(!/not a 0x address/.test(r.observedRisk.siblingCountSource),
    'NOTRE cablage rate ne doit jamais se lire comme une faute de frappe de l appelant');
});

t('★ REPLI, cas OPPOSE — un canonique que ce noeud n a jamais vu garde sa retenue', async () => {
  _clearCache();
  const db = baseFabriquee(3);
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', dbPath: db,
    fetchImpl: async () => paires(HORS) });
  assert.strictEqual(r.canonical.address, HORS);
  assert.strictEqual(r.observedRisk.rate, null, 'rien ne se publie sur un token inconnu de nous');
  assert.strictEqual(r.observedRisk.boundChecked, false);
  assert.ok(/never been observed/.test(r.observedRisk.siblingCountSource),
    'la base A ETE consultee et n a rien: ' + r.observedRisk.siblingCountSource);
});

t('★ RIEN A CHERCHER — ni address ni canonique: on le DIT, sans inventer une entree malformee', async () => {
  _clearCache();
  const db = baseFabriquee(3);
  const maigre = { pairs: [{ chainId: 'base', baseToken: { symbol: 'TEST', address: ADR, name: 'T' },
    liquidity: { usd: 5 }, volume: { h24: 1 }, url: 'https://x' }] };
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', dbPath: db, fetchImpl: async () => maigre });
  assert.strictEqual(r.status, 'thin');
  assert.strictEqual(r.canonical, null);
  assert.strictEqual(r.observedRisk.rate, null);
  assert.ok(/no address to look up/.test(r.observedRisk.siblingCountSource),
    'l absence de cible est nommee: ' + r.observedRisk.siblingCountSource);
  assert.ok(/gap in this answer, not a finding about the token/.test(r.observedRisk.siblingCountSource),
    'notre trou ne doit pas se lire comme une propriete du token');
  assert.ok(!/not a 0x address/.test(r.observedRisk.siblingCountSource),
    'personne n a fourni d adresse: aucune faute d entree a reprocher');
});

t('★ BORNE INVERSE — une adresse MALFORMEE fournie garde bien sa phrase d entree rejetee', async () => {
  _clearCache();
  const db = baseFabriquee(3);
  const r = await vetMeme({ symbol: 'TEST', chainId: 'base', address: 'pas-une-adresse', dbPath: db,
    fetchImpl: async () => paires(ADR) });
  assert.strictEqual(r.status, 'unknown');
  assert.ok(/not a 0x address of 40 hex/.test(r.observedRisk.siblingCountSource),
    'ici l appelant A fourni une entree fautive, et le refus doit le dire: '
    + r.observedRisk.siblingCountSource);
  assert.ok(!/no address to look up/.test(r.observedRisk.siblingCountSource),
    'ne PAS elargir: une adresse fournie et illisible n est pas une absence d adresse');
});

/* 24 -> 28 le 2026-08-19: le repli sur le canonique ne lisait jamais la base (objet passe a une garde
 * qui attend une chaine), les deux bornes du refus, et le cas ou il n y a rien a chercher. */
const ATTENDUS = 28;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
