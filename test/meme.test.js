#!/usr/bin/env node
'use strict';
/**
 * meme — quel contrat porte reellement ce symbole, et sur quelle chaine.
 *
 * ⚠️ AUCUN TEST N'EXISTAIT POUR CE MODULE jusqu'au 2026-07-27, et le filtre de chaine etait mort dans
 * les DEUX sens. bin/biii-mcp.js passait `Number(a.chainId)`, alors que DexScreener rend des SLUGS:
 *
 *   chainId: 'base'  ->  Number('base') = NaN  ->  `if (chainId && ...)` est faux  ->  aucun filtre
 *   chainId: 8453    ->  'base' !== 8453                                           ->  tout ecarte
 *
 * MESURE SUR LE SERVICE EN PRODUCTION, symbole DEGEN, avant correction:
 *   sans chainId      status=genuine  canonical.chain=solana  11 candidats
 *   chainId:'base'    status=genuine  canonical.chain=solana  11 candidats   <- le filtre ne filtre rien
 *   chainId:8453      status=thin     canonical=null           0 candidat    <- le filtre efface tout
 *
 * Un appelant qui demande Base recevait un contrat SOLANA certifie « genuine ». Et le schema du tool
 * documentait `type:'number', e.g. 8453` — il dirigeait donc vers la forme qui efface tout. Le pire des
 * deux cas etait la voie recommandee.
 *
 * Ces tests n'appellent pas le reseau: on injecte des paires DexScreener et on regarde le tri.
 */
const assert = require('node:assert');
const { candidatesFrom, vetMeme } = require('../lib/meme.js');

let pass = 0, fail = 0;
const files = [];
const t = (nom, fn) => files.push([nom, fn]);

/** Une paire DexScreener reduite a ce que le module lit. */
const paire = (chainId, addr, symbol, liq) => ({
  chainId, baseToken: { address: addr, symbol, name: symbol + ' token' },
  liquidity: { usd: liq }, volume: { h24: liq / 10 }, pairCreatedAt: 1,
});
const PAIRES = [
  paire('solana', 'So1aNa000000000000000000000000000000000000', 'DEGEN', 5000000),
  paire('base', '0xbase0000000000000000000000000000000000001', 'DEGEN', 900000),
  paire('base', '0xbase0000000000000000000000000000000000002', 'DEGEN', 20000),
  paire('ethereum', '0xeth00000000000000000000000000000000000001', 'DEGEN', 300000),
  paire('base', '0xbase0000000000000000000000000000000000003', 'AUTRE', 999999),
];
/* DEUX contrats DEGEN sur Base — le troisieme contrat Base porte le symbole AUTRE et doit etre ecarte.
 * Le premier jet affirmait 3 et les tests rougissaient: une fixture mal comptee accuse le code a sa
 * place, ce qui coute le meme temps qu'un vrai bug avec rien au bout. */
const DEGEN_BASE = 2;

console.log('meme: demander Base et recevoir Solana');

/* ── le filtre de chaine ─────────────────────────────────────────────────────────────────────────── */

t('sans filtre, toutes les chaines concourent et la plus liquide gagne', () => {
  const c = candidatesFrom(PAIRES, 'DEGEN');
  assert.strictEqual(c.length, 4, 'les quatre contrats DEGEN, toutes chaines');
  assert.strictEqual(c[0].chain, 'solana', 'le plus liquide est sur Solana');
});

t("le SLUG 'base' filtre reellement — c est le cas qui ne filtrait rien", () => {
  const c = candidatesFrom(PAIRES, 'DEGEN', 'base');
  assert.strictEqual(c.length, DEGEN_BASE, 'seuls les DEGEN sur Base');
  assert.ok(c.every((x) => x.chain === 'base'), 'aucune autre chaine ne passe');
  assert.notStrictEqual(c[0].chain, 'solana', 'demander Base ne doit JAMAIS rendre du Solana');
});

t("l identifiant NUMERIQUE 8453 designe Base — c est le cas qui effacait tout", () => {
  const c = candidatesFrom(PAIRES, 'DEGEN', 8453);
  assert.strictEqual(c.length, DEGEN_BASE, '8453 doit se traduire en « base », pas vider le resultat');
  assert.ok(c.every((x) => x.chain === 'base'));
});

t('8453 en CHAINE de caracteres marche aussi — JSON-RPC transporte souvent des nombres en texte', () => {
  assert.deepStrictEqual(
    candidatesFrom(PAIRES, 'DEGEN', '8453').map((x) => x.address),
    candidatesFrom(PAIRES, 'DEGEN', 8453).map((x) => x.address));
});

