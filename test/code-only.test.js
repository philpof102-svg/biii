#!/usr/bin/env node
'use strict';
/**
 * Un neutraliseur de commentaires se juge sur DEUX questions opposees, jamais une seule.
 *
 * Efface-t-il ce qu'il doit effacer ? Et laisse-t-il intact ce qu'il ne doit pas toucher ? Un test qui
 * ne pose que la premiere passerait sur une fonction qui rend une page blanche — et c'est exactement
 * l'accident du 2026-08-05, ou un blanchiment trop large a fait tomber sept assertions valides.
 *
 * ⚠️ AUCUNE CHAINE PIEGEE N'EST ECRITE EN LITTERAL ICI. Les backslashes et apostrophes de test sont
 * construits par `String.fromCharCode`, parce qu'un heredoc ou un `node -e` mange les backslashes en
 * silence: le 2026-08-06 un faux echec de ce meme automate venait du harnais, pas de l'automate.
 */
const assert = require('node:assert');
const { codeOnly } = require('../lib/code-only');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const BS = String.fromCharCode(92);    // un backslash
const AP = String.fromCharCode(39);    // une apostrophe
const TEMOIN = 'const GARDE = 42;';

console.log('code-only: neutraliser sans detruire');

t('★ la longueur et les sauts de ligne sont CONSERVES — sinon tout indexOf ment', () => {
  const src = 'const a = 1;\n/* bloc\n   sur deux lignes */\nconst b = "texte";\n';
  const out = codeOnly(src);
  assert.strictEqual(out.length, src.length, 'la longueur doit etre identique');
  assert.strictEqual(out.split('\n').length, src.split('\n').length, 'le compte de lignes doit etre identique');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') assert.strictEqual(out[i], '\n', 'saut de ligne deplace en position ' + i);
  }
});

t('★ un bloc FERME a l interieur d une chaine ne fait pas deraper la lecture', () => {
  // C'est l'accident exact du 2026-08-05: la regex non-greedy demarrait au mauvais endroit.
  const src = 'const s = "fin de bloc */ piege"; ' + TEMOIN;
  const out = codeOnly(src);
  assert.ok(out.includes(TEMOIN), 'le code apres la chaine piegee doit survivre');
  assert.ok(!out.includes('piege'), 'le contenu de la chaine doit disparaitre');
});

t('★ une apostrophe ECHAPPEE ne termine pas la chaine', () => {
  const src = 'const s = ' + AP + 'l' + BS + AP + 'un' + AP + '; ' + TEMOIN;
  const out = codeOnly(src);
  assert.strictEqual(out.length, src.length);
  assert.ok(out.includes(TEMOIN), 'le code apres la chaine echappee doit survivre');
  assert.ok(!out.includes('un' + AP), 'la chaine entiere doit disparaitre, pas la moitie');
});

t('un litteral regex contenant des slashes ne coupe pas le fichier en deux', () => {
  const src = 'if (/a' + BS + '/' + BS + '/b/.test(x)) { ' + TEMOIN + ' }';
  const out = codeOnly(src);
  assert.ok(out.includes(TEMOIN), 'le corps du if doit survivre a la regex');
});

t('★ le cas OPPOSE: une DIVISION n est pas prise pour une regex', () => {
  const src = 'const r = a / b; ' + TEMOIN;
  const out = codeOnly(src);
  assert.ok(out.includes('a / b'), 'une division doit rester lisible, sinon tout ratio disparait du scan');
  assert.ok(out.includes(TEMOIN));
});

t('★ ce qui DOIT disparaitre disparait — sinon le neutraliseur ne sert a rien', () => {
  const bloc = codeOnly('/* const FANTOME = 1; */ ' + TEMOIN);
  assert.ok(!bloc.includes('FANTOME'), 'un commentaire de bloc doit etre efface');
  assert.ok(bloc.includes(TEMOIN), 'et seulement lui');

  const ligne = codeOnly(TEMOIN + ' // const FANTOME = 1;');
  assert.ok(!ligne.includes('FANTOME'), 'un commentaire de ligne doit etre efface');
  assert.ok(ligne.includes(TEMOIN));

  const chaine = codeOnly('const s = "const FANTOME = 1;"; ' + TEMOIN);
  assert.ok(!chaine.includes('FANTOME'), 'le contenu d une chaine ne doit pas etre lu comme du code');
  assert.ok(chaine.includes(TEMOIN));
});

t('un gabarit multi-lignes est neutralise sans perdre ses sauts de ligne', () => {
  const BQ = String.fromCharCode(96);
  const src = 'const s = ' + BQ + 'a\nFANTOME\nb' + BQ + ';\n' + TEMOIN;
  const out = codeOnly(src);
  assert.strictEqual(out.length, src.length);
  assert.ok(!out.includes('FANTOME'), 'le contenu du gabarit doit disparaitre');
  assert.strictEqual(out.split('\n').length, src.split('\n').length, 'ses sauts de ligne doivent rester');
  assert.ok(out.includes(TEMOIN));
});

t('une entree vide ne casse rien et ne rend rien', () => {
  assert.strictEqual(codeOnly(''), '');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
