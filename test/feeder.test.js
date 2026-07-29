#!/usr/bin/env node
'use strict';
/**
 * feeder — « qui a paye pour ce lancement, et quoi d'autre a-t-il paye ? »
 *
 * C'est le module du depot dont la sortie NOMME DES GENS. Partout ailleurs une faute donne un mauvais
 * verdict sur un contrat; ici elle imprime une adresse a cote du mot « financeur ». Le fichier le sait —
 * sa note finale dit « STRUCTURE ONLY … never fraud » — mais il n'avait aucun test.
 *
 * TROIS FAUTES MESUREES ET CORRIGEES LE 2026-07-27:
 *
 *   (A) `deployedAt` PORTAIT LA DATE DE FINANCEMENT.
 *         const deployedAt = tok.creation_transaction_hash ? (first.timestamp || null) : null;
 *       `first` est le transfert ENTRANT. Les deux champs sortaient donc identiques sur toute entree, et
 *       un appelant calculant l'ecart obtenait ZERO a chaque fois — « finance et deploye dans la meme
 *       seconde », la lecture la plus incriminante possible, servie sur tous les tokens indistinctement.
 *
 *   (B) `FRESH_FUNDING_WINDOW_MS` (« finance <6h avant le deploiement = portefeuille fait pour la
 *       tache ») etait definie et exportee, et utilisee NULLE PART dans le depot. L'heuristique que son
 *       commentaire decrit n'avait jamais ete ecrite — elle ne pouvait pas l'etre sans vraie date de
 *       deploiement. Elle est calculee maintenant, en TROIS etats: true / false / null.
 *
 *   (C) LE FINANCEUR NOMME N'ETAIT PAS FORCEMENT LE PREMIER. L'explorateur rend du plus recent au plus
 *       ancien, donc `funders[funders.length-1]` est le plus ancien DE LA PAGE. Sur un deployeur a
 *       plusieurs pages d'entrees, l'adresse nommee « funder » n'a pas paye ce lancement — et rien ne le
 *       disait, alors que le meme fichier divulgue soigneusement `morePages` du cote des siblings.
 */
const assert = require('node:assert');
const { traceFeeder, SIBLING_ALERT, FRESH_FUNDING_WINDOW_MS } = require('../lib/feeder.js');

let pass = 0, fail = 0;
const files = [];
const t = (nom, fn) => files.push([nom, fn]);

const eth = (n) => String(BigInt(Math.round(n * 1e6)) * (10n ** 12n));
const entree = (from, valeurEth, ts) => ({ from: { hash: from }, value: eth(valeurEth), timestamp: ts });
const sortie = (to, valeurEth) => ({ to: { hash: to }, value: eth(valeurEth) });

/** Faux explorateur. L'ORDRE des tests d'URL compte: /transactions/0x… avant /addresses/. */
const explorateur = (m) => async (url) => {
  if (/\/transactions\/0x/.test(url)) return m.creation === undefined ? { timestamp: '2026-01-01T12:00:00Z' } : m.creation;
  if (url.includes('/transactions?filter=to')) return m.entrant;
  if (url.includes('/transactions?filter=from')) return m.sortant || { items: [] };
  if (url.includes('/addresses/')) return m.token === undefined
    ? { creator_address_hash: '0xDEPLOYEUR', creation_transaction_hash: '0xcreation' } : m.token;
  return null;
};
const BASE_ENTRANT = { items: [entree('0xFINANCEUR', 1, '2026-01-01T10:00:00Z')] };
const tracer = (m) => traceFeeder('base', '0xTOKEN', { fetchImpl: explorateur({ entrant: BASE_ENTRANT, ...m }) });

console.log('feeder: ce module imprime une adresse a cote du mot « financeur »');

/* ── (A) et (B) l'ecart financement -> deploiement ───────────────────────────────────────────────── */

t('★ deployedAt est la date de DEPLOIEMENT, pas une copie de fundedAt', async () => {
  const r = await tracer({ creation: { timestamp: '2026-01-01T12:30:00Z' } });
  assert.strictEqual(r.fundedAt, '2026-01-01T10:00:00Z');
  assert.strictEqual(r.deployedAt, '2026-01-01T12:30:00Z');
  assert.notStrictEqual(r.deployedAt, r.fundedAt,
    'les deux champs identiques = l ancien bug, et il donnait un ecart de zero sur TOUT');
});