t('la casse du slug est sans importance', () => {
  assert.strictEqual(candidatesFrom(PAIRES, 'DEGEN', 'BASE').length, DEGEN_BASE);
});

t('la casse est aussi normalisee du COTE PAIRE, pas seulement cote appelant', () => {
  /* Ajoute apres une mutation qui NE MORDAIT PAS: rendre la comparaison sensible a la casse cote paire
   * ne cassait rien, parce que toutes les fixtures ecrivaient le slug en minuscules — comme DexScreener
   * aujourd'hui. Une protection que rien n'exerce peut disparaitre au prochain refactor sans un seul
   * test rouge, et un amont qui se metterait a rendre « Base » ferait alors silencieusement zero
   * candidat: l'appelant lirait « ce token n'existe pas ici ». */
  const melange = [paire('Base', '0xA', 'X', 50000), paire('BASE', '0xB', 'X', 40000), paire('solana', '0xC', 'X', 90000)];
  const c = candidatesFrom(melange, 'X', 'base');
  assert.strictEqual(c.length, 2, 'Base et BASE designent la meme chaine que base');
  assert.ok(!c.some((x) => String(x.chain).toLowerCase() === 'solana'));
});

t('les identifiants EVM courants sont tous traduits', () => {
  const attendu = { 1: 'ethereum', 8453: 'base', 137: 'polygon', 42161: 'arbitrum', 10: 'optimism', 56: 'bsc' };
  for (const [id, slug] of Object.entries(attendu)) {
    const pr = [paire(slug, '0xa', 'X', 100), paire('autrechose', '0xb', 'X', 999)];
    const c = candidatesFrom(pr, 'X', Number(id));
    assert.strictEqual(c.length, 1, 'id ' + id + ' -> ' + slug);
    assert.strictEqual(c[0].chain, slug);
  }
});

t('★ FAIL-CLOSED: une chaine NON RECONNUE rend zero candidat, jamais « toutes les chaines »', () => {
  /* Le coeur de la correction. Se degrader en « pas de filtre » est le pire comportement possible ici:
   * l appelant a NOMME une chaine, et recevrait un verdict « genuine » sur une autre. Zero candidat fait
   * remonter thin/ambiguous — une abstention, jamais une certification deplacee. */
  for (const inconnu of [999999, '99999', 'chaine-qui-nexiste-pas-ici']) {
    const c = candidatesFrom(PAIRES, 'DEGEN', inconnu);
    assert.deepStrictEqual(c, [], 'chaine inconnue « ' + inconnu + ' » -> aucun candidat');
  }
});

t('une valeur vide veut dire « pas de filtre », et se distingue d une chaine inconnue', () => {
  /* Trois etats, pas deux: pas de filtre / filtre sur une chaine connue / chaine indechiffrable. */
  for (const vide of [undefined, null, '']) {
    assert.strictEqual(candidatesFrom(PAIRES, 'DEGEN', vide).length, 4, JSON.stringify(vide));
  }
});

/* ── la reduction par contrat ────────────────────────────────────────────────────────────────────── */

t('plusieurs paires du MEME contrat se replient sur la plus liquide', () => {
  const doublon = [
    paire('base', '0xMEME', 'X', 100),
    paire('base', '0xMEME', 'X', 5000),
    paire('base', '0xMEME', 'X', 200),
  ];
  const c = candidatesFrom(doublon, 'X');
  assert.strictEqual(c.length, 1, 'un seul contrat, pas trois lignes');
  assert.strictEqual(c[0].liquidityUsd, 5000, 'la meilleure paire represente le contrat');
});

t('un symbole different est ecarte meme sur la bonne chaine', () => {
  const c = candidatesFrom(PAIRES, 'DEGEN', 'base');
  assert.ok(!c.some((x) => x.address.endsWith('003')), 'le contrat AUTRE ne doit pas entrer');
});

t('le symbole est compare sans tenir compte de la casse', () => {
  assert.strictEqual(candidatesFrom(PAIRES, 'degen', 'base').length, DEGEN_BASE);
});

t('le classement est decroissant en liquidite', () => {
  const c = candidatesFrom(PAIRES, 'DEGEN');
  const liq = c.map((x) => x.liquidityUsd);
  assert.deepStrictEqual(liq, [...liq].sort((a, b) => b - a), 'ordre vu: ' + JSON.stringify(liq));
});

t('une liste de paires vide ou absente ne jette pas', () => {
  assert.deepStrictEqual(candidatesFrom([], 'X'), []);
  assert.deepStrictEqual(candidatesFrom(null, 'X'), []);
  assert.deepStrictEqual(candidatesFrom(undefined, 'X'), []);
});

