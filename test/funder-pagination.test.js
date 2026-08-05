#!/usr/bin/env node
'use strict';
/**
 * funder-pagination — « combien de portefeuilles ce financeur a-t-il payes ? » etait une BORNE, pas un compte.
 * ============================================================================================================
 *
 * `traceFeeder` lisait UNE page de l'historique sortant du financeur. Une page vaut 50 TRANSACTIONS, mais
 * `siblingCount` compte des DESTINATAIRES DISTINCTS: un financeur qui renvoie plusieurs fois aux memes
 * portefeuilles remplit la page en paraissant minuscule. Le chiffre publie n'etait donc pas petit parce que
 * le financeur etait petit — il etait petit parce qu'on avait arrete de lire.
 *
 * MESURE DU 2026-08-04 sur la base reelle (981 tokens portant un compte):
 *
 *     censures (planchers)   708    p50=50  p75=50  p90=50     colles au plafond de pagination
 *     lus en entier          160    p50=1   p75=1   p90=2      143 des 160 valent <= 1
 *
 * 72 % des comptes etaient des planchers. Et en re-parcourant 42 financeurs reels jusqu'a 12 pages
 * (262 appels, zero 429), ce que la page 1 avait enregistre contre le compte reel:
 *
 *       4 -> 56 (termine)    11 -> 52 (termine)    12 -> 64 (termine)    15 -> 41 (termine)
 *       6 -> 18 (termine)     8 -> 15 (termine)    17 -> 18 (termine)
 *
 * ⚠️ QUATRE DE CES SEPT SONT ENREGISTRES SOUS LE SEUIL INDUSTRIEL DE 20 ET LE FRANCHISSENT UNE FOIS LUS.
 * La lecture d'une page ne rendait pas seulement le cote DANGER flou: elle FABRIQUAIT DES VERDICTS « SAFE ».
 * 144 tokens de la base portent un compte censure inferieur a 20 — autant d'appels rassurants emis sur un
 * plancher. C'est la faute la plus chere des deux: un faux DANGER coute une occasion, un faux SAFE coute
 * l'utilisateur.
 *
 * CONSEQUENCE STATISTIQUE, prouvee par hermes/economy/run-prequential.js: aucun seuil ne pouvait etre derive
 * de cette variable. Un p75 sur tous les comptes rendait la constante 50 (le plafond); un p75 sur les seuls
 * comptes complets rendait la constante 1 — parce que la censure CORRELE avec la valeur: un financeur dont
 * l'historique tient sur une page EST un petit financeur. Une regle « derivee » qui rend le plafond de
 * l'instrument est le drapeau de censure portant un autre nom.
 *
 * Ce que ce fichier epingle, et chaque cas existe parce que l'omettre laissait passer une faute reelle:
 *   · le compte s'ACCUMULE a travers les pages, sans double comptage;
 *   · un historique qui SE TERMINE dans la borne n'est PAS censure, meme si le compte est grand — c'est la
 *     regression exacte de l'heuristique `siblingCount >= 50` qu'on vient de retirer;
 *   · atteindre la borne rend un PLANCHER, et le dit;
 *   · une page qui tombe EN COURS n'est pas une page 1 qui tombe: partiel-reel contre rien-du-tout;
 *   · les trois raisons d'arret sont DISTINGUABLES (temoin d'instrument);
 *   · `filter=from` survit a la construction des URLs de page suivante — sans quoi la page 2 renverrait
 *     l'historique ENTRANT et le compte deviendrait faux sans rien casser de visible.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { traceFeeder, planTrace, SIBLING_MAX_PAGES, SIBLING_ALERT, TRACE_FIXED_CALLS } = require('../lib/feeder.js');

let pass = 0, fail = 0;
const cas = [];
const t = (nom, fn) => cas.push([nom, fn]);

const eth = (n) => String(BigInt(Math.round(n * 1e6)) * (10n ** 12n));
const sortie = (to, valeurEth) => ({ to: { hash: to }, value: eth(valeurEth) });
const entree = (from, valeurEth, ts) => ({ from: { hash: from }, value: eth(valeurEth), timestamp: ts });
const BASE_ENTRANT = { items: [entree('0xFINANCEUR', 1, '2026-01-01T10:00:00Z')] };

/**
 * Explorateur PAGINANT. `pages` est un tableau de tableaux d'items; `null` a la place d'une page simule une
 * page qui ne repond pas. On enregistre les URLs vues, parce que la construction de l'URL de page suivante
 * est elle-meme une propriete a epingler.
 */
