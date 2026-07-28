#!/usr/bin/env node
'use strict';
/**
 * wallet-watch — le seul module du depot qui GARDE UNE MEMOIRE, et le seul qui n'avait aucun test.
 *
 * Pourquoi c'est le pire endroit ou ne pas en avoir: partout ailleurs une faute donne un mauvais verdict
 * sur un appel. Ici elle s'ECRIT SUR LE DISQUE, et fait mentir tous les runs suivants. La reference du
 * prochain diff est produite par le run precedent — une reference fausse ne se rattrape pas, elle se
 * propage.
 *
 * DEUX FAUTES MESUREES ET CORRIGEES LE 2026-07-27:
 *
 *   (A) UN BALAYAGE PARTIEL REECRIVAIT LA REFERENCE. `approvals: liveKeys.length || ap.ok ? liveKeys : …`
 *       gardait uniquement ce qui avait pu etre lu. 2 allocations lues sur 5 -> l'etat n'en retenait que 2,
 *       les 3 autres disparaissaient, et au run suivant elles ressortaient en « NEW approval … Someone
 *       granted it since ». Une affirmation FAUSSE sur la date d'octroi, produite par notre propre oubli —
 *       alors que le module ecrit lui-meme, dix lignes plus haut, qu'« un appel sans reponse n'est pas une
 *       porte fermee ». La divulgation et l'etat se contredisaient.
 *
 *   (B) LE PLAFOND DE 500 GARDAIT LES PLUS ANCIENS. `[...known, ...seenNow].slice(0, 500)` coupait la FIN,
 *       donc `seenNow`. Passe 500 contreparties, une nouvelle etait alertee, jamais enregistree, et
 *       realertait a CHAQUE run indefiniment: le plafond detruisait exactement la propriete pour laquelle
 *       ce module existe — distinguer une porte neuve d'une ancienne.
 *
 * Aucun reseau: `deps` injecte le balayage d'allocations et le lecteur d'explorateur, `stateDir` isole
 * l'etat dans un dossier temporaire.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { watchWallet, readState } = require('../lib/wallet-watch.js');

let pass = 0, fail = 0;
const files = [];
const t = (nom, fn) => files.push([nom, fn]);

const OWNER = '0x1111111111111111111111111111111111111111';
const SPENDER_A = '0xaaaa000000000000000000000000000000000001';
const SPENDER_B = '0xbbbb000000000000000000000000000000000002';

let DIR;
const neuf = () => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-'));
  return DIR;
};
const allocation = (spender, token, extra = {}) => ({
  token, spender, tokenName: 'USDC', allowance: '100', unlimited: false, spenderName: '', ...extra,
});
/** Un balayage d'allocations: ok/complete sont les DEUX axes qui comptent ici. */
const balayage = (live, { ok = true, complete = true, unchecked = 0 } = {}) => async () => ({ ok, complete, unchecked, live });
/** Explorateur muet par defaut: le jugement doit alors le DIRE, pas inventer. */
const explorateurMuet = async () => null;
const explorateur = (parAdresse) => async (url) => {
  if (url.includes('/transactions')) return parAdresse.__txs || { items: [] };
  const a = url.split('/addresses/')[1];
  return parAdresse[String(a).toLowerCase()] || null;
};

console.log('wallet-watch: une reference fausse fait mentir tous les runs suivants');

/* ── (A) LA REFERENCE APRES UNE LECTURE INCOMPLETE ───────────────────────────────────────────────── */

t('★ un balayage PARTIEL ne retire RIEN de la memoire', async () => {
  const dir = neuf();
  // Run 1: complet, deux allocations connues.
  await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA'), allocation(SPENDER_B, '0xtokB')]),
    json: explorateurMuet } });
  const apres1 = readState('base', OWNER, dir);
  assert.strictEqual(apres1.approvals.length, 2, 'les deux sont memorisees');

  // Run 2: la chaine ne rend qu'UNE des deux. L'autre n'est pas revoquee — elle est ILLISIBLE.
  await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA')], { complete: false, unchecked: 1 }),
    json: explorateurMuet } });
  const apres2 = readState('base', OWNER, dir);
  assert.strictEqual(apres2.approvals.length, 2,
    'une allocation non LUE ne doit pas disparaitre de la reference — vu ' + JSON.stringify(apres2.approvals));
});

