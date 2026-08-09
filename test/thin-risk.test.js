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
    assert.ok(/RETENU/.test(o.why), 'la raison doit dire que le taux est retenu: ' + o.why);
    assert.ok(typeof o.howToCheck === 'string', 'il faut dire COMMENT lever la retenue');
  }
});

t('★ financeur AU-DESSUS du seuil: la borne est verifiee et le taux reste retenu', () => {
  const o = observationThin({ status: 'thin', siblingCount: SEUIL_FRERES });
  assert.strictEqual(o.boundChecked, true, 'la borne EST verifiee, ce n est pas une ignorance');
  assert.strictEqual(o.applies, false);
  assert.strictEqual(o.rate, null, 'au-dessus du seuil, publier un taux serait publier un plafond');
  assert.ok(/plafond/.test(o.why), o.why);
});

t('★ symbole NON verifie: « pas verifie » n est pas « pas thin »', () => {
  for (const s of ['not_a_candidate', 'unknown', undefined, null, 42]) {
    const o = observationThin({ status: s, siblingCount: 3 });
    assert.strictEqual(o.rate, null, 'status=' + String(s) + ' ne doit rien publier');
    assert.ok(/n est pas/.test(o.why), o.why);
  }
});

/* ── 2. CE QUI SE PUBLIE, ET SEULEMENT LA ─────────────────────────────────────────────────────────── */

t('dans la branche mesuree, `thin` sert le taux DANGER de l annonce', () => {
  const o = observationThin({ status: 'thin', siblingCount: 3 });
  assert.strictEqual(o.applies, true);
  assert.strictEqual(o.side, 'danger');
  assert.strictEqual(o.rate, PARI.predicted.dangerRate, 'le taux servi doit etre CELUI DU PARI');
  assert.strictEqual(o.baseRate, PARI.basis.baseRate, 'la base doit voyager avec le taux');
  assert.strictEqual(o.funders, PARI.basis.dangerFunders);
});

t('dans la branche mesuree, un symbole VERIFIE non-thin sert le taux SUR', () => {
  const o = observationThin({ status: 'genuine', siblingCount: 3 });
  assert.strictEqual(o.side, 'safe');
  assert.strictEqual(o.rate, PARI.predicted.safeRate);
  assert.strictEqual(o.funders, PARI.basis.safeFunders);
});

t('★ TEMOIN — les deux cotes ne servent pas le meme chiffre', () => {
  const d = observationThin({ status: 'thin', siblingCount: 3 });
  const s = observationThin({ status: 'genuine', siblingCount: 3 });
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
  const o = observationThin({ status: 'thin', siblingCount: 1 });
  /* Si quelqu un recopiait 0.884 en dur ici, ce test passerait aujourd hui et mentirait le jour ou
   * l annonce serait remplacee par une entree neuve. On verifie donc l IDENTITE avec la source. */
  assert.strictEqual(o.rate, PARI.predicted.dangerRate);
  assert.strictEqual(o.announcedAt, PARI.announcedAt);
  assert.strictEqual(o.label, PARI.label);
});

/* ── 4. CE QUE LA REPONSE DOIT DIRE D ELLE-MEME ───────────────────────────────────────────────────── */

t('★ l etat IN-SAMPLE est dit, pas cache', () => {
  assert.strictEqual(observationThin({ status: 'thin', siblingCount: 3 }).inSample, true,
    'a zero appel note, la mesure est in-sample et doit le dire');
  assert.strictEqual(observationThin({ status: 'thin', siblingCount: 3, gradedForward: 12 }).inSample, false);
  assert.strictEqual(observationThin({ status: 'thin', siblingCount: 3, gradedForward: 12 }).gradedForward, 12);
});

t('★ la divulgation refuse explicitement l affirmation sur l actif', () => {
  const o = observationThin({ status: 'thin', siblingCount: 3 });
  assert.strictEqual(o.disclosure, DIVULGATION);
  assert.ok(/POPULATION/.test(o.disclosure), 'la divulgation doit nommer la population');
  assert.ok(/jamais une affirmation sur cet/.test(o.disclosure),
    'elle doit interdire explicitement la lecture « ce token va rugger »');
  /* Toutes les formes, y compris les refus, portent la divulgation: c est precisement quand on ne
   * publie pas de taux qu un appelant est tente d en inferer un. */
  for (const o2 of [observationThin({ status: 'thin' }), observationThin({ status: 'unknown', siblingCount: 3 }),
    observationThin({ status: 'thin', siblingCount: 99 })]) {
    assert.strictEqual(o2.disclosure, DIVULGATION, 'un REFUS doit porter la divulgation lui aussi');
  }
});

const ATTENDUS = 11;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