function explorateurPagine(pages, opts = {}) {
  const vues = [];
  const fetch = async (url) => {
    if (/\/transactions\/0x/.test(url)) return { timestamp: '2026-01-01T12:00:00Z' };
    if (url.includes('filter=to')) return BASE_ENTRANT;
    if (url.includes('filter=from')) {
      vues.push(url);
      // le curseur voyage dans la query; page 1 n'en a pas
      const m = /[?&]p=(\d+)/.exec(url);
      const idx = m ? Number(m[1]) : 0;
      const items = pages[idx];
      if (items == null) return null;                        // cette page ne repond pas
      const dernier = idx >= pages.length - 1;
      return { items, next_page_params: dernier ? null : { p: idx + 1, filter: 'from', items_count: 50 } };
    }
    if (url.includes('/addresses/')) return opts.token === undefined
      ? { creator_address_hash: '0xDEPLOYEUR', creation_transaction_hash: '0xcreation' } : opts.token;
    return null;
  };
  return { fetch, vues };
}
const tracerPages = (pages, o = {}) => {
  const e = explorateurPagine(pages, o);
  return traceFeeder('base', '0xTOKEN', { fetchImpl: e.fetch, maxPages: o.maxPages }).then((r) => ({ ...r, _vues: e.vues }));
};

console.log('funder-pagination: le compte des freres etait une borne, pas une mesure');

/* ── le compte s'accumule ─────────────────────────────────────────────────────────────────────────── */

t('★ le compte ACCUMULE a travers les pages — une page ne le borne plus', async () => {
  /* La faute exacte: chaque page porte des destinataires DIFFERENTS, donc s'arreter a la premiere rendait
   * 2 la ou la verite est 6. Trois pages, deux nouveaux portefeuilles chacune. */
  const r = await tracerPages([
    [sortie('0xA', 1), sortie('0xB', 1)],
    [sortie('0xC', 1), sortie('0xD', 1)],
    [sortie('0xE', 1), sortie('0xF', 1)],
  ]);
  assert.strictEqual(r.siblingCount, 6, 'six destinataires distincts sur trois pages, vu ' + r.siblingCount);
  assert.strictEqual(r.siblingPagesRead, 3);
  assert.strictEqual(r.siblingTxScanned, 6);
});

t('★ un destinataire vu sur DEUX pages ne compte qu une fois', async () => {
  /* Sans cette propriete le compte gonflerait avec la profondeur, et « plus on lit, plus c est grave »
   * serait un artefact de l instrument — exactement le defaut qu on vient de retirer, dans l autre sens. */
  const r = await tracerPages([
    [sortie('0xA', 1), sortie('0xB', 1)],
    [sortie('0xA', 2), sortie('0xB', 2)],
  ]);
  assert.strictEqual(r.siblingCount, 2, 'deux portefeuilles payes deux fois restent deux portefeuilles');
  assert.strictEqual(r.siblingTxScanned, 4, 'mais les quatre transactions ont bien ete lues');
  // et les montants s AGREGENT par destinataire, sinon le total par portefeuille serait faux
  assert.deepStrictEqual(r.siblings.map((s) => s.eth).sort(), [3, 3]);
});

t('les auto-envois restent exclus SUR TOUTES LES PAGES, pas seulement la premiere', async () => {
  const r = await tracerPages([
    [sortie('0xAUTRE', 1)],
    [sortie('0xFINANCEUR', 5), sortie('0xFINANCEUR', 5)],
  ]);
  assert.deepStrictEqual(r.siblings.map((s) => s.addr), ['0xAUTRE'],
    'un filtre applique a la page 1 seulement laisserait le financeur se compter lui-meme');
});

t('les transferts a ZERO restent exclus sur toutes les pages', async () => {
  const r = await tracerPages([[sortie('0xA', 1)], [sortie('0xSPAM', 0), sortie('0xSPAM2', 0)]]);
  assert.strictEqual(r.siblingCount, 1, 'du spam a cout nul ne finance rien, a quelque page qu il soit');
});

/* ── termine contre plancher: la regression de `>= 50` ────────────────────────────────────────────── */

