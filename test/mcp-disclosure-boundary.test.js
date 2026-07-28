#!/usr/bin/env node
'use strict';
/**
 * LES DIVULGATIONS SURVIVENT-ELLES A LA FRONTIERE MCP ?
 *
 * C'est la garde qui manquait, et c'est la lecon de la journee du 2026-07-28.
 *
 * Le defaut fondateur: `lib/screen.js` refusait explicitement d'appeler son zero un verdict propre — il
 * rendait `{blocked:false, available:false, reason:"screening UNAVAILABLE, not a clean verdict"}` — et
 * `vetAgent`, une couche au-dessus, aplatissait les deux cas sur le meme `knownBad:false`. La couche du
 * dessous etait prudente; celle du dessus a jete la distinction. Le defaut n'etait visible dans AUCUN des
 * deux modules: seulement en les comparant.
 *
 * La meme chose peut se rejouer un cran plus haut. Une douzaine de champs de divulgation ont ete ajoutes
 * dans `lib/` ce jour-la — `screen`, `unscreened`, `coverage`, `transfersRead`, `not_scanned`,
 * `database_unreadable`, `unreadable`, `stoppedBecause`, `calldataDecoded`… Chacun ne vaut que s'il
 * ATTEINT l'appelant. Un handler MCP qui reconstruit un litteral peut en perdre un sans que rien ne
 * rougisse: la bibliotheque est testee, le handler est teste, et le champ disparait entre les deux.
 *
 * ⚠️ CE FICHIER APPELLE LE VRAI HANDLER (`callTool`), jamais la bibliotheque. C'est tout l'interet: un
 * test qui interroge `lib/` ne peut pas voir une perte a la frontiere. Tester par le PRODUCTEUR final.
 *
 * Hors ligne uniquement — aucun cas ne depend d'un reseau, sinon il basculerait avec la meteo et on
 * apprendrait a ignorer son rouge.
 */
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { callTool, TOOLS } = require('../bin/biii-mcp.js');

let pass = 0, fail = 0;
const t = (nom, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ok   ' + nom); },
  (e) => { fail++; console.log('  FAIL ' + nom + '\n       ' + (e && e.message)); });

/* Un bac temporaire, supprime a la fin et la suppression ASSERTEE: des artefacts de test ont pollue de
 * vrais repertoires de donnees deux fois cette semaine. */
const BAC = path.join(os.tmpdir(), 'biii-mcp-frontiere-' + process.pid);