t('★ l ecart VARIE — un ecart constant n est pas une mesure', async () => {
  /* Deux cas OPPOSES: une assertion sur un seul passerait aussi contre une constante. */
  const proche = await tracer({ creation: { timestamp: '2026-01-01T12:30:00Z' } });   // +2h30
  const loin = await tracer({ creation: { timestamp: '2026-01-05T10:00:00Z' } });     // +4 jours
  assert.strictEqual(proche.fundingToDeployMs, 2.5 * 3600 * 1000);
  assert.strictEqual(loin.fundingToDeployMs, 96 * 3600 * 1000);
  assert.notStrictEqual(proche.freshlyFunded, loin.freshlyFunded, 'le signal doit distinguer les deux');
});

t('la fenetre de 6h est REELLEMENT appliquee — la constante etait morte', async () => {
  const dedans = await tracer({ creation: { timestamp: '2026-01-01T15:59:00Z' } });   // +5h59
  const dehors = await tracer({ creation: { timestamp: '2026-01-01T16:01:00Z' } });   // +6h01
  assert.strictEqual(dedans.freshlyFunded, true);
  assert.strictEqual(dehors.freshlyFunded, false);
  assert.strictEqual(dedans.freshFundingWindowMs, FRESH_FUNDING_WINDOW_MS,
    'la fenetre appliquee doit etre publiee, pour que le lecteur sache a quoi il compare');
});

t('la borne exacte des 6h est INCLUSIVE, et on epingle le code plutot que l intention', async () => {
  const pile = await tracer({ creation: { timestamp: '2026-01-01T16:00:00Z' } });     // +6h00 exactement
  assert.strictEqual(pile.fundingToDeployMs, FRESH_FUNDING_WINDOW_MS);
  assert.strictEqual(pile.freshlyFunded, true, 'la comparaison est <=');
});

t('★ TROIS etats: un horodatage manquant donne null, jamais false', async () => {
  /* `false` se lirait « verifie, et le portefeuille n a PAS ete finance juste avant » — une affirmation.
   * Or on n a rien pu comparer. C est la meme distinction que partout ailleurs dans ce depot. */
  const r = await tracer({ creation: null });
  assert.strictEqual(r.deployedAt, null);
  assert.strictEqual(r.fundingToDeployMs, null);
  assert.strictEqual(r.freshlyFunded, null, 'inconnu, pas « non »');
  assert.match(r.note, /unknown, not false/i, 'et la note doit le dire au lecteur');
});

t('un horodatage illisible ne devient pas un ecart de zero', async () => {
  const r = await tracer({ creation: { timestamp: 'pas-une-date' } });
  assert.strictEqual(r.fundingToDeployMs, null, 'NaN ne doit pas se propager en nombre');
  assert.strictEqual(r.freshlyFunded, null);
});

t('un deploiement ANTERIEUR au financement n est pas « fraichement finance »', async () => {
  /* Arrive avec des donnees d explorateur incoherentes, ou si le portefeuille avait deja des fonds.
   * Un ecart negatif est plus petit que la fenetre: sans le test de signe il passerait pour frais. */
  const r = await tracer({ creation: { timestamp: '2025-12-31T10:00:00Z' } });
  assert.ok(r.fundingToDeployMs < 0, 'ecart negatif, vu ' + r.fundingToDeployMs);
  assert.strictEqual(r.freshlyFunded, false);
});

/* ── (C) le financeur nomme ──────────────────────────────────────────────────────────────────────── */

t('le financeur retenu est le PLUS ANCIEN de la liste (l explorateur rend du plus recent en tete)', async () => {
  const r = await tracer({ entrant: { items: [
    entree('0xRECENT', 5, '2026-01-03T10:00:00Z'),
    entree('0xMILIEU', 3, '2026-01-02T10:00:00Z'),
    entree('0xPREMIER', 1, '2026-01-01T10:00:00Z'),
  ] } });
  assert.strictEqual(r.funder, '0xPREMIER', 'celui qui a paye en premier, pas le plus recent');
  assert.strictEqual(r.fundedEth, 1);
});