t('★ un historique qui SE TERMINE n est pas censure — meme si le compte depasse 50', async () => {
  /* ⛔ LA REGRESSION QUI COMPTE. token-radar portait `siblingCountCensored = … || f.siblingCount >= 50`:
   * la censure DEVINEE a partir de la valeur, avec la taille de page codee en dur a un fichier de
   * distance de la boucle qui la subissait. Un financeur reel du 2026-08-04 termine a 56 freres — exact,
   * complet, et l heuristique le tamponnait « censure ». On jetait ainsi la mesure COMPLETE la plus haute
   * de la plage, celle qui pese le plus dans un quantile — et c est le mecanisme meme qui figeait le p75
   * des comptes non censures a 1. */
  const pages = [];
  for (let p = 0; p < 3; p++) pages.push(Array.from({ length: 20 }, (_, i) => sortie('0xW' + (p * 20 + i), 1)));
  const r = await tracerPages(pages);
  assert.strictEqual(r.siblingCount, 60, 'soixante destinataires distincts');
  assert.ok(r.siblingCount > 50, 'temoin: le cas doit vraiment franchir l ancien seuil magique');
  assert.strictEqual(r.morePages, false, 'l historique s est termine: ce compte est EXACT');
  assert.strictEqual(r.siblingScanStoppedBy, 'end');
  assert.ok(!/floor/i.test(r.note), 'et la note ne doit pas le presenter comme un plancher');
});

t('★ atteindre la borne rend un PLANCHER, et le DIT', async () => {
  const pages = Array.from({ length: 10 }, (_, p) => [sortie('0xW' + p, 1)]);
  const r = await tracerPages(pages, { maxPages: 4 });
  assert.strictEqual(r.siblingPagesRead, 4, 'on s arrete a la borne demandee');
  assert.strictEqual(r.siblingPageCap, 4, 'et la borne appliquee est PUBLIEE avec le chiffre');
  assert.strictEqual(r.morePages, true);
  assert.strictEqual(r.siblingScanStoppedBy, 'page_cap');
  assert.match(r.note, /FLOOR, not a count/i, 'un plancher non annonce se lit comme une mesure');
  assert.match(r.note, /AT LEAST/i);
});

t('la borne par defaut est celle qui a ete mesuree, pas une improvisation', async () => {
  const pages = Array.from({ length: 50 }, (_, p) => [sortie('0xW' + p, 1)]);
  const r = await tracerPages(pages);
  assert.strictEqual(r.siblingPagesRead, SIBLING_MAX_PAGES);
  assert.strictEqual(r.siblingPageCap, SIBLING_MAX_PAGES);
});

t('une borne absurde retombe sur la constante au lieu de desactiver le balayage en silence', async () => {
  /* `maxPages: 0` desactiverait toute la lecture et rendrait `siblingsRead: false` — un module muet
   * deguise en explorateur muet. Le fail-closed doit rester reserve aux VRAIES non-reponses. */
  for (const mauvais of [0, -3, 2.5, null, 'six']) {
    const r = await tracerPages([[sortie('0xA', 1)]], { maxPages: mauvais });
    assert.strictEqual(r.siblingsRead, true, 'maxPages=' + JSON.stringify(mauvais) + ' a coupe la lecture');
    assert.strictEqual(r.siblingPageCap, SIBLING_MAX_PAGES);
  }
});

/* ── la panne en cours de balayage ────────────────────────────────────────────────────────────────── */

t('★ une page qui tombe EN COURS garde le compte partiel — et le marque comme plancher', async () => {
  /* Trois etats, encore, et le milieu est neuf: « lu jusqu a la page 3 puis panne » n est ni « lu en
   * entier » ni « pas lu ». Le replier sur le premier attesterait un compte complet a partir d une
   * lecture tronquee; le replier sur le second jetterait une mesure reelle. */
  const r = await tracerPages([[sortie('0xA', 1)], [sortie('0xB', 1)], null, [sortie('0xD', 1)]]);
  assert.strictEqual(r.siblingsRead, true, 'deux pages ont bel et bien ete lues');
  assert.strictEqual(r.siblingCount, 2, 'ce qui a ete lu est conserve');
  assert.strictEqual(r.siblingPagesRead, 2);
  assert.strictEqual(r.morePages, true, 'il reste de l historique non lu: plancher');
  assert.strictEqual(r.siblingScanStoppedBy, 'read_error');
  assert.match(r.note, /a page failed mid-scan/i, 'la raison du plancher est REESSAYABLE, et ca se dit');
});

