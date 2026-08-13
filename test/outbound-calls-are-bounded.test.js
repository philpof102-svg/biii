'use strict';
/**
 * outbound-calls-are-bounded — tout appel sortant NATIF doit pouvoir abandonner.
 * ================================================================================================
 * ⛔ CE QUE CE FICHIER EMPECHE DE REVENIR. Le 2026-08-13, NEUF appels sortants de `lib/` n'avaient
 * aucune echeance. `req.on('error')` couvre une connexion refusee ou rompue; il ne couvre PAS un hote
 * qui ACCEPTE et se tait. Et ces promesses ne font que `resolve` — ce cas les laissait PENDANTES POUR
 * TOUJOURS. `b20.js:rpc()` lit l'etat de chaine pour juger un token et `rugsignals` alimente un
 * verdict de rug: un appel qui ne revient jamais n'est pas une reponse prudente, c'est AUCUNE reponse.
 *
 * ⚠️ MESURE, pas doctrine (temoin du 13/08 sur un serveur local qui accepte et ne repond jamais,
 * 700 ms demandes):
 *     `timeout` pose, AUCUN handler ......... encore pendant a 2501 ms
 *     `timeout` + on('timeout') qui DETRUIT .. abandonne a  712 ms
 *     `timeout` + handler SANS destroy() ..... encore pendant a 2519 ms
 * ⇒ L'option seule ne coupe RIEN, et ECOUTER ne suffit pas. C'est pourquoi ce gate exige un handler
 * qui DETRUIT, et pas seulement la presence de l'option.
 *
 * 💎 POURQUOI IL COMPTE AU LIEU DE REPONDRE OUI/NON PAR FICHIER. Un critere « ce fichier a-t-il un
 * timeout et un handler ? » repond OUI sur un fichier qui fait DEUX requetes et n'en garde qu'UNE.
 * C'est arrive: `agent-vet.js` a servi de MODELE canonique toute la nuit, et son second appel
 * (`https.get` vers Blockscout, :368) n'etait pas borne. Seul le comptage l'a vu.
 *
 * PORTEE ET BORNES, ecrites ici parce qu'elles voyagent avec le verdict:
 *  - Pas d'AST. Le rapprochement appels <-> handlers est par FICHIER, pas par site d'appel: deux
 *    requetes et deux handlers passent meme si les handlers gardent la meme requete. Ce gate reduit
 *    la classe, il ne la ferme pas.
 *  - `axios` et `fetch` + `AbortSignal.timeout` abandonnent VRAIMENT (mesure: 709 ms) — hors sujet ici.
 *  - Un transport ALIASE compte (`transport.request`), sinon le code qui choisit son client
 *    dynamiquement — le mieux ecrit — serait le seul invisible.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n      ' + (e && e.message)); } };

/* Commentaires retires AVANT de compter: ce fichier-ci cite `on('timeout', ... destroy())` dans sa
 * propre prose, et les fichiers lus en citent aussi. Une gate qui analyse du texte doit separer le
 * code de la prose — sinon elle se nourrit de ses propres explications. Verifie: une verification a la
 * main comptait 5 handlers pour 4 requetes le 13/08, la cinquieme etant un commentaire. */
const codeSeul = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const RACINE = path.join(__dirname, '..');
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'vendor', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const fichiers = walk(path.join(RACINE, 'lib')).concat(walk(path.join(RACINE, 'bin')));
const releve = [];
for (const f of fichiers) {
  const src = codeSeul(fs.readFileSync(f, 'utf8'));
  if (!/require\((['"])(node:)?https?\1\)/.test(src)) continue;
  const appels = (src.match(/\b(https?|transport)\.(request|get)\s*\(/g) || []).length;
  if (!appels) continue;
  const handlers = (src.replace(/\s+/g, ' ').match(/on\((['"])timeout\1[^;]{0,120}?destroy/g) || []).length;
  releve.push({ fichier: path.relative(RACINE, f).replace(/\\/g, '/'), appels, handlers });
}

const totalAppels = releve.reduce((s, r) => s + r.appels, 0);
const totalHandlers = releve.reduce((s, r) => s + r.handlers, 0);

console.log('BIII — tout appel sortant natif peut-il abandonner ?');
for (const r of releve) console.log('  ' + String(r.appels) + ' appel(s), ' + String(r.handlers) + ' handler(s)  ' + r.fichier);
console.log('  TOTAL : ' + totalAppels + ' appels, ' + totalHandlers + ' handlers destructeurs');

/* ⚖️ CONTRE-BORNE. Sans elle, ce gate passerait VERT sur un depot d'ou tous les clients natifs
 * auraient disparu — ou sur une regex cassee qui n'en trouve plus aucun. Un gate qui ne peut pas
 * distinguer « tout est borne » de « je ne vois rien » n'observe pas, il affirme. */
t('le releve trouve la population attendue — sinon ce test ne dit RIEN', () => {
  assert.ok(totalAppels >= 8,
    'seulement ' + totalAppels + ' appel(s) natif(s) trouve(s) (>= 8 attendus). Soit les clients ont '
    + 'disparu, soit la detection est cassee: dans les deux cas le verdict ci-dessous est sans valeur.');
  assert.ok(releve.length >= 5, 'seulement ' + releve.length + ' fichier(s) concerne(s)');
});

t('CHAQUE fichier a au moins autant de handlers destructeurs que d appels natifs', () => {
  const manque = releve.filter((r) => r.handlers < r.appels);
  assert.deepStrictEqual(manque.map((r) => r.fichier + ' (' + r.appels + ' appels, ' + r.handlers + ' handlers)'), [],
    'appel(s) sortant(s) sans moyen d abandonner. `timeout` seul ne coupe rien et ecouter ne suffit '
    + 'pas — il faut on(\'timeout\', () => req.destroy()). Voir lib/agent-vet.js:158 pour la forme, et '
    + 'garder le contrat d echec du site (resolve(null) ou reject), jamais celui du voisin.');
});

t('aucun fichier ne pose un timeout SANS handler destructeur — l option seule est decorative', () => {
  const decoratifs = [];
  for (const f of fichiers) {
    const src = codeSeul(fs.readFileSync(f, 'utf8'));
    if (!/\b(https?|transport)\.(request|get)\s*\(/.test(src)) continue;
    const aOption = /timeout\s*:/.test(src) || /[{,]\s*timeout\s*[},]/.test(src);
    const detruit = /on\((['"])timeout\1[^;]{0,120}?destroy/.test(src.replace(/\s+/g, ' '));
    if (aOption && !detruit) decoratifs.push(path.relative(RACINE, f).replace(/\\/g, '/'));
  }
  assert.deepStrictEqual(decoratifs, [],
    'timeout pose sans handler qui detruit — mesure: 2519 ms sur 700 demandes, la requete pend quand meme.');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