(async () => {
  console.log('les divulgations survivent-elles a la frontiere MCP ?\n');

  fs.mkdirSync(BAC, { recursive: true });
  fs.writeFileSync(path.join(BAC, 'notes.txt'), 'du texte parfaitement ordinaire');
  fs.writeFileSync(path.join(BAC, 'photo.png'), 'pas vraiment une image');

  /* Chaque entree: l'outil, ses arguments HORS LIGNE, et les chemins de champs qui DOIVENT arriver.
   * `null` est une valeur legitime — on teste la PRESENCE de la cle, pas sa verite. */
  const lire = (o, chemin) => chemin.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  const aLaCle = (o, chemin) => {
    const parts = chemin.split('.');
    const dernier = parts.pop();
    const parent = parts.reduce((x, k) => (x == null ? x : x[k]), o);
    return !!parent && Object.prototype.hasOwnProperty.call(parent, dernier);
  };

  const CAS = [
    ['till_seed_exposure', { paths: [BAC] },
      ['coverage', 'complete', 'skipped.absent', 'skipped.notTextual', 'disclosure'],
      'scanPaths: `complete` melangeait portee voulue et couverture perdue, donc ne variait jamais'],
    ['till_vet_agent', { payTo: '0x' + '1'.repeat(40) },
      ['payment.screen', 'payment.screenReason', 'payment.knownBad'],
      'agent-vet: un crible qui n a pas tourne ressemblait a un crible propre'],
    ['till_funder_history', { funder: '0x' + '2'.repeat(40) },
      ['verdict', 'reason', 'stale', 'observedTokens'],
      'funder-history: base ABSENTE et base ILLISIBLE rendaient la meme phrase'],
    ['till_key_exposure', { paths: [BAC] },
      ['disclosure'],
      'keyscan: un dossier verrouille rendait un tableau vide'],
  ];

  for (const [outil, args, champs, pourquoi] of CAS) {
    let sortie;
    try { sortie = await callTool(outil, args); }
    catch (e) { await t(outil + ' repond sans jeter', () => { throw e; }); continue; }

    await t(outil + ' rend un objet', () => {
      assert.strictEqual(typeof sortie, 'object');
      assert.notStrictEqual(sortie, null);
    });

    for (const champ of champs) {
      await t(outil + ' preserve `' + champ + '`', () => {
        assert.ok(aLaCle(sortie, champ),
          'champ PERDU a la frontiere MCP: ' + champ + '\n       la bibliotheque le produit, le handler '
          + 'ne le transmet pas.\n       Pourquoi il existe: ' + pourquoi);
      });
    }
  }

  /* ⚠️ CONTROLE D'INSTRUMENT. Sans lui, une erreur dans `aLaCle` rendrait tout vert et ce fichier
   * certifierait une frontiere qu'il n'a jamais examinee — le succes vide, exactement ce qu'il traque. */
  await t('le detecteur de champ manquant MORD (temoin negatif)', () => {
    const faux = { a: { b: 1 } };
    assert.strictEqual(aLaCle(faux, 'a.b'), true, 'doit voir un champ present');
    assert.strictEqual(aLaCle(faux, 'a.zzz'), false, 'doit voir un champ absent');
    assert.strictEqual(aLaCle(faux, 'zzz.b'), false, 'doit survivre a un parent absent');
    /* Une valeur `null` ou `false` EST une divulgation valide: on teste la cle, pas la verite. */
    assert.strictEqual(aLaCle({ x: null }, 'x'), true, 'null est une valeur, pas une absence');
    assert.strictEqual(aLaCle({ x: false }, 'x'), true, 'false est une valeur, pas une absence');
  });

  /* Le catalogue et les handlers doivent parler du meme ensemble d'outils: un outil annonce que
   * `callTool` ne sait pas traiter est une promesse vide. */
  await t('chaque outil teste ici est bien annonce dans le catalogue', () => {
    const annonces = new Set((TOOLS || []).map((x) => x.name));
    for (const [outil] of CAS) assert.ok(annonces.has(outil), outil + ' absent du catalogue TOOLS');
  });

  fs.rmSync(BAC, { recursive: true, force: true });
  await t('le bac temporaire a bien ete supprime', () => {
    assert.strictEqual(fs.existsSync(BAC), false);
  });

  /* ── LA MEME ENTREE, LE MEME REFUS, SUR TOUS LES OUTILS ────────────────────────────────────────
   * `till_trust` refusait deja une adresse malformee; les autres outils prenant une adresse ne le
   * faisaient pas. Mesure du 2026-07-28 via le VRAI handler, meme entree `0x123`:
   *
   *   till_trust -> REFUS   |   till_vet_merchant -> VERDICT   |   till_rug_powers -> VERDICT
   *
   * Et le plus couteux n'etait pas l'absence de refus. `till_vet_merchant` envoyait la chaine a
   * l'oracle, recevait un HTTP 400, et le rendait comme « oracle unreachable (HTTP 400) — treat the
   * merchant as UNKNOWN ». Deux causes OPPOSEES sur un meme message: « mon entree est invalide » et
   * « le service est tombe ». La difference est actionnable, et un agent qui a fait une faute de frappe
   * etait invite a reessayer une panne qui n'existait pas. */
  const OUTILS_ADRESSE = [['till_trust', 'counterparty'], ['till_vet_merchant', 'address'],
    ['till_rug_powers', 'address'], ['till_launch_funder', 'address']];
  const MALFORMEES = ['0x123', '', 'pas-une-adresse', '0x' + 'g'.repeat(40), '0x' + 'a'.repeat(41), null];

  for (const [outil, champ] of OUTILS_ADRESSE) {
    const refus = [];
    for (const bad of MALFORMEES) {
      let r; try { r = await callTool(outil, { [champ]: bad }); } catch (e) { r = { jete: e.message }; }
      refus.push({ bad, r });
    }
    await t('★ ' + outil + ' refuse TOUTE adresse malformee, sans composer de verdict', () => {
      for (const { bad, r } of refus) {
        assert.ok(r && r.error, JSON.stringify(bad) + ' doit etre refuse, vu: ' + JSON.stringify(r).slice(0, 80));
        assert.match(r.error, /must be a 0x Base address/i, JSON.stringify(bad));
        /* Le point qui compte pour l'appelant: savoir si c'est SON entree ou NOTRE service. */
        assert.match(r.error, /REJECTED INPUT, not a service outage/i, JSON.stringify(bad));
        assert.ok(!r.decision && !r.trust && !r.verdict, 'aucun verdict ne doit accompagner un refus');
      }
    });
  }

  /* BORNE INVERSE: le durcissement ne doit pas refuser une adresse VALIDE, y compris checksummee. */
  const VALIDE = '0x' + 'a'.repeat(40);
  const CHECKSUM = '0x' + 'aA'.repeat(20);
  const acceptes = [];
  for (const [outil, champ] of OUTILS_ADRESSE) {
    for (const forme of [VALIDE, CHECKSUM]) {
      let r; try { r = await callTool(outil, { [champ]: forme }); } catch (e) { r = { jete: e.message }; }
      acceptes.push({ outil, forme, r });
    }
  }
  await t('LES DEUX BORNES: une adresse valide (meme checksummee) n est JAMAIS refusee par le garde', () => {
    for (const { outil, forme, r } of acceptes) {
      const refusParGarde = r && r.error && /REJECTED INPUT/.test(r.error);
      assert.ok(!refusParGarde, outil + ' a refuse ' + forme + ' — le garde mange une entree legitime');
      /* Une erreur METIER reste permise ici (hors ligne, adresse inexistante): ce qu'on interdit, c'est
       * que le GARDE la rejette. Confondre les deux m'a fait lire une regression qui n'existait pas. */
    }
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log('  FAIL harnais async: ' + (e && e.message));
  console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