t('★ LES DEUX BORNES: la page 1 qui tombe ne rend toujours RIEN, pas un compte partiel', async () => {
  const r = await tracerPages([null, [sortie('0xB', 1)]]);
  assert.strictEqual(r.siblingsRead, false, 'rien n a ete lu');
  assert.strictEqual(r.siblingCount, null, '0 se lirait « verifie, il n a paye personne »');
  assert.strictEqual(r.identicalAmountSiblings, null);
  assert.strictEqual(r.morePages, null, 'on ignore meme s il y avait autre chose');
  assert.strictEqual(r.siblingPagesRead, 0);
  assert.strictEqual(r.siblingScanStoppedBy, 'no_read');
  assert.match(r.pattern, /could NOT be read/i);
});

t('★ les TROIS raisons d arret sont distinguables (temoin d instrument)', async () => {
  /* Sans ce temoin, un instrument qui rendrait la meme chose partout se lirait « rien a signaler ». */
  const sig = (r) => JSON.stringify([r.siblingsRead, r.siblingCount, r.morePages, r.siblingScanStoppedBy]);
  const termine = await tracerPages([[sortie('0xA', 1)]]);
  const borne = await tracerPages([[sortie('0xA', 1)], [sortie('0xB', 1)]], { maxPages: 1 });
  const panne = await tracerPages([[sortie('0xA', 1)], null, [sortie('0xC', 1)]]);
  const jamais = await tracerPages([null]);
  const sigs = [sig(termine), sig(borne), sig(panne), sig(jamais)];
  assert.strictEqual(new Set(sigs).size, 4, 'quatre situations, quatre sorties: ' + JSON.stringify(sigs));
  assert.strictEqual(termine.siblingScanStoppedBy, 'end');
  assert.strictEqual(borne.siblingScanStoppedBy, 'page_cap');
});

/* ── l URL de page suivante ───────────────────────────────────────────────────────────────────────── */

t('★ `filter=from` survit a chaque page suivante — sinon on compterait l historique ENTRANT', async () => {
  /* La faute silencieuse la plus dangereuse de ce changement: sans le filtre, la page 2 de Blockscout
   * rend TOUTES les transactions de l adresse, entrantes comprises. Le compte resterait plausible, ne
   * casserait aucun test de forme, et melangerait « qui il a paye » avec « qui l a paye ». Verifie en
   * direct le 2026-08-04: la page 2 ainsi construite rend 50 elements, zero recouvrement avec la page 1,
   * et toutes emises PAR le financeur. */
  const r = await tracerPages([[sortie('0xA', 1)], [sortie('0xB', 1)], [sortie('0xC', 1)]]);
  assert.strictEqual(r._vues.length, 3, 'trois pages demandees');
  for (const url of r._vues) {
    assert.ok(url.includes('filter=from'), 'une page sans filtre: ' + url);
    assert.ok(!url.includes('filter=to'), 'le filtre ne doit jamais s inverser: ' + url);
  }
  // et le curseur de l explorateur est bien transmis, sinon on relirait la page 1 six fois
  assert.ok(r._vues[1].includes('p=1') && r._vues[2].includes('p=2'), 'curseur non transmis: ' + r._vues.join(' | '));
});

t('★ le curseur AVANCE — sans quoi on relirait la meme page et le compte serait fige', async () => {
  const r = await tracerPages([[sortie('0xA', 1)], [sortie('0xB', 1)], [sortie('0xC', 1)]]);
  assert.strictEqual(new Set(r._vues).size, r._vues.length, 'une URL repetee = une page relue');
  assert.strictEqual(r.siblingCount, 3);
});

/* ── le signal de fabrique, a travers les pages ───────────────────────────────────────────────────── */

t('★ une fabrique ETALEE sur plusieurs pages est vue — elle etait invisible a une page', async () => {
  /* Le cas qui motive tout: un montant identique repete, mais reparti sur trois pages. A une page, quatre
   * portefeuilles: sous SIBLING_ALERT, aucune alerte. Lu en entier, c est un script. */
  const parPage = Math.ceil((SIBLING_ALERT + 3) / 3);
  const pages = [0, 1, 2].map((p) => Array.from({ length: parPage },
    (_, i) => sortie('0xW' + (p * parPage + i), 0.05)));
  const uneSeule = await tracerPages(pages, { maxPages: 1 });
  const entier = await tracerPages(pages);
  assert.ok(uneSeule.identicalAmountSiblings < SIBLING_ALERT,
    'temoin: a une page le motif doit rester sous le seuil, vu ' + uneSeule.identicalAmountSiblings);
  assert.ok(!/scripted launch factory/i.test(uneSeule.pattern), 'motif a une page: ' + uneSeule.pattern);
  assert.ok(entier.identicalAmountSiblings >= SIBLING_ALERT, 'vu ' + entier.identicalAmountSiblings);
  assert.match(entier.pattern, /scripted launch factory/i);
});