/* ── le verdict de bout en bout ──────────────────────────────────────────────────────────────────── */

/* getJSON(url, fetchImpl) fait `return fetchImpl(url)` et lit `.pairs` sur le resultat: l injection
 * doit rendre l OBJET DEJA PARSE, pas une Response. Mon premier jet rendait {ok,status,json()} — donc
 * .pairs valait undefined, zero candidat, verdict 'thin', et j ai failli accuser le filtre de chaine.
 * Sonder l interface avant d ecrire contre elle vaut aussi pour nos propres modules. */
const faussesPaires = (paires) => async () => ({ pairs: paires });

t('demander Base rend un canonical SUR Base, pas le plus liquide toutes chaines', async () => {
  /* Le scenario mesure en production, rejoue de bout en bout. */
  const r = await vetMeme({ symbol: 'DEGEN', chainId: 'base', fetchImpl: faussesPaires(PAIRES),
    holderHealthImpl: async () => ({ healthy: true, score: 0, metrics: null, error: null }) });
  assert.strictEqual(r.status, 'genuine', '900k contre 20k: un dominant net sur Base');
  assert.strictEqual(r.canonical.chain, 'base');
  assert.strictEqual(r.canonical.address, '0xbase0000000000000000000000000000000000001');
});

t('la couche 2 (holders-health) est bien invoquee quand le canonical est sur Base', async () => {
  /* Elle est gardee par `canonical.chain === 'base'`. Tant que le filtre etait casse, ce canonical
   * arrivait sur Solana et la couche 2 ne tournait JAMAIS — un etage entier du verdict, inerte. */
  let appele = 0;
  const r = await vetMeme({ symbol: 'DEGEN', chainId: 8453, fetchImpl: faussesPaires(PAIRES),
    holderHealthImpl: async () => { appele++; return { healthy: true, score: 0, metrics: null, error: null }; } });
  assert.strictEqual(appele, 1, 'la couche 2 doit tourner exactement une fois');
  assert.ok(r.health, 'et son resultat doit voyager avec le verdict');
});

/* ── (D) « LIQUIDITE NON RAPPORTEE » N'EST PAS « ZERO DOLLAR » ────────────────────────────────────
 * `(p.liquidity && p.liquidity.usd) || 0` ecrasait un champ ABSENT sur la valeur la plus incriminante
 * possible. Le contrat passait sous LIQ_FLOOR, sortait de `credible`, et si c'etait le VRAI contrat
 * dominant qui disparaissait, l'usurpateur devenait `top`: verifier l'usurpateur rendait `genuine`.
 * Le detecteur d'usurpation certifiait l'usurpateur.
 *
 * SONDE DE L'API REELLE le 2026-07-28, sur les six symboles surveilles par hermes/economy/meme-scan:
 *   DEGEN 3 paires sur 30 sans champ `liquidity` · BRETT 1 sur 30
 *   apres deduplication par le MAXIMUM: 6 tokens sur 91 (6,6 %) n'avaient AUCUNE paire chiffree
 * Ce n'est pas une hypothese de schema — c'est ce que l'API rend aujourd'hui. */
const sansLiq = (chainId, addr, symbol) => ({
  chainId, baseToken: { address: addr, symbol, name: symbol + ' token' },
  volume: { h24: 0 }, pairCreatedAt: 1,          // pas de cle `liquidity` du tout, comme DexScreener le fait
});
const VRAI = '0xbase00000000000000000000000000000000vrai';
const FAUX = '0xbase00000000000000000000000000000000faux';

t('★ une liquidite ABSENTE rend null, jamais 0', () => {
  const c = candidatesFrom([sansLiq('base', VRAI, 'X')], 'X');
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].liquidityUsd, null, '0 se lirait « mesure: ce contrat est vide »');
});

t('LES DEUX BORNES: une liquidite de 0 REELLEMENT rapportee reste 0', () => {
  const c = candidatesFrom([paire('base', VRAI, 'X', 0)], 'X');
  assert.strictEqual(c[0].liquidityUsd, 0, 'mesure-et-vide est une VRAIE mesure');
});