t('★ plusieurs pages: le financeur n est PAS annonce comme prouvablement le premier', async () => {
  const r = await tracer({ entrant: { items: BASE_ENTRANT.items, next_page_params: { block_number: 42 } } });
  assert.strictEqual(r.funderIsProvablyFirst, false);
  assert.match(r.note, /not provably the first/i);
  assert.match(r.note, /Do not present it as the original funder/i,
    'la note doit dire quoi NE PAS en faire, pas seulement signaler une limite');
});

t('une seule page: le financeur EST prouvablement le premier', async () => {
  const r = await tracer({});
  assert.strictEqual(r.funderIsProvablyFirst, true);
  assert.ok(!/not provably the first/i.test(r.note), 'pas d avertissement quand il n y a rien a avertir');
});

t('★ un transfert de 0 ETH ANTERIEUR ne vole pas la place du vrai financeur', async () => {
  /* Un transfert de 0 ETH est gratuit a emettre. N importe qui peut en envoyer un a un deployeur AVANT
   * son vrai financement et se faire nommer « le premier a l avoir paye » — le code prend le plus ancien.
   * Le filtre sur la valeur est la seule chose qui l en empeche.
   *
   * ⚠️ MA PREMIERE VERSION DE CE TEST NE VERIFIAIT RIEN: elle mettait le spam en tete de liste, c'est-a-dire
   * en position « plus recent », alors que le code lit le DERNIER element. Retirer le filtre ne changeait
   * donc pas la reponse et la mutation restait verte. L ordre de la fixture EST la propriete ici — le spam
   * doit etre le plus ancien, sinon on teste le contraire de ce qu on annonce. */
  const r = await tracer({ entrant: { items: [
    entree('0xVRAI', 1, '2026-01-01T10:00:00Z'),   // plus recent (l explorateur rend du recent en tete)
    entree('0xSPAM', 0, '2026-01-01T09:00:00Z'),   // plus ANCIEN — la position que le code retient
  ] } });
  assert.strictEqual(r.funder, '0xVRAI', 'un envoi a zero ne finance rien et ne doit designer personne');
  assert.strictEqual(r.fundedEth, 1);
});

