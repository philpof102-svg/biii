#!/usr/bin/env node
'use strict';
/**
 * Une skill qui demande un outil que le garde refuse envoie l'agent dans un mur, chaque tour.
 * ==========================================================================================
 * Les `SKILL.md` de `hermes/skills/` sont des INSTRUCTIONS: elles nomment les outils que l'agent doit
 * appeler. Le hook `readonly-guard.js` est monte en `pre_tool_call` sur le nœud toujours allume
 * (`hermes/node/config.template.yaml`). Personne ne confrontait les deux. Mesure du 2026-08-15, en
 * EXECUTANT le garde sur chaque outil cite en backticks:
 *
 *   base-token-trust : 6 outils, 5 passent, `till_create_charge` BLOQUE (et il existe bien)
 *   x-devradar       : 5 outils, `monid_run` BLOQUE (voulu, opt-in), `monid_get_run` BLOQUE (defaut)
 *   market-analyst   : 0 outil cite
 *
 * 🔴 `monid_get_run` est une LECTURE — recuperer le resultat d'un run deja paye — attrapee parce que
 * son nom finit par `_run`. En mode non attendu, l'agent ne pouvait meme pas relire un run passe.
 *
 * ⛔ ET LE COMMENTAIRE DU GARDE SE TROMPAIT SUR SON PROPRE EXEMPLE. Il justifie sa prudence en citant
 * « `get-transfer-history` porte `transfer` » — avec des TIRETS, ou la regex ne matche pas. Ecrit avec
 * des UNDERSCORES, la convention reelle des noms MCP, `get_transfer_history` est BLOQUE. L'exemple qui
 * defend la regle tombe sous la regle.
 *
 * ⚖️ POURQUOI UNE LISTE EXACTE ET PAS UNE REGLE. J'ai teste l'exemption structurelle « un dernier
 * segment commencant par get_/list_/… echappe a MONEY_VERB »: elle DEBLOQUE `get_buy_link`, qui rend
 * un lien d'achat et doit rester bloque. Un elargissement flou echange un faux positif contre un faux
 * negatif; une liste exacte n'echange rien.
 *
 * ⚖️ BORNES. Aucun outil n'est appele: on ne fait que demander son verdict au garde, en sous-processus.
 * Et ceci ne dit rien de ce que le nœud DEPLOYE execute — il tourne une COPIE du garde.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let pass = 0; let fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('skills vs guard — ce que les skills demandent, ce que le garde permet:');

const RACINE = path.join(__dirname, '..');
const GARDE = path.join(RACINE, 'hermes', 'agents', 'biii-monitor', 'readonly-guard.js');
const SKILLS = path.join(RACINE, 'hermes', 'skills');

const verdict = (nom, env = {}) => {
  const out = execFileSync(process.execPath, [GARDE], {
    input: JSON.stringify({ tool_name: nom }), encoding: 'utf8',
    env: Object.assign({}, process.env, { READONLY_GUARD_LOG: path.join(require('node:os').tmpdir(), 'guard-test.log') }, env),
  });
  return out.trim() === '' ? 'passe' : 'bloque';
};

/* Les outils cites en backticks dans les SKILL.md. Les cles de front-matter ne sont pas des outils. */
function outilsDe(skill) {
  const md = fs.readFileSync(path.join(SKILLS, skill, 'SKILL.md'), 'utf8');
  return [...new Set([...md.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)].map((m) => m[1]))]
    .filter((n) => !/^(required_|requires_|fallback_)/.test(n));
}

/* Chaque outil bloque doit avoir sa raison ECRITE. Une entree en plus fait rougir aussitot. */
const BLOCAGES_ATTENDUS = new Map([
  ['till_create_charge', 'cree une autorisation de depense: la section C de base-token-trust est'
    + ' explicitement marquee « attended sessions only », un nœud non attendu reste un moniteur'],
  ['monid_run', 'depense (~$0.025/cycle): debloque uniquement par l opt-in MONID_ALLOW_SPEND=1, que'
    + ' le garde documente en nommant cette skill'],
]);

test_principal();
function test_principal() {
  const skills = fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')));

  t('les skills sont lues et citent des outils', () => {
    assert.ok(skills.length >= 2, 'succes vide: ' + skills.length + ' skill(s)');
    const total = skills.reduce((n, s) => n + outilsDe(s).length, 0);
    assert.ok(total >= 8, 'succes vide: ' + total + ' outil(s) cite(s) au total');
  });

  t('★ tout outil demande par une skill passe le garde, ou sa raison est ecrite', () => {
    const bloques = [];
    for (const s of skills) for (const n of outilsDe(s)) {
      if (verdict(n) === 'bloque') bloques.push(n);
    }
    assert.deepEqual([...new Set(bloques)].sort(), [...BLOCAGES_ATTENDUS.keys()].sort(),
      'ecart entre ce que les skills demandent et ce que le garde permet.\n       bloques: '
      + [...new Set(bloques)].sort().join(' ') + '\n       attendus: ' + [...BLOCAGES_ATTENDUS.keys()].sort().join(' ')
      + '\n  Un outil EN PLUS = une skill envoie l agent dans un mur a chaque tour. Un EN MOINS = il'
      + ' passe desormais: retirer sa ligne, ou verifier qu on ne vient pas d ouvrir une depense.');
  });

  t('★ une LECTURE n est jamais bloquee, meme si son nom finit par un verbe d argent', () => {
    /* Le cas qui a fait naitre la liste exacte. */
    assert.strictEqual(verdict('monid_get_run'), 'passe',
      'relire un run deja paye ne depense rien — et un garde qui bloque les lectures se fait retirer');
  });

  t('★ la liste des lectures ne debloque QUE ce qu elle nomme', () => {
    /* Cas oppose, et il porte le raisonnement: une regle structurelle aurait debloque celui-ci. */
    assert.strictEqual(verdict('get_buy_link'), 'bloque',
      'get_buy_link commence par get_ mais rend un lien d achat: une exemption par PREFIXE le laisserait passer');
    for (const n of ['send', 'swap', 'sign', 'request_swap', 'pay_x402', 'reopen_signing_window', 'fund']) {
      assert.strictEqual(verdict(n), 'bloque', n + ' doit rester bloque');
    }
  });

  t('l opt-in monid ne debloque QUE monid, jamais le reste', () => {
    assert.strictEqual(verdict('monid_run', { MONID_ALLOW_SPEND: '1' }), 'passe');
    for (const n of ['send', 'swap', 'till_create_charge', 'request_transfer']) {
      assert.strictEqual(verdict(n, { MONID_ALLOW_SPEND: '1' }), 'bloque',
        n + ' doit rester bloque meme avec l opt-in monid');
    }
  });

  t('la skill qui demande un outil bloque le DIT dans son texte', () => {
    /* Sans ceci, on aurait une liste d exceptions dans un test que la skill ignore. */
    const md = fs.readFileSync(path.join(SKILLS, 'base-token-trust', 'SKILL.md'), 'utf8');
    assert.match(md, /attended/i, 'la section payante doit se declarer reservee aux sessions attendues');
    assert.match(md, /readonly-guard/, 'et nommer le hook qui la bloque, pour qu on ne le desactive pas');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
}
