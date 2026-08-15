'use strict';
/**
 * CHAQUE VERDICT QUE LE SERVEUR SAIT RENDRE A UNE REGLE DANS LA PAGE QUI L'AFFICHE.
 * Run: node test/every-meme-status-is-dressed.test.js
 *
 * ⚠️ CE QUI A ETE TROUVE (2026-08-15, premiere lecture de web/vet-meme.html).
 * `lib/meme.js` rend SIX statuts. Le CSS de la page en habillait CINQ. Le manquant:
 *
 *     not_a_candidate — « this address does not carry the symbol "X" in the market data we read — it
 *                        is NOT alleged to be a look-alike, we simply never saw it under this symbol.
 *                        Check the address and the chain before concluding anything. »
 *
 * C'est un verdict de PRUDENCE, ecrit expres pour ne pas accuser un tiers sur une absence de donnee
 * (le commentaire de lib/meme.js le dit: « nommer un tiers sur une absence est exactement ce que ce
 * depot refuse partout ailleurs »). La page faisait `var cls = status;` — le statut partait CRU comme
 * nom de classe. Sans regle CSS: ni fond, ni bordure, ni couleur de titre. Le SEUL des six sans
 * traitement visuel, donc a l'ecran le MOINS alarmant des six — alors qu'il veut dire « verifiez ».
 * 💎 Un verdict sans sa branche ne tombe meme pas sur un `else`: il n'y en avait pas.
 *
 * 🔬 RECENSEMENT CALCULE, PAS RECOPIE. La liste des statuts est extraite de `lib/meme.js` a chaque
 * execution. Une liste ecrite en dur ici vieillirait exactement comme le CSS qu'elle surveille — et
 * aurait l'air saine, puisque tout ce qu'elle connait passerait. Un septieme statut ajoute demain
 * rougit ce test sans que personne n'y pense.
 *
 * ⚖️ BORNE: ce fichier lit le CSS et la logique de classe de la page. Il prouve qu'une REGLE existe et
 * que la classe choisie est connue — il ne lance aucun navigateur et ne juge pas le RENDU (contraste,
 * lisibilite). Aucun reseau.
 *
 * ✅ RESULTATS CORRECTS DE LA MEME LECTURE, gardes comme temoins ailleurs: `web/radar.html` a deja sa
 * liste blanche ET un repli borne + echappe; `web/embed.js` teste `floor.available !== true` et retombe
 * explicitement sur `unknown` (« never a false genuine »), et refuse les non-adresses avant d'appeler.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n         ' + (e && e.message)); } };

console.log('vet-meme — chaque statut rendu par le serveur a sa regle:');

const RACINE = path.join(__dirname, '..');
const MEME = fs.readFileSync(path.join(RACINE, 'lib', 'meme.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(RACINE, 'web', 'vet-meme.html'), 'utf8');

/* ⚠️ On BLANCHIT les commentaires avant d'extraire. `lib/meme.js` cite ses propres statuts en prose;
 * les compter reviendrait a se recenser soi-meme. On ne veut que les `status: '...'` du CODE. */
const sansCommentaires = MEME.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const STATUTS = [...new Set((sansCommentaires.match(/status:\s*'([a-z_]+)'/g) || [])
  .map((s) => s.replace(/^status:\s*'/, '').replace(/'$/, '')))].sort();

t('★ VALIDATION DE L INSTRUMENT — l extraction trouve bien les statuts, et pas n importe quoi', () => {
  assert.ok(STATUTS.length >= 5, 'succes vide: aucun statut extrait de lib/meme.js (' + STATUTS.length + ')');
  for (const attendu of ['genuine', 'impersonation', 'not_a_candidate']) {
    assert.ok(STATUTS.includes(attendu), 'l extraction manque ' + attendu + ' — elle ne mesure pas ce qu on croit');
  }
  assert.ok(!STATUTS.includes('X'), 'l extraction ramasse de la prose');
  console.log('         statuts rendus par lib/meme.js : ' + STATUTS.join(', '));
});

