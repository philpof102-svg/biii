#!/usr/bin/env node
'use strict';
/**
 * Un tool, trois modes, et l'echec doit se lire pareil dans les trois.
 *
 * `till_trace_theft` signale l'echec par `{ error }` — la convention de ce handler, employee quinze
 * fois dans le fichier. Le mode `moved` la respectait; le mode `bridge` renvoyait `readBridgeExit`
 * tel quel, donc `{ ok: false, reason }` SANS `error`. Un agent qui suit la convention du tool teste
 * `.error`, n'en trouve pas, conclut a une reponse, et va chercher `destinationChains` dans un objet
 * qui n'en a pas.
 *
 * Le correctif etait alle sur une route et pas sur sa jumelle, a l'interieur d'un seul handler. C'est
 * le motif de divergence entre soeurs, et il ne se voit pas en lisant la route corrigee.
 *
 * ⚠️ Ces cas n'atteignent AUCUN reseau: une chaine non cablee fait sortir `whatMoved` et
 * `readBridgeExit` avant le premier appel HTTP. Un test qui aurait besoin du reseau pour verifier une
 * forme de reponse serait un test qu'on finit par desactiver.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { callTool } = require('../bin/biii-mcp');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const TX = '0x' + 'cd'.repeat(32);
const PAS_CABLEE = 'chaine-qui-n-existe-pas';

async function main() {
  console.log('till_trace_theft: les trois modes echouent de la meme facon');

  await t('★ mode bridge — un echec porte `error`, pas seulement `ok: false`', async () => {
    const r = await callTool('till_trace_theft', { mode: 'bridge', chain: PAS_CABLEE, txHash: TX });
    assert.strictEqual(r.ok, false, 'l echec doit rester lisible par `ok` — le correctif est ADDITIF');
    assert.ok(typeof r.error === 'string' && r.error.length > 0,
      'la convention du handler est `{ error }`; sans lui l echec passe pour une reponse: ' + JSON.stringify(r));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '`reason` ne doit pas disparaitre');
  });

  await t('mode moved — meme forme exactement', async () => {
    const r = await callTool('till_trace_theft', { mode: 'moved', chain: PAS_CABLEE, txHash: TX });
    assert.strictEqual(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  });

  /* Le cas OPPOSE. Sans lui, un handler qui collerait `error` sur TOUTE reponse passerait ces tests —
   * et rendrait la convention inutile en la declenchant toujours. */
  await t('★ un argument manquant est refuse AVANT tout appel, et ne se deguise pas en panne de chaine', async () => {
    const r = await callTool('till_trace_theft', { mode: 'bridge' });
    assert.ok(/txHash is required/i.test(r.error || ''), 'la validation doit parler d elle-meme: ' + JSON.stringify(r));
    assert.notStrictEqual(r.ok, false, 'une validation d argument n est pas un echec de lecture de la chaine');
  });

  await t('un mode inconnu est nomme, jamais traite en silence', async () => {
    const r = await callTool('till_trace_theft', { mode: 'nawak', txHash: TX });
    assert.ok(/mode must be one of/i.test(r.error || ''), JSON.stringify(r));
  });

  /* Reclamation de CLASSE. Les cas ci-dessus couvrent les modes d'AUJOURD'HUI; celui-ci couvre le
   * quatrieme mode que quelqu'un ajoutera. Commentaires retires d'abord — une convention citee dans un
   * commentaire n'a jamais protege personne. */
  await t('★ tout mode du handler traduit son echec dans la convention `error`', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'biii-mcp.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const bloc = (src.match(/if \(name === 'till_trace_theft'\)[\s\S]*?\n  \}/) || [])[0];
    assert.ok(bloc, 'le handler est introuvable — extraction a reparer avant de conclure quoi que ce soit');

    const modes = [...bloc.matchAll(/a\.mode === '(\w+)'/g)].map((m) => m[1]);
    assert.ok(modes.length >= 3, 'succes VIDE: ' + modes.length + ' mode(s) vu(s), le garde ne reconnait plus le handler');

    /* ⚠️ PREMIERE VERSION DE CE GARDE: PASSAIT A VIDE. Elle cherchait `error:` quelque part dans le corps
     * du mode — or CHAQUE mode commence par une validation d'argument qui contient deja `error:`. Le garde
     * aurait donc innocente exactement le code qu'il etait cense attraper. Verifie contre l'ancien corps,
     * pas suppose.
     *
     * Le vrai discriminant est le PASSE-PLAT BRUT: `return await <helper>(...)` rend la forme du helper
     * telle quelle, donc sa convention d'echec au lieu de la notre. Un mode conforme capture le resultat
     * et le traduit. Seule exception admise: `followTron`, dont on a VERIFIE qu'il ne rend jamais
     * `ok: false` (il porte son arret dans le resultat) — une exception nommee, pas une categorie floue. */
    const passePlat = [];
    for (const m of modes) {
      const i = bloc.indexOf("a.mode === '" + m + "'");
      const fin = bloc.indexOf("a.mode === '", i + 10);
      const corps = bloc.slice(i, fin === -1 ? bloc.length : fin);
      const brut = [...corps.matchAll(/return await (\w+)\(/g)].map((x) => x[1]).filter((h) => h !== 'followTron');
      if (brut.length) passePlat.push(m + ' -> ' + brut.join(', '));
    }
    assert.deepStrictEqual(passePlat, [],
      'mode(s) qui renvoient le helper TEL QUEL, donc sa convention d echec au lieu de `{ error }`: '
      + passePlat.join(' | '));
  });

  await t('★ le garde de classe mord — verifie sur l ancien corps, celui du defaut', () => {
    /* Un garde qu'on vient de reecrire doit reprouver qu'il attrape. On rejoue le mode `bridge` tel
     * qu'il etait ecrit avant le correctif, y compris sa validation d'argument — c'est precisement ce
     * `error:` la qui rendait la premiere version du garde aveugle. */
    const ancien = "    if (a.mode === 'bridge') {\n"
      + "      if (!a.txHash) return { error: 'txHash is required for mode \"bridge\"' };\n"
      + "      return await readBridgeExit(chain, a.txHash);\n    }";
    const brut = [...ancien.matchAll(/return await (\w+)\(/g)].map((x) => x[1]).filter((h) => h !== 'followTron');
    assert.deepStrictEqual(brut, ['readBridgeExit'], 'le garde doit voir le passe-plat de l ancien code');

    // Et le cas OPPOSE: le corps corrige ne doit PAS etre accuse.
    const corrige = "      const b = await readBridgeExit(chain, a.txHash);\n"
      + "      return b && b.ok ? b : { ...b, error: (b && b.reason) || 'x' };";
    assert.deepStrictEqual(
      [...corrige.matchAll(/return await (\w+)\(/g)].map((x) => x[1]).filter((h) => h !== 'followTron'), [],
      'un corps conforme ne doit pas etre accuse');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
