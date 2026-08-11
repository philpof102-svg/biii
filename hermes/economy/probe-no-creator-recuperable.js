#!/usr/bin/env node
// probe-no-creator-recuperable.js — « pas de createur indexe » : propriete de la CHAINE, ou du CHEMIN ?
// ================================================================================================
// `probe-couverture-dans-le-temps.js` a etabli que la couverture est plate a ~53 % et que la cause
// historique a ete remplacee une-pour-une par `no_creator`. La branche « sur » plafonne donc a 29 %.
// Reste une question qui decide de ce qu'on peut y faire: cette illisibilite vient-elle de la chaine,
// ou du seul chemin qu'on interroge ?
//
// CE QUE LE CODE FAIT (lib/feeder.js, etape 1): il lit `creator_address_hash` sur `/addresses/{addr}` de
// l'explorateur. C'est un champ d'INDEX, une commodite offerte par Blockscout — pas une donnee de la
// chaine. Quand l'index ne l'a pas, `traceFeeder` s'arrete la. Aucun repli n'existe.
//
// ⛔ ET LE MESSAGE D'ERREUR NOMME DEUX CAUSES SANS JAMAIS LES SEPARER: « it may not be a contract, or its
// creation predates the index ». Ce sont deux mondes differents — l'un dit qu'on interroge la mauvaise
// adresse, l'autre qu'on interroge le mauvais index — et le depot les compte ensemble depuis le debut.
// `eth_getCode` les separe en UN appel, et c'est ce que cette sonde mesure sur un echantillon borne.
//
// ⚠️ CE QU'ELLE PEUT PROUVER: quelle part des adresses `no_creator` porte du bytecode. Une adresse SANS
// bytecode n'est pas un contrat: aucun index, aucun noeud, aucune archive ne lui trouvera de createur.
// ⛔ CE QU'ELLE NE PEUT PAS: rendre le createur des autres. Le JSON-RPC standard n'a PAS d'appel
// « qui a cree ce contrat » — Blockscout le sait parce qu'il indexe les traces. Trouver la transaction
// de creation demande un noeud d'archive avec `trace_`/`debug_`, ce que les points publics n'offrent
// pas. Constater qu'un contrat existe ne dit donc pas qu'on peut nommer son createur.
// ⛔ ELLE NE PROPOSE AUCUN CHANGEMENT.
//
// Lecture SEULE (un `eth_getCode` par adresse echantillonnee, aucune ecriture, aucune signature).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_RPC } = require('../../lib/chain');