/* 🔬 CE RECENSEMENT A ETE FAUX AU PREMIER JET, ET LA MUTATION L'A MONTRE.
 * Il cherchait `.verdict.<statut>` N'IMPORTE OU dans la page. En retirant le statut de la regle de
 * FOND, le test restait VERT — parce que le nom survivait dans le selecteur de TITRE juste en dessous
 * (`.verdict.X .verdict-title`). Un statut aurait donc pu avoir une couleur de titre sans fond ni
 * bordure, et le recensement aurait dit « habille ». On exige desormais un selecteur EXACTEMENT
 * `.verdict.<statut>` — pas un descendant — dans une regle qui pose reellement un `background`. */
const style = (PAGE.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
const REGLES = style.replace(/\/\*[\s\S]*?\*\//g, ' ').split('}').map((bloc) => {
  const i = bloc.indexOf('{');
  return i < 0 ? null : { sel: bloc.slice(0, i).split(',').map((s) => s.trim()), decl: bloc.slice(i + 1) };
}).filter(Boolean);
const habille = (statut) => REGLES.some((r) => r.sel.includes('.verdict.' + statut) && /background\s*:/.test(r.decl));

t('★ VALIDATION DE L INSTRUMENT — le recensement CSS sait dire oui ET non', () => {
  assert.ok(REGLES.length > 10, 'succes vide: le <style> n a pas ete decoupe (' + REGLES.length + ' regles)');
  assert.equal(habille('genuine'), true, 'temoin positif: genuine a bien un fond');
  assert.equal(habille('statut_qui_n_existe_pas'), false, 'temoin negatif: sinon ce recensement dit toujours oui');
  // le cas exact qui l'avait berne: un nom present UNIQUEMENT dans un selecteur de titre ne compte pas.
  assert.ok(/\.verdict\.\w+ \.verdict-title/.test(style), 'la page a bien des regles de titre, celles qui l avaient trompe');
});

t('★ LE DEFAUT — chaque statut a une regle de FOND dans la page qui l affiche', () => {
  const manquants = STATUTS.filter((s) => !habille(s));
  assert.deepEqual(manquants, [],
    'statut(s) rendu(s) par le serveur et sans traitement visuel dans web/vet-meme.html: ' + manquants.join(', ')
    + ' — un verdict sans style ressort comme le moins alarmant de tous');
});

t('★ la page NE fabrique PAS un nom de classe a partir du statut brut', () => {
  assert.ok(!/var cls = status;/.test(PAGE),
    'cls = status: un statut inattendu devient un nom de classe arbitraire, sans style et sans repli');
  assert.ok(/CONNUS\.indexOf\(status\)/.test(PAGE), 'la page doit passer par une liste blanche');
});

/* On evalue la LOGIQUE DE CLASSE de la page telle qu'elle est ecrite, reperee par marqueur. Extraire
 * le fragment plutot que le reecrire ici: une copie dans le test prouverait la copie, pas la page. */
const frag = (PAGE.match(/var CONNUS = \[[\s\S]*?var cls = [^\n]*\n/) || [])[0];
const classePour = (statutServeur) => {
  const v = { status: statutServeur };
  // eslint-disable-next-line no-new-func
  return new Function('v', frag + '; return cls;')(v);
};

t('★ le fragment de decision de la page est bien extrait', () => {
  assert.ok(frag && frag.length > 60, 'succes vide: la logique de classe n a pas ete lue');
  assert.equal(classePour('genuine'), 'genuine', 'temoin: un statut connu garde sa classe');
});

t('★ TEMOIN — les six statuts du serveur gardent CHACUN leur propre classe', () => {
  for (const s of STATUTS) {
    assert.equal(classePour(s), s, s + ' doit garder sa classe: les replier tous sur unknown effacerait le verdict');
  }
});

t('★ un statut INCONNU se replie sur unknown, jamais sur un nom de classe libre', () => {
  for (const inattendu of ['septieme_statut', 'GENUINE', 'genuine ', '', 'constructor', 'toString']) {
    assert.equal(classePour(inattendu), 'unknown',
      JSON.stringify(inattendu) + ' doit se replier sur unknown');
  }
});

t('★ et le repli tient meme sur un statut ABSENT ou non textuel', () => {
  for (const bizarre of [undefined, null, 0, 5, {}, []]) {
    const c = classePour(bizarre);
    assert.ok(new RegExp('\\.verdict\\.' + c + '\\b').test(PAGE),
      JSON.stringify(bizarre) + ' rend la classe « ' + c + ' », qui n a pas de regle');
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
