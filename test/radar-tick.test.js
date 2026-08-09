#!/usr/bin/env node
'use strict';
/**
 * radar-tick: ce qui se teste ici, c'est ce qui casserait EN PRODUCTION SANS QUE PERSONNE LE VOIE.
 *
 * Trois defauts precis sont vises, chacun deja paye ailleurs dans ce depot:
 *
 *   1. L'ECRASEMENT SILENCIEUX. Le depot embarque un instantane commite de la base. Si l'amorcage
 *      recopie cet instantane par-dessus un volume qui porte deja des heures d'observations, chaque
 *      redeploiement efface ce que le radar vient de collecter — et un redeploiement est justement le
 *      moment ou personne ne regarde. Le cas « le volume porte deja une base » est donc teste comme un
 *      cas de REFUS, pas comme un detail.
 *   2. LE MODULE INERTE QUI SE LIT COMME UN MODULE QUI MARCHE. Sans `RADAR_TICK_MINUTES` rien ne se
 *      planifie; le test exige que la RAISON soit rendue, parce qu'un retour neutre muet devient une
 *      affirmation chez l'appelant.
 *   3. LA PANNE QUI REMONTE. Ce module partage son processus avec l'endpoint x402 payant. Un radar qui
 *      jette ne doit pas pouvoir couper l'encaissement — c'est teste en faisant EFFECTIVEMENT jeter.
 *
 * ⚠️ Et un TEMOIN: les memes fonctions appelees avec des entrees OPPOSEES doivent rendre des sorties
 * differentes. Une sortie constante passerait tous les tests ci-dessus sans rien decider.
 */
const assert = require('node:assert');
const { planRadarStorage, applyRadarStorage, planTick, planDemarrage, ageBaseMinutes,
  startRadarTicks } = require('../lib/radar-tick');

/* ⛔ LE HARNAIS COMPTE SES PROPRES CAS, ET IL SAIT ATTENDRE. Un `t()` synchrone qui recoit une fonction
 * rendant une Promise la marque « ok » immediatement: l'assertion tombe APRES le bilan et le cas passe
 * sans avoir rien verifie. Ce depot a deja paye une suite qui se comptait mal (« 473 » etait 690). Ici
 * chaque cas est enregistre, attendu, et un cas qui n'assere RIEN est un echec. */
let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
/* La DECLARATION dit qu elle empile: c est la forme que le meta-garde de `test/suite-coverage.test.js`
 * reconnait comme sure, et il ne lit que cette ligne. Un `try { fn() }` sur une ligne y ressemblerait a
 * un harnais synchrone — et en serait un pour tout corps `async`, dont la promesse rejetee passerait a
 * cote du `catch`. */
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('radar-tick: faire tourner le radar sans pouvoir tuer la caisse');

/* Une vue de disque fabriquee: `etats` associe un chemin a ce qu on y trouverait. */
const vue = (etats) => (p) => etats[p] || { exists: false };
const REPO = '/app/data/token-radar';
const VOL = '/data';
const VOLDIR = '/data/token-radar';

/* ── 1. LE REFUS QUI PROTEGE LES DONNEES VIVANTES ─────────────────────────────────────────────────── */

t('volume portant DEJA une base: aucun amorcage, donc aucun ecrasement', () => {
  const p = planRadarStorage({ repoDir: REPO, volumeRoot: VOL,
    inspect: vue({ [VOLDIR]: { exists: true, hasDb: true }, [REPO]: { exists: true, hasDb: true } }) });
  assert.strictEqual(p.mode, 'volume');
  assert.ok(!p.actions.includes('seed'), 'seed present alors que le volume porte deja une base: '
    + JSON.stringify(p.actions));
  assert.ok(/AUCUN ecrasement/.test(p.raison), 'la raison doit dire pourquoi on refuse: ' + p.raison);
});

t('volume VIDE et depot fourni: amorcage unique', () => {
  const p = planRadarStorage({ repoDir: REPO, volumeRoot: VOL,
    inspect: vue({ [VOLDIR]: { exists: false }, [REPO]: { exists: true, hasDb: true } }) });
  assert.ok(p.actions.includes('seed'), 'amorcage attendu: ' + JSON.stringify(p.actions));
  assert.strictEqual(p.dir, VOLDIR);
});

t('ni volume ni depot ne portent de base: on cree, on n amorce pas', () => {
  const p = planRadarStorage({ repoDir: REPO, volumeRoot: VOL,
    inspect: vue({ [VOLDIR]: { exists: false }, [REPO]: { exists: true, hasDb: false } }) });
  assert.ok(p.actions.includes('mkdir'), JSON.stringify(p.actions));
  assert.ok(!p.actions.includes('seed'), 'rien a amorcer, seed ne doit pas apparaitre');
});