t('la phrase publiee porte l etendue de la lecture, pas seulement le chiffre', async () => {
  /* L ancienne phrase disait « on this page » — au singulier, et c etait la SEULE trace de la borne dans
   * toute la sortie destinee a un humain. */
  const r = await tracerPages([[sortie('0xA', 1)], [sortie('0xB', 1)]]);
  assert.match(r.pattern, /2 pages, 2 transactions scanned/, 'motif vu: ' + r.pattern);
  assert.ok(!/on this page/.test(r.pattern), 'la phrase au singulier est fausse des qu on en lit six');
});

t('un plancher dit « at least » dans la phrase, un compte exact ne le dit pas', async () => {
  /* Les deux fixtures rendent NEUF freres — le meme chiffre des deux cotes, pour que seule la maniere de
   * l enoncer differe. Ne comparer que des phrases produites par des comptes differents laisserait passer
   * un « at least » colle a tout ce qui est grand. Neuf est au-dessus de SIBLING_ALERT, donc la branche
   * qui ENONCE un compte est bien celle qu on exerce: sous le seuil, aucun chiffre n est avance et il n y
   * aurait rien a qualifier. */
  const plancher = await tracerPages(
    Array.from({ length: 12 }, (_, p) => [sortie('0xW' + p, 1)]), { maxPages: 9 });
  const exact = await tracerPages([Array.from({ length: 9 }, (_, i) => sortie('0xW' + i, 1))]);
  assert.strictEqual(plancher.siblingCount, 9);
  assert.strictEqual(exact.siblingCount, 9, 'meme chiffre des deux cotes: seule l enonciation change');
  assert.match(plancher.pattern, /at least/i, 'motif vu: ' + plancher.pattern);
  assert.ok(!/at least/i.test(exact.pattern), 'ne pas affaiblir une mesure qui est complete: ' + exact.pattern);
});

/* ── le budget d appels ───────────────────────────────────────────────────────────────────────────── */

t('★ le cout REEL de la trace est rendu — un budget estime n est pas un budget', async () => {
  /* Le cout par token n est plus constant (3 a 9 appels selon la profondeur). L appelant porte une
   * enveloppe pour tout le run et ne peut plus la deduire d une multiplication. */
  const courte = await tracerPages([[sortie('0xA', 1)]]);
  const longue = await tracerPages(Array.from({ length: 6 }, (_, p) => [sortie('0xW' + p, 1)]));
  assert.strictEqual(courte.explorerCalls, 4, 'token + entrants + 1 page + horodatage de creation');
  assert.strictEqual(longue.explorerCalls, 9, 'token + entrants + 6 pages + creation');
  assert.ok(longue.explorerCalls > courte.explorerCalls, 'le compteur doit VARIER avec la profondeur');
});

t('un refus precoce compte aussi ce qu il a depense', async () => {
  /* Une trace qui tombe a coute des appels a l explorateur malgre tout. Ne compter que les succes ferait
   * deborder l enveloppe exactement le jour ou l explorateur va mal — le jour ou il faut le moins insister. */
  const muet = await traceFeeder('base', '0xTOKEN', { fetchImpl: async () => null });
  assert.strictEqual(muet.ok, false);
  assert.strictEqual(muet.explorerCalls, 1, 'un appel a bien ete emis');
  const pasDeChaine = await traceFeeder('dogecoin', '0xTOKEN', { fetchImpl: async () => null });
  assert.strictEqual(pasDeChaine.explorerCalls, 0, 'et zero quand rien n a ete tente');
});

t('la borne peut etre ABAISSEE par l appelant — c est le levier du budget', async () => {
  const pages = Array.from({ length: 6 }, (_, p) => [sortie('0xW' + p, 1)]);
  const r = await tracerPages(pages, { maxPages: 2 });
  assert.strictEqual(r.siblingPagesRead, 2);
  assert.strictEqual(r.explorerCalls, 5, 'token + entrants + 2 pages + creation');
  assert.strictEqual(r.morePages, true, 'et une lecture ecourtee reste honnetement un plancher');
});

/* ── la politique de budget, extraite pour etre exercee ───────────────────────────────────────────── */