t('aucun financement trouve: on le DIT, on ne nomme personne', async () => {
  const r = await tracer({ entrant: { items: [] } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.funder, null, 'jamais une adresse par defaut');
  assert.match(r.note, /no incoming value transfer/i);
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * LA MEME FAUTE QUE POUR LA FRATRIE, UN CRAN PLUS HAUT — sur la lecture qui IDENTIFIE le financeur.
 *
 * `(inc && inc.items) || []` repliait l'explorateur MUET et un deployeur REELLEMENT sans transfert
 * entrant sur le meme tableau vide. Mesure du 2026-07-29, en appelant traceFeeder avec un explorateur
 * injecte: les deux reponses etaient egales a `JSON.stringify` pres —
 *
 *   ok:true · funder:null · siblingCount:0 · « no incoming value transfer found for the deployer »
 *
 * Une panne reseau rendue comme un CONSTAT sur la chaine, et `till_launch_funder` (outil MCP) la servait
 * brute a des agents. Ce fichier avait corrige exactement cela pour `siblingsRead` la veille.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */
const explorateurMuetSurEntrants = async (url) => {
  if (/\/transactions\/0x/.test(url)) return { timestamp: '2026-01-01T12:00:00Z' };
  if (url.includes('/transactions?filter=to')) return null;          // l'explorateur ne repond pas
  if (url.includes('/addresses/')) return { creator_address_hash: '0xDEPLOYEUR', creation_transaction_hash: '0xcreation' };
  return null;
};

t('★ un explorateur MUET sur les entrants REFUSE — il n atteste pas une absence de financement', async () => {
  const r = await traceFeeder('base', '0xTOKEN', { fetchImpl: explorateurMuetSurEntrants });
  assert.strictEqual(r.ok, false, 'une non-reponse ne peut pas produire un resultat');
  assert.strictEqual(r.fundingRead, false);
  assert.match(r.reason, /UNREAD, not absent/i, 'la raison doit nommer la difference');
  assert.ok(!/no incoming value transfer found/i.test(r.note || ''),
    'surtout pas la phrase du cas reellement vide');
});

t('★ LES DEUX BORNES: un deployeur REELLEMENT sans entrant dit toujours exactement ce qu il disait', async () => {
  const r = await tracer({ entrant: { items: [] } });
  assert.strictEqual(r.ok, true, 'lu-et-vide reste un resultat, pas un refus');
  assert.strictEqual(r.funder, null);
  assert.match(r.note, /no incoming value transfer/i);
  assert.strictEqual(r.fundingRead, true, 'et il DIT que la lecture a bien eu lieu');
});

t('★ un `items` absent compte comme une non-reponse (derive de schema, fail-closed)', async () => {
  const r = await traceFeeder('base', '0xTOKEN', { fetchImpl: async (url) => {
    if (/\/transactions\/0x/.test(url)) return { timestamp: '2026-01-01T12:00:00Z' };
    if (url.includes('/transactions?filter=to')) return { resultat: [] };     // forme inattendue
    if (url.includes('/addresses/')) return { creator_address_hash: '0xDEPLOYEUR', creation_transaction_hash: '0xcreation' };
    return null;
  } });
  assert.strictEqual(r.ok, false, 'ici le silence se lirait autrement comme une innocence');
});

t('★ AUCUN financeur identifie rend siblingCount null — 0 se lirait « il n a paye personne »', async () => {
  const aucun = await tracer({ entrant: { items: [] } });
  assert.strictEqual(aucun.siblingCount, null, 'rien n a ete compte: aucun financeur a compter');
  assert.strictEqual(aucun.siblingsRead, null, 'et la question n a meme pas pu etre posee');

  // BORNE D ACCEPTATION — un financeur IDENTIFIE qui n a paye personne garde son 0, qui est une mesure.
  const solitaire = await tracer({ entrant: { items: [entree('0xFINANCEUR', 1, '2026-01-01T10:00:00Z')] },
    sortant: { items: [] } });
  assert.strictEqual(solitaire.funder, '0xFINANCEUR');
  assert.strictEqual(solitaire.siblingCount, 0, 'lu-et-vide reste 0: c est un resultat');
  assert.strictEqual(solitaire.siblingsRead, true);

  // et les deux ne se confondent plus — c est toute la propriete.
  assert.notStrictEqual(aucun.siblingCount, solitaire.siblingCount);
});

/* Le refus est conserve; ce qui change est qu'il DIT laquelle des deux situations il refuse.
 * Motif: des l'installation de `funderTrace`, la premiere passe reelle du radar (2026-07-29 15:59) a
 * rendu 8 echecs sur 24, TOUS sous la meme phrase « could not resolve the deploying wallet » — un tiers
 * des traces, et rien pour savoir s'il fallait lever le pied sur l'explorateur ou changer la question. */
t('un deployeur introuvable refuse au lieu de deviner — explorateur qui REPOND, sans createur', async () => {
  const r = await tracer({ token: { creator_address_hash: null } });
  assert.strictEqual(r.ok, false, 'la propriete d origine tient: on refuse, on ne devine pas');
  assert.strictEqual(r.tokenRead, true, 'la lecture a bien eu lieu — rien a reessayer');
  assert.match(r.reason, /records no creator/i);
  assert.ok(!/did not answer/i.test(r.reason), 'ne pas accuser l explorateur qui a repondu');
});

t('★ explorateur MUET sur le token: refus DISTINCT — il y a quelque chose a reessayer', async () => {
  const r = await traceFeeder('base', '0xTOKEN', { fetchImpl: async () => null });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.tokenRead, false, 'rien n a ete lu');
  assert.match(r.reason, /UNREAD, not unknown/i);

  // et les deux refus ne se confondent plus — c est toute la propriete.
  const repond = await tracer({ token: { creator_address_hash: null } });
  assert.notStrictEqual(r.reason, repond.reason);
  assert.notStrictEqual(r.tokenRead, repond.tokenRead);
});

t('une chaine non cablee refuse au lieu de taper un explorateur au hasard', async () => {
  const r = await traceFeeder('dogecoin', '0xTOKEN', { fetchImpl: explorateur({}) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no public explorer/i);
});

/* ── les fratries ────────────────────────────────────────────────────────────────────────────────── */

t('les auto-envois du financeur ne comptent pas comme des fratries', async () => {
  const r = await tracer({ sortant: { items: [
    sortie('0xFINANCEUR', 2), sortie('0xAUTRE', 1),
  ] } });
  assert.deepStrictEqual(r.siblings.map((s) => s.addr), ['0xAUTRE'],
    'un portefeuille qui se renvoie des fonds ne finance pas un lancement');
});

t('des montants IDENTIQUES sur assez de portefeuilles se lisent comme un script', async () => {
  const r = await tracer({ sortant: { items: Array.from({ length: SIBLING_ALERT },
    (_, i) => sortie('0xW' + i, 0.05)) } });
  assert.strictEqual(r.identicalAmountSiblings, SIBLING_ALERT);
  assert.match(r.pattern, /scripted launch factory/i);
});

t('sous le seuil, aucune accusation de fabrique', async () => {
  const r = await tracer({ sortant: { items: Array.from({ length: SIBLING_ALERT - 1 },
    (_, i) => sortie('0xW' + i, 0.05)) } });
  assert.ok(!/factory/i.test(r.pattern), 'motif vu: ' + r.pattern);
});

t('des montants tous DIFFERENTS ne se lisent pas comme un script', async () => {
  const r = await tracer({ sortant: { items: Array.from({ length: 8 },
    (_, i) => sortie('0xW' + i, 0.01 * (i + 1))) } });
  assert.ok(r.identicalAmountSiblings < SIBLING_ALERT, 'vu ' + r.identicalAmountSiblings);
  assert.ok(!/scripted/i.test(r.pattern));
});

t('la pagination des fratries est divulguee', async () => {
  const r = await tracer({ sortant: { items: [sortie('0xA', 1)], next_page_params: { block_number: 7 } } });
  assert.strictEqual(r.morePages, true, 'un comptage partiel presente comme total serait faux');
});

/* ── (F) UN BALAYAGE DE FRATRIE QUI ECHOUE N'EST PAS UN FINANCEUR PROPRE ──────────────────────────
 * `getJSON` resout `null` sur erreur reseau ET sur corps non-parsable — il ne rejette jamais. Le
 * troisieme appel (l'historique sortant du financeur) retombait donc sur `[]`, et le module rendait
 * `ok: true`, financeur nomme, `siblingCount: 0`, `morePages: false`, et la phrase « single funder, no
 * repeated pattern on this page ». Mesure du 2026-07-28, trois cas OPPOSES:
 *
 *   usine (26 wallets)     -> siblingCount 26
 *   vide  (vraiment aucun) -> siblingCount 0    IDENTIQUES octet pour octet, `pattern` compris
 *   panne (429/502)        -> siblingCount 0
 *
 * Le compteur seul serait deja mauvais; la phrase publiee ATTESTAIT l'absence du signal a partir d'une
 * lecture qui n'a pas eu lieu. Et « le financeur a paye 20+ portefeuilles » est l'une des deux conditions
 * qui, dans nos donnees, precedent 85 % des rugs — une nuit de rate-limit annotait chaque lancement comme
 * finance par un dormeur solitaire, et l'annotation est ecrite en base: la lecture manquee survit a la
 * panne.
 *
 * Le bouchon `explorateur` ne peut PAS produire ce cas (`m.sortant || { items: [] }` rattrape le null),
 * ce qui est precisement pourquoi il n'etait pas couvert. On tape donc `traceFeeder` avec un fetch dedie. */
const explorateurMuetSurFratrie = async (url) => {
  if (/\/transactions\/0x/.test(url)) return { timestamp: '2026-01-01T12:00:00Z' };
  if (url.includes('/transactions?filter=to')) return BASE_ENTRANT;
  if (url.includes('/transactions?filter=from')) return null;          // 429 / 502 / corps non-parsable
  if (url.includes('/addresses/')) return { creator_address_hash: '0xDEPLOYEUR', creation_transaction_hash: '0xcreation' };
  return null;
};

t('★ une fratrie NON LUE rend null, jamais zero', async () => {
  const r = await traceFeeder('base', '0xTOKEN', { fetchImpl: explorateurMuetSurFratrie });
  assert.strictEqual(r.siblingsRead, false, 'le fait que la lecture ait echoue doit VOYAGER');
  assert.strictEqual(r.siblingCount, null, '0 se lirait « verifie, ce financeur n a paye personne »');
  /* `identicalAmountSiblings` gouverne l AUTRE moitie du drapeau industriel et tombait a 0 par le meme
   * chemin — corriger un seul des deux compteurs aurait laisse la porte ouverte. */
  assert.strictEqual(r.identicalAmountSiblings, null);
  assert.strictEqual(r.morePages, null, 'on ne sait pas s il y avait d autres pages: on ne l a pas lu');
});

t('★ la PHRASE publiee n atteste pas une absence qu on n a pas mesuree', async () => {
  const r = await traceFeeder('base', '0xTOKEN', { fetchImpl: explorateurMuetSurFratrie });
  assert.match(r.pattern, /could NOT be read/i);
  assert.match(r.pattern, /NOT "no siblings found"/i, 'la phrase doit REFUSER la lecture innocente');
  assert.doesNotMatch(r.pattern, /no repeated pattern/i);
});

t('LES DEUX BORNES: un financeur VRAIMENT vide dit toujours exactement ce qu il disait', async () => {
  /* Sans ce cas, on aurait pu rendre `null` partout et perdre la distinction dans l autre sens: un
   * financeur reellement sans fratrie est une VRAIE mesure, et elle doit rester lisible comme telle. */
  const vide = await tracer({ sortant: { items: [] } });
  assert.strictEqual(vide.siblingsRead, true);
  assert.strictEqual(vide.siblingCount, 0, 'lu-et-vide reste 0, pas null');
  assert.strictEqual(vide.identicalAmountSiblings, 0);
  assert.strictEqual(vide.morePages, false);
  assert.match(vide.pattern, /no repeated pattern/i);
});

t('★ les trois etats sont DISTINGUABLES (temoin d instrument)', async () => {
  /* Le controle qui manquait la premiere fois: sans un cas a signal FORT, une sonde qui rend la meme
   * chose partout se lit comme « rien a signaler » au lieu de « l instrument est mort ». */
  const sig = (r) => JSON.stringify([r.siblingsRead, r.siblingCount, r.identicalAmountSiblings, r.pattern]);
  const usine = await tracer({ sortant: { items: Array.from({ length: 26 }, (_, i) => sortie('0xW' + i, 15.02)) } });
  const vide = await tracer({ sortant: { items: [] } });
  const panne = await traceFeeder('base', '0xTOKEN', { fetchImpl: explorateurMuetSurFratrie });
  assert.strictEqual(new Set([sig(usine), sig(vide), sig(panne)]).size, 3);
  assert.strictEqual(usine.siblingCount, 26, 'temoin: le cas a signal fort doit vraiment porter le signal');
});

t('la note ne dit JAMAIS fraude — structure seulement', async () => {
  /* La regle qui gouverne tout ce module: on-chain prouve qui a paye qui, jamais pourquoi. Un launchpad
   * et une fabrique a rugs sont indiscernables depuis ce graphe. */
  const r = await tracer({ sortant: { items: Array.from({ length: 20 }, (_, i) => sortie('0xW' + i, 0.05)) } });
  assert.match(r.note, /never fraud/i);
  assert.match(r.note, /judge them together/i);
});

(async () => {
  for (const [nom, fn] of files) {
    try { await fn(); pass++; console.log('  ok   ' + nom); }
    catch (e) { fail++; console.log('  FAIL ' + nom + '\n       ' + e.message); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== files.length) {
    console.log('✗ ' + files.length + ' cas empiles mais ' + (pass + fail) + ' deroules');
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})();