t('repoDir deja un lien: on ne relie pas deux fois', () => {
  const p = planRadarStorage({ repoDir: REPO, volumeRoot: VOL,
    inspect: vue({ [VOLDIR]: { exists: true, hasDb: true }, [REPO]: { exists: true, isSymlink: true } }) });
  assert.ok(!p.actions.includes('link'), JSON.stringify(p.actions));
});

/* ── 2. LE CAS NORMAL HORS RAILWAY, QUI DOIT SE DIRE ──────────────────────────────────────────────── */

t('aucun volume monte: mode depot, et la RAISON est rendue', () => {
  for (const vr of [undefined, '', '   ']) {
    const p = planRadarStorage({ repoDir: REPO, volumeRoot: vr, inspect: vue({}) });
    assert.strictEqual(p.mode, 'repo', 'volumeRoot=' + JSON.stringify(vr));
    assert.deepStrictEqual(p.actions, []);
    assert.ok(p.raison.length > 20, 'un retour neutre MUET devient une affirmation chez l appelant');
    assert.ok(/comme en local/.test(p.raison), 'la raison doit dire que ce n est PAS une panne: ' + p.raison);
  }
});

/* ── 3. LE TEMOIN: LES SORTIES NE SONT PAS CONSTANTES ─────────────────────────────────────────────── */

t('temoin — volume present contre absent donnent des modes DIFFERENTS', () => {
  const avec = planRadarStorage({ repoDir: REPO, volumeRoot: VOL,
    inspect: vue({ [VOLDIR]: { exists: true, hasDb: true } }) });
  const sans = planRadarStorage({ repoDir: REPO, volumeRoot: undefined, inspect: vue({}) });
  assert.notStrictEqual(avec.mode, sans.mode, 'sortie constante: le parametre n est lu par personne');
  assert.notStrictEqual(avec.dir, sans.dir);
});

/* ── 4. LE TICK: UN SEUL RUN A LA FOIS, ET UNE RAISON A CHAQUE REFUS ──────────────────────────────── */

t('planTick refuse sans minutes valides, et dit pourquoi', () => {
  for (const m of [undefined, null, 0, -5, NaN, Infinity, 'abc']) {
    const d = planTick({ minutes: m, running: false });
    assert.strictEqual(d.run, false, 'minutes=' + String(m) + ' ne doit pas lancer');
    assert.ok(/ne tourne PAS ici|invalide/.test(d.raison), 'raison muette pour ' + String(m));
  }
});

t('planTick saute si un run est en cours — deux radars ecriraient la meme base', () => {
  assert.strictEqual(planTick({ minutes: 60, running: true }).run, false);
  assert.strictEqual(planTick({ minutes: 60, running: false }).run, true);
});

/* ── 5. LA PREPARATION QUI ECHOUE NE DOIT PAS JETER ───────────────────────────────────────────────── */