t('★ et donc le run suivant ne l invente pas comme un octroi recent', async () => {
  /* La consequence qui comptait: sans la correction, ce troisieme run affirmait « Someone granted it
   * since » sur une allocation qui n'avait jamais bouge. Le module accusait a partir de son propre oubli. */
  const dir = neuf();
  const deux = [allocation(SPENDER_A, '0xtokA'), allocation(SPENDER_B, '0xtokB')];
  await watchWallet('base', OWNER, { stateDir: dir, deps: { approvals: balayage(deux), json: explorateurMuet } });
  await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([deux[0]], { complete: false, unchecked: 1 }), json: explorateurMuet } });
  const r3 = await watchWallet('base', OWNER, { stateDir: dir, deps: { approvals: balayage(deux), json: explorateurMuet } });

  assert.deepStrictEqual(r3.alerts, [], 'rien n a change: aucune alerte');
  assert.ok(!JSON.stringify(r3).includes('granted it since'),
    'aucune affirmation d octroi ne doit sortir d une lecture ratee');
});

t('un balayage COMPLET, lui, remplace bien — sinon une revocation ne se verrait jamais', async () => {
  /* La contrepartie de la correction. Si on unissait toujours, une allocation revoquee resterait
   * « connue » pour toujours et le module perdrait sa bonne nouvelle. */
  const dir = neuf();
  await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA'), allocation(SPENDER_B, '0xtokB')]), json: explorateurMuet } });
  const r2 = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA')]), json: explorateurMuet } });

  assert.strictEqual(readState('base', OWNER, dir).approvals.length, 1, 'la revoquee sort de la reference');
  assert.ok(r2.quiet.some((q) => /revoked or spent/.test(q)), 'et elle est signalee comme bonne nouvelle');
});

t('un balayage totalement ECHOUE preserve la memoire entiere', async () => {
  const dir = neuf();
  await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA'), allocation(SPENDER_B, '0xtokB')]), json: explorateurMuet } });
  const r2 = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([], { ok: false }), json: explorateurMuet } });

  assert.strictEqual(readState('base', OWNER, dir).approvals.length, 2, 'rien n est efface sur un echec total');
  assert.ok(r2.unavailable.some((u) => /failed entirely/.test(u)), 'et l echec est dit');
  assert.ok(/does NOT mean nothing happened/.test(r2.note),
    'une liste d alertes vide apres un echec ne doit pas se lire « tout va bien »');
});

t('`complete` ABSENT est traite comme incomplet, pas comme complet', async () => {
  /* Trois etats: complet / incomplet / non renseigne. Le troisieme se range avec le second — la ligne qui
   * pousse l avertissement le lisait deja ainsi (`if (!ap.complete)`), l ecriture d etat ne le faisait pas. */
  const dir = neuf();
  await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA'), allocation(SPENDER_B, '0xtokB')]), json: explorateurMuet } });
  await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: async () => ({ ok: true, live: [allocation(SPENDER_A, '0xtokA')] }),   // pas de `complete`
    json: explorateurMuet } });
  assert.strictEqual(readState('base', OWNER, dir).approvals.length, 2,
    'sans garantie de completude, on n enleve rien');
});

/* ── (B) LE PLAFOND DE MEMOIRE ───────────────────────────────────────────────────────────────────── */

t('★ au-dela du plafond, ce sont les contreparties RECENTES qui sont gardees', async () => {
  const dir = neuf();
  const vieux = Array.from({ length: 500 }, (_, i) => '0x' + String(i).padStart(40, '0'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'base-' + OWNER + '.json'),
    JSON.stringify({ owner: OWNER, chain: 'base', approvals: [], counterparties: vieux }));

  const NOUVELLE = '0xfeed000000000000000000000000000000000001';
  const r = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([]),
    json: explorateur({ __txs: { items: [{ to: { hash: NOUVELLE }, value: '0', method: 'transfer' }] } }) } });

  const etat = readState('base', OWNER, dir);
  assert.ok(etat.counterparties.includes(NOUVELLE),
    'la contrepartie vue CE run doit survivre au plafond — sinon elle realerte a chaque run, indefiniment');
  assert.strictEqual(etat.counterparties.length, 500, 'le plafond tient');
  assert.ok(r.unavailable.some((u) => /capped at 500/.test(u)),
    'une troncature silencieuse se lit « tout est memorise » — elle doit etre dite');
});