const RACINE = path.join(__dirname, '..', '..');
const ECHANTILLON = Math.min(Number(process.argv[2]) || 20, 60);
const rows = Object.entries(JSON.parse(fs.readFileSync(
  path.join(RACINE, 'data/token-radar/tokens.json'), 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

/* ⛔ LE CHAMP SOUS-COMPTE, ET LE MESSAGE DIT LA VERITE. Mesure du 2026-08-11 sur 2436 lignes:
 *   funderTrace === 'no_creator'                 540
 *   message « records no creator »               631   (les 540 y sont TOUS inclus)
 *   message SEUL, avec funderTrace === 'failed'   91   <- meme cause, autre etiquette
 * Ces 91 ont EXACTEMENT le profil des 540 — 0 `deployer`, 0 `funder`, 0 `siblingCount` — contre le
 * temoin `funderTrace === 'ok'` qui en porte 920/920/919. Deux champs du meme producteur se
 * contredisent donc sur 3,7 pct de la base: le message dit « l explorateur A REPONDU », le champ dit
 * `failed`. Selectionner sur le champ seul ratait 14,4 pct de la population.
 * ⛔ `token-radar.js` est sha256-epingle: la classification ne se corrige pas ici. Cette sonde prend
 * donc l UNION, et le dit — mesurer la bonne population n est pas trancher laquelle des deux
 * etiquettes est la bonne. */
const parLeChamp = (t) => t.funderTrace === 'no_creator';
const parLeMessage = (t) => typeof t.funderTraceError === 'string'
  && t.funderTraceError.indexOf('records no creator') > -1;
const nc = rows.filter((t) => parLeChamp(t) || parLeMessage(t));
{
  const champSeul = rows.filter((t) => parLeChamp(t) && !parLeMessage(t)).length;
  const msgSeul = rows.filter((t) => !parLeChamp(t) && parLeMessage(t)).length;
  console.log('  ⚠️ population prise en UNION: ' + nc.length + ' (champ ' + rows.filter(parLeChamp).length
    + ' · message ' + rows.filter(parLeMessage).length + ' · message SEUL ' + msgSeul
    + ' · champ SEUL ' + champSeul + ')');
  if (msgSeul) console.log('     ces ' + msgSeul + ' portent `funderTrace: failed` alors que leur message dit'
    + ' que l explorateur A REPONDU — meme cause, etiquette differente.');
}
const ok = rows.filter((t) => t.funderTrace === 'ok');

console.log('\n  ── CE QUE LA BASE SAIT DEJA ──\n');
const porte = (g, champ, pred) => g.filter(pred).length;
const chaine = (t) => typeof t === 'string' && t.length > 10;
console.log('    tokens `no_creator`                      ' + nc.length);
console.log('      dont portant un `deployer`             ' + porte(nc, 0, (t) => chaine(t.deployer)));
console.log('      dont portant un `funder`               ' + porte(nc, 0, (t) => chaine(t.funder)));
console.log('      dont portant un `siblingCount`         ' + porte(nc, 0, (t) => typeof t.siblingCount === 'number'));
console.log('    temoin: tokens `ok` portant un deployer  ' + porte(ok, 0, (t) => chaine(t.deployer)) + ' / ' + ok.length);
console.log('\n  ⛔ L information n a JAMAIS ete obtenue par une autre route, pas une seule fois. Il n existe');
console.log('     donc aucun chemin de secours deja emprunte dont on pourrait constater l efficacite.');
console.log('  ⚠️ `lib/chain.js` fournit pourtant une couche JSON-RPC testee (eth_getLogs, eth_getBlockByNumber,');
console.log('     eth_getTransactionReceipt). La machinerie existe; ce qui manque est une route vers le createur.');

/* ── LA SEULE CHOSE QU'UN APPEL BON MARCHE PEUT TRANCHER ─────────────────────────────────────────
 * ⛔ `rpc()` n'est PAS exporte par lib/chain.js — seul `DEFAULT_RPC` l'est. Cette sonde refait donc un
 * POST JSON-RPC minimal plutot que de recopier la logique du module, et le dit. Si `rpc` devenait
 * exporte, cet appel devrait passer par lui. */
async function getCode(addr) {
  const r = await fetch(DEFAULT_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [addr, 'latest'] }),
  });
  if (!r.ok) return { err: 'HTTP ' + r.status };
  const j = await r.json();
  if (j.error) return { err: j.error.message || 'erreur RPC' };
  return { code: typeof j.result === 'string' ? j.result : null };
}