t('★ planTrace rogne la PROFONDEUR avant de refuser le token', async () => {
  /* Le choix qui se defend a voix haute: un financeur lu sur deux pages est une mesure partielle honnete,
   * un token pas trace du tout est un trou. Donc au moins une page des qu on se lance. */
  assert.deepStrictEqual(planTrace(1000), { trace: true, pages: SIBLING_MAX_PAGES }, 'budget large: pleine profondeur');
  assert.deepStrictEqual(planTrace(TRACE_FIXED_CALLS + 2), { trace: true, pages: 2 }, 'budget moyen: profondeur reduite');
  assert.deepStrictEqual(planTrace(TRACE_FIXED_CALLS), { trace: true, pages: 1 }, 'budget juste: une page, jamais zero');
});

t('★ en dessous du cout fixe, on NE COMMENCE PAS — depenser sans atteindre le financeur ne sert rien', async () => {
  for (const restant of [TRACE_FIXED_CALLS - 1, 1, 0, -50]) {
    assert.deepStrictEqual(planTrace(restant), { trace: false, pages: 0 }, 'restant=' + restant);
  }
});

t('★ le depassement est BORNE — sinon l enveloppe deriverait a chaque token', async () => {
  /* `Math.max(1, …)` garantit une page meme quand il ne reste que le cout fixe, donc un token peut couter
   * jusqu a 1 appel de plus que le restant. La propriete a tenir est que ca ne COMPOSE pas: apres un
   * depassement, le restant devient negatif et le token suivant est refuse net. */
  let restant = TRACE_FIXED_CALLS;                       // le pire cas exactement
  const plan = planTrace(restant);
  assert.strictEqual(plan.trace, true);
  const coutMax = TRACE_FIXED_CALLS + plan.pages;        // 4 appels pour 3 restants
  assert.strictEqual(coutMax - restant, 1, 'le depassement d un token ne doit jamais exceder un appel');
  restant -= coutMax;
  assert.ok(restant < 0);
  assert.strictEqual(planTrace(restant).trace, false, 'et le token suivant est refuse: pas de derive');
});

t('une valeur non finie ne se lit pas comme un budget infini', async () => {
  for (const mauvais of [NaN, Infinity, undefined, null, 'beaucoup']) {
    assert.strictEqual(planTrace(mauvais).trace, false, 'budget=' + String(mauvais) + ' devrait refuser');
  }
});

/* ── la propriete cote token-radar ────────────────────────────────────────────────────────────────── */

const RADAR = fs.readFileSync(path.join(__dirname, '..', 'hermes', 'economy', 'token-radar.js'), 'utf8');

t('★ token-radar ne DEVINE plus la censure a partir de la valeur', async () => {
  /* `siblingCount >= 50` encodait la taille d une page de l explorateur, dans un autre fichier que la
   * boucle qui la subissait. `traceFeeder` sait s il a atteint la fin; on lui demande. */
  const ligne = RADAR.split(/\r?\n/).find((l) => l.includes('siblingCountCensored ='));
  assert.ok(ligne, 'la ligne d affectation est introuvable — ce test doit etre mis a jour');
  assert.ok(!/siblingCount\s*>=\s*50/.test(ligne), 'heuristique de plafond encore presente: ' + ligne.trim());
  assert.ok(/morePages/.test(ligne), 'la censure doit venir du drapeau rendu par la lecture: ' + ligne.trim());
});

t('le budget d appels du run est un CHIFFRE ecrit, pas une multiplication mentale', async () => {
  assert.match(RADAR, /const TRACE_CALL_BUDGET\s*=\s*\d+/, 'aucune enveloppe explicite');
  assert.ok(/callsSpent/.test(RADAR), 'le budget doit etre reellement DEPENSE, pas seulement declare');
  assert.ok(/explorerCalls/.test(RADAR), 'et depense sur le cout REEL rendu par le tracer');
});

t('★ un run qui epuise son budget le DIT — sinon il se lit comme un run calme', async () => {
  /* La faute que ce depot a deja commise trois fois: notre borne publiee comme un constat sur la chaine. */
  assert.match(RADAR, /budget exhausted, not cleared/,
    'des tokens non traces faute de budget doivent etre annonces comme tels');
  assert.match(RADAR, /explorer budget: /, 'la depense du run doit etre publiee');
});

(async () => {
  for (const [nom, fn] of cas) {
    try { await fn(); pass++; console.log('  ok   ' + nom); }
    catch (e) { fail++; console.log('  FAIL ' + nom + '\n       ' + e.message); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== cas.length) {
    console.log('✗ ' + cas.length + ' cas empiles mais ' + (pass + fail) + ' deroules');
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})();
