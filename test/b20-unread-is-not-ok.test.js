#!/usr/bin/env node
'use strict';
/**
 * Une lecture de code RATEE ne doit pas se lire comme un controle REUSSI.
 *
 * `classifyB20` ne jette pas quand la chaine ne repond pas : `rpc()` fait `resolve(null)` sur l'erreur
 * reseau ET sur un JSON illisible, donc la fonction RETOURNE `{ verdict: 'unknown' }`. Or son appelant
 * dans token-radar.js ne se garde que contre le jet :
 *
 *     try { b = await classifyB20(CHAIN, c.addr); }
 *     catch (e) { b20Echec++; db[c.addr].b20Check = 'failed'; continue; }
 *     if (db[c.addr]) db[c.addr].b20Check = 'ok';     // <- tire aussi sur verdict 'unknown'
 *
 * Consequence mesurable d'une panne RPC sur Base : chaque token 0xb200 est enregistre `b20Check: 'ok'`,
 * `b20Echec` reste a 0, la ligne « ⚠️ N B20 classification(s) failed » du digest ne s'imprime pas, et
 * le flag « l'emetteur peut geler et bruler le solde de n'importe quel porteur » n'est jamais pose.
 * Le token garde son verdict `unknown` — indiscernable d'une abstention ordinaire.
 *
 * C'est le motif numero un du depot: l'echec revient en VALEUR, l'appelant ne garde que le JET.
 * Ces cas verifient les DEUX moities: que le classifieur rende bien un etat non concluant sans jeter,
 * et que la persistance de l'appelant distingue « lu » de « pas lu ».
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { classifyB20 } = require('../lib/b20.js');

let pass = 0, fail = 0;
// Le harnais compte aussi ses propres echecs SYNCHRONES. Premiere version: `fn()` etait appele hors
// try, donc une assertion synchrone qui echouait remontait jusqu'a `main` et tuait la suite — les cas
// suivants n'ont jamais tourne et le total ne le disait pas. Une suite qui s'arrete sans se compter
// ment par omission, exactement comme le code qu'elle surveille.
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

const ADDR_NATIF = '0xb200000000000000000000602c95f70b5d3aea2d';

async function main() {
  console.log('b20: une lecture ratee n\'est pas un controle reussi');

  // ── moitie 1 : le classifieur, exerce par injection ────────────────────────────────────────────
  await t('code illisible -> verdict non concluant, SANS jeter', async () => {
    const b = await classifyB20('base', ADDR_NATIF, { rpcImpl: async () => null });
    assert.strictEqual(b.verdict, 'unknown', 'un code non lu doit rester non conclu');
    assert.ok(/could not read/i.test(b.reason || ''), 'la raison doit NOMMER la lecture ratee, pas la deduire');
    // Le point qui pique : ce resultat arrive par retour normal. Tout appelant qui ne se garde que
    // contre le jet le traitera comme une classification aboutie.
    assert.notStrictEqual(b.verdict, 'native_b20');
    assert.notStrictEqual(b.verdict, 'prefix_impostor');
  });

  await t('le marqueur natif exact reste reconnu (le cas oppose)', async () => {
    const b = await classifyB20('base', ADDR_NATIF, { rpcImpl: async () => '0xef' });
    assert.strictEqual(b.verdict, 'native_b20');
    assert.strictEqual(b.isNativeB20, true);
  });

  // Un test qui ne verifie que le cas non concluant passerait aussi sur un classifieur qui rend
  // toujours 'unknown'. Il faut un cas OPPOSE pour que la mesure ait une borne.
  await t('du bytecode ordinaire sous le prefixe reste un imposteur', async () => {
    const b = await classifyB20('base', ADDR_NATIF, { rpcImpl: async () => '0x60806040523480156100' });
    assert.strictEqual(b.verdict, 'prefix_impostor');
  });

  // ── moitie 2 : l'appelant persiste-t-il la difference ? ────────────────────────────────────────
  // Reclamation de CLASSE sur la source: on ne peut pas provoquer une panne RPC de Base a volonte,
  // donc on verifie la propriete structurelle dont depend la distinction. Commentaires retires
  // d'abord — une regle qui matche un commentaire ne prouve rien sur le code.
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'hermes', 'economy', 'token-radar.js'), 'utf8')
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

  await t('token-radar distingue « lu » de « pas lu » apres classifyB20', () => {
    assert.ok(/b20Check\s*=\s*'unread'/.test(SRC),
      'aucun etat « unread » persiste: un verdict `unknown` de classifyB20 sera enregistre comme un controle reussi');
  });

  await t('token-radar persiste CE QUE le classifieur a repondu, pas seulement qu il a repondu', () => {
    assert.ok(/b20Kind\s*=/.test(SRC),
      'la classification (native_b20 / prefix_impostor) n est ecrite nulle part: aucun rejeu ne peut '
      + 'redecouper la base par mecanisme, il doit deviner depuis le prefixe d adresse');
  });

  // Format IMPOSE par test/suite-total.js, qui compte les bilans pour verifier qu'aucune suite ne
  // manque au total. Ma premiere version imprimait « 5 ok, 0 fail » — un troisieme format, donc un
  // fichier lance mais jamais compte: 83 bilans lus pour 84 fichiers, et le decalage a ete signale.
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