(async () => {
  /* Echantillon deterministe: les N premiers par ordre d'adresse, pour que deux executions comparent
   * la meme chose. Un tirage aleatoire rendrait la sortie irreproductible sans rien apporter ici. */
  const cible = nc.map((t) => t.addr).sort().slice(0, ECHANTILLON);
  console.log('\n  ── `eth_getCode` SUR UN ECHANTILLON DE ' + cible.length + ' ADRESSES `no_creator` ──\n');
  console.log('     point interroge: ' + DEFAULT_RPC + '  ·  lecture seule, aucune ecriture');
  let contrat = 0, vide = 0, erreur = 0;
  const echecs = new Map();
  for (const a of cible) {
    const r = await getCode(a);
    if (r.err) { erreur++; echecs.set(r.err, (echecs.get(r.err) || 0) + 1); continue; }
    if (r.code === null) { erreur++; echecs.set('resultat non textuel', (echecs.get('resultat non textuel') || 0) + 1); continue; }
    if (r.code === '0x' || r.code === '0x0') vide++; else contrat++;
  }
  console.log('\n    porte du bytecode (c est un CONTRAT)     ' + contrat);
  console.log('    aucun bytecode (ce n est PAS un contrat) ' + vide);
  console.log('    non repondu (ni l un ni l autre)         ' + erreur
    + (echecs.size ? '   ' + [...echecs.entries()].map(([k, n]) => k + ' x' + n).join(', ') : ''));

  /* ── LE TEMOIN, SANS LEQUEL « 20/20 CONTRATS » NE PROUVE RIEN ────────────────────────────────────
   * Une sortie constante n'est pas une mesure. Si l'appel rendait « contrat » pour tout, le resultat
   * ci-dessus serait un artefact de lecture. On lui donne donc des adresses dont on SAIT qu'elles ne
   * sont pas des contrats: des `funder`, c'est-a-dire des portefeuilles qui ont signe un virement. */
  const temoins = [...new Set(rows.map((t) => t.funder).filter(chaine))].sort().slice(0, 5);
  let tContrat = 0, tVide = 0, tErr = 0;
  for (const a of temoins) {
    const r = await getCode(a);
    if (r.err || r.code === null) { tErr++; continue; }
    if (r.code === '0x' || r.code === '0x0') tVide++; else tContrat++;
  }
  console.log('\n    TEMOIN — ' + temoins.length + ' adresse(s) de `funder` (des portefeuilles, pas des contrats):');
  console.log('      sans bytecode ' + tVide + '   avec bytecode ' + tContrat + '   non repondu ' + tErr);
  const temoinDiscrimine = tVide > 0;
  if (!temoinDiscrimine) {
    console.log('    ⛔ LE TEMOIN NE DISCRIMINE PAS: l appel rend « contrat » meme sur des portefeuilles, ou');
    console.log('       n a pas repondu. Le resultat principal ci-dessus ne se lit donc pas — il pourrait');
    console.log('       n etre qu un artefact de lecture. Rien n est conclu.');
  }

  const lus = temoinDiscrimine ? contrat + vide : 0;
  if (!lus) {
    console.log('\n  ⛔ AUCUNE ADRESSE N A PU ETRE LUE. Rien ne se conclut — ni « ce sont des contrats », ni');
    console.log('     l inverse. Le point RPC n a pas repondu, et c est un troisieme etat, pas un zero.');
  } else if (vide === 0) {
    console.log('\n  💎 TOUTES les adresses lues SONT des contrats. La branche « ce n est peut-etre pas un');
    console.log('     contrat » du message d erreur ne decrit donc AUCUN des cas de cet echantillon: ce qui');
    console.log('     manque est le createur dans l INDEX, pas le contrat sur la chaine.');
  } else if (contrat === 0) {
    console.log('\n  💎 AUCUNE des adresses lues n est un contrat. Le radar interroge des adresses qui n en');
    console.log('     sont pas — c est un probleme de ce qu on lui donne, pas de l explorateur.');
  } else {
    console.log('\n  ⚠️ LES DEUX CAUSES COEXISTENT: ' + contrat + ' contrat(s) et ' + vide + ' non-contrat(s).');
    console.log('     Le message d erreur les confond depuis le debut, et elles n appellent pas le meme geste.');
  }

  console.log('\n  ⛔ ET CONSTATER QU UN CONTRAT EXISTE NE REND PAS SON CREATEUR. Le JSON-RPC standard n a');
  console.log('     aucun appel « qui a cree ce contrat »: Blockscout le sait parce qu il indexe les traces');
  console.log('     d execution. Retrouver la transaction de creation demande un noeud d ARCHIVE offrant');
  console.log('     `trace_`/`debug_`, ce que les points publics gratuits n offrent pas. Cette sonde separe');
  console.log('     deux causes; elle n en resout aucune.');
  console.log('  ⛔ ECHANTILLON BORNE A ' + cible.length + ' SUR ' + nc.length + ', pris par ordre d adresse pour rester');
  console.log('     reproductible. Ce n est pas un tirage aleatoire, donc pas une estimation de proportion:');
  console.log('     c est un CONSTAT sur ces adresses-la.\n');
})();