t('sous le plafond, rien n est jete et rien n est annonce', async () => {
  const dir = neuf();
  const r = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([]),
    json: explorateur({ __txs: { items: [{ to: { hash: '0xcafe000000000000000000000000000000000001' }, value: '0' }] } }) } });
  assert.ok(!r.unavailable.some((u) => /capped/.test(u)), 'pas d avertissement quand le plafond ne mord pas');
});

/* ── le premier passage ──────────────────────────────────────────────────────────────────────────── */

t('le premier run est un INVENTAIRE et le dit — pas une liste d evenements', async () => {
  const dir = neuf();
  const r = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA')]), json: explorateurMuet } });
  assert.strictEqual(r.firstRun, true);
  assert.match(r.note, /FIRST RUN/);
  assert.match(r.alerts[0].why, /inventory rather than an event/i,
    'la raison doit dire que ca existait deja, pas que quelqu un vient de l accorder');
  assert.ok(!/granted it since/.test(r.alerts[0].why));
});

t('le second run, lui, parle bien d un evenement', async () => {
  const dir = neuf();
  await watchWallet('base', OWNER, { stateDir: dir, deps: { approvals: balayage([]), json: explorateurMuet } });
  const r2 = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA')]), json: explorateurMuet } });
  assert.strictEqual(r2.firstRun, false);
  assert.match(r2.alerts[0].why, /granted it since/, 'la, c est reellement nouveau');
});

/* ── la gravite ──────────────────────────────────────────────────────────────────────────────────── */

t('une allocation ILLIMITEE est haute, quoi que dise l explorateur', async () => {
  const dir = neuf();
  const r = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA', { unlimited: true })]), json: explorateurMuet } });
  assert.strictEqual(r.alerts[0].severity, 'high');
});

t('un beneficiaire signale scam rend une PETITE allocation haute aussi', async () => {
  /* Le jugement ne peut que MONTER la gravite. Une allocation de 100 $ vers une adresse signalee ne doit
   * pas se lire « mineur » sous pretexte que le montant est petit. */
  const dir = neuf();
  const r = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA')]),
    json: explorateur({ [SPENDER_A]: { is_scam: true, is_contract: true, is_verified: true } }) } });
  assert.strictEqual(r.alerts[0].severity, 'high');
  assert.ok(r.alerts[0].judgment.some((n) => /scam-reputation/.test(n)));
});

t('un explorateur MUET ne devient pas un blanc-seing', async () => {
  const dir = neuf();
  const r = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA')]), json: explorateurMuet } });
  assert.ok(r.alerts[0].judgment.some((n) => /did not answer/.test(n)),
    'l absence de reponse doit etre dite, jamais tue');
  assert.notStrictEqual(r.alerts[0].severity, 'low', 'et elle ne rabaisse pas la gravite');
});

/* ── les bords ───────────────────────────────────────────────────────────────────────────────────── */

t('une chaine non cablee refuse au lieu de deviner un explorateur', async () => {
  const r = await watchWallet('dogecoin', OWNER, { stateDir: neuf() });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not wired/);
});

t('une allocation DEJA connue est silencieuse, pas une alerte', async () => {
  const dir = neuf();
  await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA')]), json: explorateurMuet } });
  const r2 = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA')]), json: explorateurMuet } });
  assert.deepStrictEqual(r2.alerts, [], 'un moniteur qui re-alerte se fait fermer');
  assert.ok(r2.quiet.some((q) => /standing approval/.test(q)));
});

t('une liste de transactions indisponible est DITE, pas lue comme « rien n est sorti »', async () => {
  const dir = neuf();
  const r = await watchWallet('base', OWNER, { stateDir: dir, deps: {
    approvals: balayage([]), json: async (url) => (url.includes('/transactions') ? null : null) } });
  assert.ok(r.unavailable.some((u) => /transaction list unavailable/.test(u)));
});

