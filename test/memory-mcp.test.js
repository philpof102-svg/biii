#!/usr/bin/env node
'use strict';
/**
 * Le verrou de chemin de `memory-mcp` doit borner le FICHIER, pas le nom.
 * ======================================================================
 * `hermes/memory-mcp.js` est le MCP « recall »: il donne a l'agent Hermes local un acces LECTURE
 * SEULE a notre second cerveau (le vault Obsidian + la memoire agent). Sa promesse tient en deux
 * mots — « non-destructive by construction » et « path-locked ». Rien ne le testait.
 *
 * ⛔ LE VERROU ETAIT LEXICAL. `safeResolve` faisait `path.resolve` puis comparait la CHAINE aux
 * racines. `path.resolve` ne suit aucun lien, donc il bornait le nom et pas ce qui serait lu.
 * Mesure du 2026-08-15, sur une racine jetable:
 *
 *   note legitime dans la racine   -> lue        (temoin)
 *   chemin franchement hors racine -> REFUSE     (temoin: le verrou marchait pour le cas evident)
 *   lien SYMBOLIQUE dans la racine -> LU         <<< le contenu hors racine ressortait
 *   lien DUR dans la racine        -> LU
 *   memory_search                  -> 1 correspondance sur le contenu hors racine
 *
 * ⚠️ Et je m'etais trompe en lisant: j'avais conclu que le parcours ne suivait aucun lien parce que
 * `isFile()` est faux sur un lien symbolique. C'est vrai pour les symboliques et FAUX pour les liens
 * durs, qui sont des entrees de repertoire ordinaires — d'ou la correspondance ci-dessus.
 *
 * Le vecteur n'a rien d'exotique: le vault est un depot git qui se SYNCHRONISE, et git transporte
 * les liens symboliques dans un commit. Le serveur est monte pour qu'un agent RAPPELLE — il lit ce
 * qu'on lui nomme.
 *
 * ⚖️ CE QUI RESTE OUVERT, ET QUI EST NOMME PLUTOT QUE MASQUE: un LIEN DUR n'a pas de cible a
 * resoudre — c'est un second nom du meme fichier. `realpath` rend ce nom-la, et aucun chemin ne
 * permet de le distinguer du fichier. Le test l'epingle en l'ETAT, pour qu'un changement se voie.
 *
 * ⚖️ Zero reseau. Tout se passe dans un dossier temporaire cree puis retire par ce test.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0; let fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

console.log('memory-mcp — le rappel en lecture seule:');

/* ── Une racine jetable, montee AVANT le require: le module lit MEMORY_ROOTS au chargement. ────── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'biii-memory-'));
const RACINE = path.join(TMP, 'racine');
const DEHORS = path.join(TMP, 'dehors');
fs.mkdirSync(RACINE); fs.mkdirSync(DEHORS);
fs.mkdirSync(path.join(RACINE, '.git'));
const HORS = path.join(DEHORS, 'hors-racine.md');
fs.writeFileSync(HORS, 'CONTENU HORS RACINE\n');
fs.writeFileSync(path.join(RACINE, 'note.md'), 'une note legitime\n');
fs.writeFileSync(path.join(RACINE, '.git', 'cache.md'), 'ceci ne doit jamais etre indexe\n');

process.env.MEMORY_ROOTS = RACINE;
const M = require('../hermes/memory-mcp.js');
const lire = (f) => M.callTool('memory_read', { file: f });

t('TEMOIN: une note de la racine se lit, et la recherche la trouve', () => {
  const r = lire(path.join(RACINE, 'note.md'));
  assert.ok(!r.error, 'la note legitime doit se lire: ' + r.error);
  assert.match(r.content, /une note legitime/);
  assert.strictEqual(M.callTool('memory_search', { query: 'note legitime' }).matches, 1);
});

t('TEMOIN OPPOSE: un chemin franchement hors racine est refuse', () => {
  assert.match(lire(HORS).error || '', /outside the memory roots/);
});

/* ⚠️ CE CAS DOIT PASSER AVANT CEUX QUI CREENT DES LIENS. Ecrit apres, il comptait 2 notes et
 * accusait le filtre — alors que la 2e etait le lien dur qu'un test PRECEDENT venait de deposer
 * dans la racine. Un test qui mute la fixture d'un autre fabrique un faux defaut. */
t('le filtre de dossiers connait les DEUX separateurs', () => {
  /* La liste ne connaissait que « / »: sur une racine Windows elle ne filtrait rien. */
  const idx = M.callTool('memory_index');
  assert.strictEqual(idx.noteCount, 1, '.git/cache.md ne doit pas etre indexe, vu ' + idx.noteCount);
  assert.strictEqual(M.callTool('memory_search', { query: 'jamais etre indexe' }).matches, 0);
});

/* ★ Le cas qui a fait naitre ce fichier. La creation d'un lien symbolique demande un privilege sur
 * Windows: si elle echoue, on le DIT bruyamment et on ne compte rien — un saut silencieux
 * ressemblerait a une reussite, et c'est exactement le defaut que ce depot poursuit. */
const LIEN_S = path.join(RACINE, 'lien-symbolique.md');
let symOk = false;
try { fs.symlinkSync(HORS, LIEN_S, 'file'); symOk = true; } catch { /* privilege absent */ }
if (symOk) {
  t('★ un lien SYMBOLIQUE place dans la racine ne fait pas sortir la lecture', () => {
    const r = lire(LIEN_S);
    assert.ok(r.error, 'le lien doit etre REFUSE, or il a rendu: ' + JSON.stringify(r.content || '').slice(0, 60));
    assert.match(r.error, /outside the memory roots/);
  });
} else {
  console.log('  ⚠ SAUTE (non compte): lien symbolique impossible ici — privilege Windows absent.');
  console.log('    Le cas central de ce fichier N A PAS ete verifie sur cette machine.');
}

t('un LIEN DUR reste lisible — borne connue, epinglee en l etat', () => {
  const LIEN_D = path.join(RACINE, 'lien-dur.md');
  let durOk = false;
  try { fs.linkSync(HORS, LIEN_D); durOk = true; } catch { /* systeme de fichiers sans lien dur */ }
  if (!durOk) { console.log('      (lien dur impossible ici — assertion sautee)'); return; }
  const r = lire(LIEN_D);
  assert.ok(!r.error,
    'un lien dur EST un second nom du meme fichier: aucun chemin ne permet de l en distinguer.'
    + ' Si ce cas devient REFUSE, la borne a change et ce commentaire doit changer avec.');
});

t('un chemin INEXISTANT dans la racine est refuse, pas tente', () => {
  /* Un verrou qui ne peut pas verifier ou mene un chemin doit refuser. */
  assert.match(lire(path.join(RACINE, 'pas-la.md')).error || '', /outside the memory roots/);
});

t('le plafond de parcours dit qu il est un plafond', () => {
  /* Un chiffre borne qui ne dit pas sa borne se lit comme un total. */
  const idx = M.callTool('memory_index');
  assert.strictEqual(typeof idx.scanCap, 'number', 'la borne doit etre publiee');
  assert.strictEqual(idx.noteCountIsFloor, false, 'petite racine: le compte est un vrai total');
  assert.ok(idx.noteCount < idx.scanCap);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* le menage ne decide de rien */ }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