t('applyRadarStorage rend l erreur au lieu de la lancer', () => {
  const plan = { dir: VOLDIR, actions: ['seed'], mode: 'volume', raison: '' };
  const r = applyRadarStorage(plan, {
    repoDir: REPO,
    mkdirp: () => { throw new Error('EACCES: volume en lecture seule'); },
    copyDir: () => {}, replaceWithLink: () => {},
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/EACCES/.test(r.erreur), 'l erreur doit etre rendue telle quelle: ' + r.erreur);
  assert.deepStrictEqual(r.faites, [], 'rien ne doit etre marque fait quand la premiere action jette');
});

/* ── 6. CE QUI PROTEGE LA CAISSE ──────────────────────────────────────────────────────────────────── */

t('sans RADAR_TICK_MINUTES: INACTIF, et le journal le dit', () => {
  const dit = [];
  const r = startRadarTicks({ minutes: null, log: (s) => dit.push(s),
    planifier: () => { throw new Error('rien ne doit etre planifie'); } });
  assert.strictEqual(r.actif, false);
  assert.ok(dit.some((s) => /INACTIF/.test(s)), 'un demarrage muet se lit comme un demarrage reussi');
});

t('un radar qui JETTE ne fait pas tomber le processus de la caisse', async () => {
  const dit = [];
  let planifie = null;
  const r = startRadarTicks({
    minutes: 60, repoDir: REPO, volumeRoot: undefined, inspect: vue({}), io: {},
    lancer: () => { throw new Error('radar: OOM'); },
    log: (s) => dit.push(s), planifier: (fn) => { planifie = fn; return { unref() {} }; },
  });
  assert.strictEqual(r.actif, true);
  assert.strictEqual(typeof planifie, 'function', 'le tick doit avoir ete planifie');
  /* Le point du test: appeler le tick ne doit RIEN propager. */
  return Promise.resolve(r._tick()).then(() => {
    assert.ok(dit.some((s) => /ECHOUE/.test(s)), 'la panne doit etre DITE: ' + JSON.stringify(dit));
  });
});

t('un radar qui sort non-zero est signale comme tel, pas avale', async () => {
  const dit = [];
  const r = startRadarTicks({
    minutes: 60, repoDir: REPO, volumeRoot: undefined, inspect: vue({}), io: {},
    lancer: () => Promise.resolve({ code: 3 }),
    log: (s) => dit.push(s), planifier: () => ({ unref() {} }),
  });
  return Promise.resolve(r._tick()).then(() => {
    assert.ok(dit.some((s) => /code 3/.test(s) && /a echoue/.test(s)),
      'un code non nul doit apparaitre ET etre qualifie: ' + JSON.stringify(dit));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * LE RATTRAPAGE DE DEMARRAGE — et le trou qu il ouvrirait s il etait inconditionnel.
 *
 * Sans lui: `setInterval` ne tire qu a T+60 min, donc un conteneur qui redemarre plus souvent ne
 * collecte JAMAIS pendant que le journal affiche « ACTIF » a chaque demarrage. Un instrument mort
 * indiscernable d un instrument vert — le motif de ce depot.
 * Avec lui, INCONDITIONNEL: une boucle de plantage relancerait une collecte complete a chaque
 * redemarrage, sur le seul endpoint qui sert des getLogs larges sur Base et sans repli gratuit.
 * D ou la condition sur l AGE, et les deux directions sont testees.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

t('age ILLISIBLE: on collecte — ne pas pouvoir lire n est pas une preuve de fraicheur', () => {
  for (const a of [null, undefined, NaN, 'abc', Infinity]) {
    const d = planDemarrage({ minutes: 60, ageMinutes: a });
    assert.strictEqual(d.run, true, 'age=' + String(a) + ' doit declencher le rattrapage');
    assert.ok(/ILLISIBLE/.test(d.raison), 'la raison doit dire que l age manque: ' + d.raison);
  }
});

t('base en retard: rattrapage — base fraiche: pas de rattrapage (les DEUX sens)', () => {
  const retard = planDemarrage({ minutes: 60, ageMinutes: 180 });
  const frais = planDemarrage({ minutes: 60, ageMinutes: 5 });
  assert.strictEqual(retard.run, true, 'trois heures de retard doivent rattraper');
  assert.strictEqual(frais.run, false, 'cinq minutes ne justifient pas une collecte complete');
  assert.ok(/retard de 180 min/.test(retard.raison), retard.raison);
  assert.ok(/rien a rattraper/.test(frais.raison), frais.raison);
  /* La BORNE voyage avec le chiffre: l intervalle est nomme dans les deux raisons. */
  assert.ok(/60/.test(retard.raison) && /60/.test(frais.raison), 'l intervalle doit apparaitre');
});

t('radar inactif: aucun rattrapage, quel que soit l age', () => {
  for (const a of [null, 9999]) {
    assert.strictEqual(planDemarrage({ minutes: 0, ageMinutes: a }).run, false);
  }
});

t('ageBaseMinutes sur un dossier illisible rend null, il ne jette pas', () => {
  assert.strictEqual(ageBaseMinutes('/chemin/qui/n/existe/pas'), null);
});

t('demarrage: une base EN RETARD planifie le rattrapage, une base FRAICHE non', () => {
  const fait = (age) => {
    let differe = null;
    const r = startRadarTicks({
      minutes: 60, ageMinutes: age, repoDir: REPO, volumeRoot: undefined, inspect: vue({}), io: {},
      lancer: () => Promise.resolve({ code: 0 }), log: () => {},
      planifier: () => ({ unref() {} }), differer: (fn) => { differe = fn; return { unref() {} }; },
    });
    return { differe, r };
  };
  const retard = fait(180), frais = fait(5);
  assert.strictEqual(typeof retard.differe, 'function', 'une base en retard doit planifier un rattrapage');
  assert.strictEqual(frais.differe, null, 'une base fraiche ne doit RIEN planifier au demarrage');
  /* Temoin: les deux appels different bien par leur decision, pas par hasard. */
  assert.strictEqual(retard.r.rattrapage.run, true);
  assert.strictEqual(frais.r.rattrapage.run, false);
});

/* Le bilan attend les cas asynchrones. Et il verifie son PROPRE compte: une suite qui n a rien
 * execute doit echouer bruyamment plutot que d imprimer « 0 passed, 0 failed » et sortir 0. */
const ATTENDUS = 17;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus — un cas'
      + ' a ete saute ou ajoute sans mettre ce compte a jour');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