t('persist:false n ecrit rien sur le disque', async () => {
  const dir = neuf();
  await watchWallet('base', OWNER, { stateDir: dir, persist: false, deps: {
    approvals: balayage([allocation(SPENDER_A, '0xtokA')]), json: explorateurMuet } });
  assert.strictEqual(readState('base', OWNER, dir), null, 'aucun etat ne doit avoir ete ecrit');
});

/* ── judgeCounterparty: UN CHAMP ABSENT N'EST PAS UN CHAMP A `false` ────────────────────────────────
 * `judgeCounterparty` etait exportee et nommee dans aucun test. Elle etait pourtant deja soignee sur ce
 * qu'elle ne pouvait pas lire — crible indisponible, explorateur muet — puis `if (info.is_contract)`
 * confondait « l'explorateur dit non » et « l'explorateur n'a rien dit ». Mesure du 2026-07-28, meme
 * `lireJson` injecte :
 *
 *   {is_contract:false} -> « a plain wallet, not a contract »
 *   {}                  -> « a plain wallet, not a contract »   IDENTIQUE, severite null
 *
 * Une reponse 200 a la forme changee faisait AFFIRMER la nature d'une adresse que personne n'avait
 * mesuree, et c'est la lecture RASSURANTE qui sortait. La prudence du module s'arretait a la frontiere
 * du corps de reponse.
 *
 * Ces cas passent par la vraie fonction avec `lireJson` injecte: pas de reseau, et surtout pas d'objet
 * de sortie fabrique a la main — un test qui construit sa propre reponse ne prouve pas qu'elle existe. */
const { judgeCounterparty } = require('../lib/wallet-watch.js');
const CP = '0x' + '1'.repeat(40);
const juge = (rep) => judgeCounterparty('http://explorateur.invalid', CP, async () => rep);
/* Les notes du crible known-bad dependent du plancher present sur la machine: on ne garde que ce que ce
 * cas mesure. Sans ce filtre, l'assertion basculerait selon data/known-bad.json — un test instable. */
const surLaNature = (r) => r.notes.filter((n) => !/known-bad/.test(n)).join(' | ');

t('une reponse SANS le champ ne dit pas « portefeuille simple »', async () => {
  const vide = await juge({});
  const vrai = await juge({ is_contract: false });
  assert.match(surLaNature(vrai), /a plain wallet, not a contract/);
  /* ⚠️ Le coeur du correctif: ces deux phrases doivent DIFFERER. Elles etaient identiques au mot pres. */
  assert.notStrictEqual(surLaNature(vide), surLaNature(vrai));
  assert.doesNotMatch(surLaNature(vide), /a plain wallet, not a contract/);
  assert.match(surLaNature(vide), /did not say whether this address is a contract/);
});

t('un contrat sans `is_verified` n\'est pas declare NON VERIFIE', async () => {
  const absent = await juge({ is_contract: true });
  const faux = await juge({ is_contract: true, is_verified: false });
  assert.match(surLaNature(faux), /UNVERIFIED contract/);
  assert.doesNotMatch(surLaNature(absent), /UNVERIFIED contract/);
  assert.match(surLaNature(absent), /did not say whether its source is verified/);
  /* « Je n'ai pas pu lire » n'escalade PAS: c'est une lacune de notre cote, pas un fait sur le contrat.
   * Escalader ici serait l'erreur symetrique de celle qu'on corrige. */
  assert.strictEqual((await juge({ is_contract: true })).severity, null);
  assert.strictEqual((await juge({ is_contract: true, is_verified: false })).severity, 'medium');
});

t('le chemin qui INFORME n\'a pas ete avale par le durcissement', async () => {
  /* Les deux bornes: un fail-closed qui ne dit plus rien de vrai n'est pas un correctif. */
  assert.match(surLaNature(await juge({ is_contract: true, is_verified: true, name: 'USDC' })),
    /verified contract \(USDC\)/);
  assert.strictEqual((await juge({ is_scam: true, is_contract: false })).severity, 'high');
});

t('un explorateur muet reste distinct d\'une reponse vide', async () => {
  const muet = await juge(null);
  const vide = await juge({});
  assert.match(surLaNature(muet), /the explorer did not answer/);
  /* Trois etats, pas deux: pas de reponse ≠ reponse illisible ≠ reponse qui dit non. */
  assert.notStrictEqual(surLaNature(muet), surLaNature(vide));
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