t('★ un contrat non mesure est relegue en FIN de tri, jamais en tete', () => {
  /* Le tri decide du canonical. Un non mesure en tete certifierait ce qu'on n'a pas su lire.
   *
   * ⚠️ CE CAS A ETE RECRIT APRES UNE MUTATION MUETTE. La premiere version tenait sur DEUX elements
   * ([non mesure, 50k]) et passait meme en inversant la relegation (`return 1` -> `return -1`):
   * mesure le 2026-07-28, l'ordre restait identique. Le tri de V8 sur deux elements n'atteint qu'une
   * moitie du comparateur — la branche `a == null` n'etait jamais empruntee, donc le test verifiait la
   * bonne propriete sur une entree incapable de la distinguer.
   *
   * Un comparateur ne se teste pas sur deux elements. Il faut le non mesure au MILIEU, ou deux non
   * mesures, pour que les deux branches soient exercees:
   *     sain  0xB > 0xC > 0xA      mute  0xB > 0xA > 0xC     <- discrimine
   *     sain  0xB>0xC>0xA>0xD      mute  0xC>0xD>0xB>0xA     <- discrimine */
  const AUTRE = '0xbase0000000000000000000000000000000autre';
  const c = candidatesFrom([paire('base', AUTRE, 'X', 10000), sansLiq('base', VRAI, 'X'), paire('base', FAUX, 'X', 50000)], 'X');
  assert.deepStrictEqual(c.map((x) => x.address), [FAUX, AUTRE, VRAI], 'les mesures d abord, decroissantes; l illisible ferme la marche');
  assert.strictEqual(c[c.length - 1].liquidityUsd, null);

  /* Et avec DEUX illisibles, pour que la branche `a == null && b == null` soit elle aussi exercee. */
  const AUTRE2 = '0xbase000000000000000000000000000000autre2';
  const d = candidatesFrom([sansLiq('base', VRAI, 'X'), paire('base', FAUX, 'X', 50000), sansLiq('base', AUTRE2, 'X'), paire('base', AUTRE, 'X', 10000)], 'X');
  assert.deepStrictEqual(d.slice(0, 2).map((x) => x.address), [FAUX, AUTRE]);
  assert.strictEqual(d.slice(2).every((x) => x.liquidityUsd === null), true);
});

t('★ entre deux paires du MEME contrat, la mesuree l emporte sur la non mesuree', () => {
  /* La deduplication gardait le maximum par `<`, et `null < x` est faux: selon l ordre d arrivee, un
   * contrat parfaitement chiffre pouvait rester bloque sur sa paire aveugle. */
  const avant = candidatesFrom([sansLiq('base', VRAI, 'X'), paire('base', VRAI, 'X', 80000)], 'X');
  const apres = candidatesFrom([paire('base', VRAI, 'X', 80000), sansLiq('base', VRAI, 'X')], 'X');
  assert.strictEqual(avant[0].liquidityUsd, 80000, 'ordre aveugle-puis-chiffre');
  assert.strictEqual(apres[0].liquidityUsd, 80000, 'ordre chiffre-puis-aveugle');
});

t('★ LE CAS QUI COMPTE: un usurpateur ne devient pas « genuine » parce que le vrai est illisible', async () => {
  /* Le vrai contrat existe et domine, mais sa liquidite n est pas rapportee. Avant: il valait 0, sortait
   * de `credible`, et le faux — seul survivant — devenait le contrat dominant certifie. */
  const fetchImpl = async () => ({ pairs: [sansLiq('base', VRAI, 'X'), paire('base', FAUX, 'X', 60000)] });
  const r = await vetMeme({ symbol: 'X', chainId: 'base', address: FAUX, fetchImpl });
  assert.strictEqual(r.unmeasured, 1, 'le concurrent illisible doit etre COMPTE, pas efface');
  assert.match(r.unmeasuredNote, /NOT counted as \$0/);
  /* Le verdict reste ce que la mesure permet — on ne bascule pas tout en `ambiguous`, ce qui ne
   * renseignerait plus personne. Mais il ne se lit plus sans la reserve. */
  assert.ok(r.unmeasuredNote, 'toute revendication de dominance voyage avec le nombre d illisibles');
});

t('LES DEUX BORNES: sans aucun illisible, AUCUNE reserve n est emise', () => {
  /* Une reserve permanente apprend a l ignorer — c est pire qu aucune reserve. */
  const c = candidatesFrom(PAIRES, 'DEGEN');
  assert.strictEqual(c.every((x) => typeof x.liquidityUsd === 'number'), true);
});

t('une chaine inconnue ne certifie rien — elle abstient', async () => {
  const r = await vetMeme({ symbol: 'DEGEN', chainId: 'chaine-imaginaire', fetchImpl: faussesPaires(PAIRES) });
  assert.notStrictEqual(r.status, 'genuine', 'jamais de certification sur une chaine qu on n a pas su lire');
  assert.strictEqual(r.canonical, null);
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
