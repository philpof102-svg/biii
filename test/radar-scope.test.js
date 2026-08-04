#!/usr/bin/env node
'use strict';
/**
 * Le garde-fou d'une classe de panne qu'aucun test de comportement n'attrape.
 *
 * token-radar.js a porte pendant des semaines un `lines.push(...)` ecrit DANS une fonction de niveau
 * module, alors que `lines` est declare dans la closure du run. Syntaxiquement valide. `node --check`
 * passe. Tous les runs passent — parce que la ligne vit dans la branche qui ecarte un pool annoncant
 * une grosse liquidite sans volume, et qu'aucun pool pareil n'etait apparu.
 *
 * Le premier qui est apparu a tue le radar entier avec une ReferenceError. Un garde ecrit pour IGNORER
 * proprement un cas a la place fait tomber le cron. Le rayon d'explosion d'une ligne de LOG etait une
 * tache planifiee complete.
 *
 * On ne peut pas provoquer la branche a volonte (elle depend du marche), donc on verifie la propriete
 * STRUCTURELLE dont elle depend : rien n'ecrit dans `lines` avant que `lines` n'existe.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const FILE = path.join(__dirname, '..', 'hermes', 'economy', 'token-radar.js');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split(/\r?\n/);

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

const declIdx = lines.findIndex((l) => /^\s*const lines\s*=\s*\[\]/.test(l));

console.log('token-radar: portee du collecteur de digest');

t('le tableau `lines` est bien declare une seule fois', () => {
  const all = lines.filter((l) => /^\s*const lines\s*=\s*\[\]/.test(l));
  assert.equal(all.length, 1, 'plusieurs declarations rendraient ce test ambigu');
  assert.ok(declIdx > 0, 'declaration introuvable');
});

t('aucun `lines.push` AVANT la declaration — c\'est exactement le crash de 2026-07-26', () => {
  const early = [];
  for (let i = 0; i < declIdx; i++) {
    if (/(^|[^.\w])lines\s*\.\s*push\s*\(/.test(lines[i])) early.push('L' + (i + 1) + ': ' + lines[i].trim().slice(0, 90));
  }
  assert.equal(early.length, 0,
    'ecriture dans `lines` hors de sa portee — ReferenceError garantie des que la branche s\'execute :\n       ' + early.join('\n       '));
});

t('les notes de recolte passent par HARVEST_NOTES, qui EXISTE au niveau module', () => {
  const decl = lines.findIndex((l) => /^\s*const HARVEST_NOTES\s*=\s*\[\]/.test(l));
  assert.ok(decl >= 0, 'HARVEST_NOTES doit etre declare au niveau module');
  assert.ok(decl < declIdx, 'et avant la closure du run, sinon le probleme est simplement deplace');
  assert.ok(/for \(const n of HARVEST_NOTES\) lines\.push\(n\)/.test(src),
    'les notes doivent etre VIDEES dans le digest : un pool ecarte en silence ressemble a un pool qui n\'a jamais existe');
});

/* La regle GENERALE, dont le cas `lines` ci-dessus n'est qu'une instance.
 *
 * Le crash de 2026-07-26 n'etait pas propre a `lines`: c'est un identifiant lu dans une branche RAREMENT
 * PRISE, depuis un bloc ou sa declaration ne vit plus. `node --check` passe, tous les runs passent, et la
 * ReferenceError attend le jour ou la branche s'execute. Les lignes de divulgation ajoutees le 2026-07-29
 * (compteurs d'echec: une trace de financement tombee, une classification B20 tombee) sont exactement de
 * cette forme — elles ne s'executent QUE si un controle echoue.
 *
 * Regle correcte pour un `let`: entre la declaration et l'usage, la profondeur d'accolades ne doit jamais
 * redescendre SOUS celle du bloc declarant. (Comparer les profondeurs seules est faux dans les deux sens:
 * lire une variable externe depuis un bloc plus profond est legal, et deux blocs FRERES a profondeur egale
 * ne partagent rien.) */
/* La detection, extraite pour qu'on puisse la lancer sur AUTRE CHOSE que le fichier reel — sans quoi
 * « aucun defaut trouve » et « detecteur casse » rendent le meme vert. */
function compteursHorsPortee(srcText) {
  /* ⚠️ LES COMMENTAIRES DE BLOC DOIVENT PARTIR AVANT LE COMPTAGE, ET C'ETAIT UN TROU.
   *
   * Ce compteur retirait les commentaires `//` mais laissait les `/* ... *\/`. Or la prose de ce depot
   * est francaise: chaque apostrophe de « l'erreur », « n'etait », « d'une » ouvre une fausse chaine
   * pour la regex ci-dessous, et une accolade citee dans un commentaire compte comme une vraie.
   *
   * Mesure du 2026-08-04: l'ajout d'un commentaire de bloc de huit lignes au-dessus d'un compteur a
   * fait remonter DEUX faux positifs, dont `b20Echec` qui n'avait pas bouge. Le faux positif est
   * demontrable sans ce test: `if (b20Echec)` est evalue a CHAQUE run du radar, et le radar publie ses
   * digests — un identifiant hors portee y jetterait une ReferenceError tous les soirs.
   *
   * Un garde qui accuse le code correct se fait desarmer par le prochain qui le lit. On lui donne donc
   * de quoi lire ce qu'il juge, en gardant le compte de lignes intact pour que les numeros restent
   * ceux du fichier. */
  const brutes = srcText.split(/\r?\n/);
  const sansBlocs = srcText.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split(/\r?\n/);
  const prof = []; let d = 0;
  for (const l of sansBlocs) {
    prof.push(d);
    const nu = l.replace(/'(\\.|[^'\\])*'/g, "''").replace(/"(\\.|[^"\\])*"/g, '""')
                .replace(/`(\\.|[^`\\])*`/g, '``').replace(/\/\/.*$/, '');
    for (const ch of nu) { if (ch === '{') d++; else if (ch === '}') d--; }
  }
  const horsPortee = [];
  let examines = 0;                 // ⚠️ un garde qui n'a RIEN a examiner passe en vert: il faut le dire.
  for (let i = 0; i < brutes.length; i++) {
    const m = brutes[i].match(/^\s*let\s+([\w\s,=0-9]+);\s*(?:\/\/.*)?$/);
    if (!m) continue;
    const noms = m[1].split(',').map((s) => s.split('=')[0].trim()).filter((s) => /^\w+$/.test(s));
    for (const nom of noms) {
      const re = new RegExp('(^|[^.\\w])' + nom + '([^\\w]|$)');
      for (let u = i + 1; u < brutes.length; u++) {
        if (!/lines\.push\(/.test(brutes[u]) || !re.test(brutes[u])) continue;
        examines++;
        let ferme = 0;
        for (let k = i + 1; k <= u; k++) if (prof[k] < prof[i]) { ferme = k + 1; break; }
        if (ferme) horsPortee.push(`${nom}: declare L${i + 1}, lu L${u + 1}, bloc referme L${ferme}`);
      }
    }
  }
  return { horsPortee, examines };
}

t('★ tout compteur `let X = 0` lu dans une ligne publiee vit dans un bloc encore OUVERT', () => {
  const { horsPortee, examines } = compteursHorsPortee(src);
  assert.deepStrictEqual(horsPortee, [],
    'un identifiant publie depuis un bloc ferme = ReferenceError le jour ou la branche s\'execute:\n       '
    + horsPortee.join('\n       '));
  /* Mesure du 2026-07-29: ce garde a affiche « 8 passed » sur une version du radar qui ne contenait
   * AUCUN compteur — il n'avait rien a inspecter et l'a annonce en vert. Un succes vide est une erreur:
   * c'est le motif meme que ce depot chasse, applique a l'instrument qui le chasse. */
  assert.ok(examines >= 3, 'succes VIDE: seulement ' + examines + ' couple(s) declaration/publication inspecte(s). '
    + 'Soit les compteurs de divulgation ont disparu du radar, soit ce garde ne les reconnait plus.');
});

/* Le garde a ete MODIFIE le 2026-08-04 (retrait des commentaires de bloc avant le comptage). Un garde
 * qu'on retouche doit reprouver qu'il mord, sinon « rien trouve » et « detecteur emousse » se
 * ressemblent trop. Deux cas OPPOSES sur des sources synthetiques: le defaut est vu, et le code
 * correct qui lui ressemble ne l'est pas. */
t('★ le garde des compteurs mord encore — defaut injecte vu, cas legitime epargne', () => {
  const casse = [
    'function f() {', '  if (x) {', '    let cpt = 0;', '  }',
    '  lines.push(cpt + " echecs");', '}',
  ].join('\n');
  const r1 = compteursHorsPortee(casse);
  assert.equal(r1.examines, 1, 'le couple declaration/publication doit etre inspecte');
  assert.equal(r1.horsPortee.length, 1, 'un compteur declare dans un bloc REFERME doit etre signale');

  // Le cas legitime, qui ne differe que par la place de l'accolade: meme forme, portee valide.
  const sain = [
    'function f() {', '  let cpt = 0;', '  if (x) { cpt++; }',
    '  lines.push(cpt + " echecs");', '}',
  ].join('\n');
  const r2 = compteursHorsPortee(sain);
  assert.equal(r2.examines, 1, 'meme couple inspecte — sinon la comparaison ne vaut rien');
  assert.deepStrictEqual(r2.horsPortee, [], 'un compteur de portee valide ne doit PAS etre accuse');

  // Et la regression precise du jour: de la prose francaise avec apostrophes et accolades citees,
  // au-dessus d'un compteur sain, ne doit plus le faire accuser.
  const avecProse = [
    'function f() {', '  /* l\'erreur n\'etait pas la: RETOURNE {verdict:\'unknown\'} d\'une lecture */',
    '  let cpt = 0;', '  if (x) { cpt++; }', '  lines.push(cpt + " echecs");', '}',
  ].join('\n');
  assert.deepStrictEqual(compteursHorsPortee(avecProse).horsPortee, [],
    'un commentaire de bloc en francais ne doit pas deplacer la profondeur d\'accolades');
});

t('le test mordrait vraiment — verifie sur le defaut reinjecte', () => {
  // Un test qu'on n'a jamais vu echouer n'a rien demontre. On rejoue le fichier tel qu'il etait.
  const broken = lines.slice();
  broken.splice(Math.max(1, declIdx - 5), 0, "      lines.push('regression volontaire');");
  const brokenDecl = broken.findIndex((l) => /^\s*const lines\s*=\s*\[\]/.test(l));
  let found = 0;
  for (let i = 0; i < brokenDecl; i++) if (/(^|[^.\w])lines\s*\.\s*push\s*\(/.test(broken[i])) found++;
  assert.equal(found, 1, 'le detecteur doit voir un push injecte avant la declaration');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * LE TITRE EST LA LIGNE LA PLUS LUE DU PRODUIT — et le ✓ ne couvrait que la moitié du travail.
 *
 * `UNANSWERED` n'est alimenté que par `getJSON`, donc par la RÉCOLTE. Les appels de JUGEMENT
 * (traceFeeder, classifyB20, vetMeme) portent leur propre HTTP. Avec une récolte parfaite et tout le
 * jugement tombé, `armed` restait vide — parce que rien n'avait pu être escaladé — et le titre sortait :
 *
 *   « ✓ token-radar: 40 fresh base launches judged, none with a fireable rug power. »
 *
 * Mesuré le 2026-07-29 en évaluant l'expression elle-même. C'était le troisième retour de cette forme
 * dans ce fichier, qui documente pourtant sa correction juste au-dessus du ternaire.
 *
 * ⚠️ CE TEST ÉVALUE LA SOURCE, PAS UNE RECOPIE. Une constante recopiée ici dériverait du fichier sans
 * que rien ne le signale, et le test continuerait à passer sur du code qui n'existe plus.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */
t('★ le ✓ du titre se retire quand le JUGEMENT n\'a pas pu regarder, pas seulement la récolte', () => {
  const bloc = (src.match(/const jugementMuet[\s\S]*?fireable rug power\.';/) || [])[0];
  assert.ok(bloc, 'le calcul du titre est introuvable — extraction à réparer avant de conclure quoi que ce soit');
  const titre = (ctx) => new Function('armed', 'UNANSWERED', 'toJudge', 'CHAIN',
    'traceEchec', 'b20Echec', 'symEchec', bloc + ' return head;')(
    ctx.armed, ctx.UNANSWERED, ctx.toJudge, 'base', ctx.traceEchec, ctx.b20Echec, ctx.symEchec);
  const base = { armed: [], UNANSWERED: [], toJudge: new Array(40), traceEchec: 0, b20Echec: 0, symEchec: 0 };

  // BORNE D'ACCEPTATION — sans elle, « toujours avertir » passerait ce test.
  assert.ok(titre(base).startsWith('✓'), 'un run réellement propre doit garder son ✓');

  // BORNE DE REFUS — le jugement muet retire le ✓ et se NOMME.
  const j = titre({ ...base, traceEchec: 20, b20Echec: 3, symEchec: 10 });
  assert.ok(!j.startsWith('✓'), 'jugement tombé: le ✓ est un faux feu vert');
  assert.match(j, /judgement/, 'et le titre doit dire QUELLE couche, sinon il n\'est pas actionnable');

  // La récolte garde son propre libellé: les deux pannes n'appellent pas la même action.
  const r = titre({ ...base, UNANSWERED: [{}, {}] });
  assert.ok(!r.startsWith('✓'));
  assert.match(r, /harvest/);

  // Une alarme réelle reste une alarme, mais son compte devient un PLANCHER si on n'a pas tout vu.
  const a = titre({ ...base, armed: [{}], symEchec: 5 });
  assert.match(a, /^🚩/, 'une prise réelle reste annoncée en premier');
  assert.match(a, /FLOOR/, 'et le compte se déclare incomplet');
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * `dropPct` CONTIENT UNE FRACTION, PAS UN POURCENTAGE — et ce n'est pas un défaut, c'est un piège.
 *
 * Le champ est écrit `t.dropPct = drop` où `drop = 1 - liq/peak`, donc 0,998 pour une pool vidée à
 * 99,8 %. Le seul lecteur interne le formate correctement (`pct = n => Math.round(n*100) + '%'`), donc
 * le rapport publié est juste. Rien à corriger côté code.
 *
 * ⚠️ LE RISQUE EST DANS L'AVENIR, ET IL EST RÉEL : le nom dit « Pct », la valeur dit « fraction ».
 * Quelqu'un — moi le lendemain — lira `dropPct: 0.998`, croira à un bug, et « corrigera » l'écriture en
 * `drop * 100`. À partir de ce moment, `tokens.json` contiendrait des lignes en FRACTIONS (les 448
 * historiques) et des lignes en POURCENTAGES (les nouvelles), dans le même champ, sans rien pour les
 * distinguer. Ce serait strictement pire que le nom trompeur d'aujourd'hui : un nom se lit, des unités
 * mélangées ne se détectent plus.
 *
 * Mesuré le 2026-07-29 : ce nom m'a fait conclure à tort que le radar était cassé — j'ai lu une
 * fraction comme un pourcentage et annoncé une variance nulle qui n'existait pas. Le coût est donc
 * établi, pas hypothétique. D'où une garde sur LES DONNÉES, là où des unités mélangées apparaîtraient.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */
/* ⚠️ CES DEUX GARDES S'ESQUIVAIENT EN SILENCE — et je les ai ecrits ce matin.
 * `if (!fs.existsSync(DB)) return;` rendait « ok » sans avoir rien inspecte, indiscernable d'une passe
 * ayant verifie 785 lignes. Mesure du 2026-07-29 en pointant DB sur un chemin inexistant:
 *
 *   ok   ★ dropPct est une FRACTION partout — aucune ligne en pourcentage
 *   ok   ★ et le seuil de rug reste cohérent avec cette unité       ->  « 9 passed, 0 failed »
 *
 * Or `data/token-radar/` est explicitement DE-IGNORE dans .gitignore: la base est suivie, donc son
 * absence est un checkout casse, pas une condition normale a absorber. Le garde ecrit contre la derive
 * d'un chiffre publie ne doit pas etre le seul endroit du depot ou un succes vide passe. */
const DB = path.join(__dirname, '..', 'data', 'token-radar', 'tokens.json');
const lireBase = () => {
  assert.ok(fs.existsSync(DB), 'base du radar introuvable (' + DB + '). Elle est SUIVIE par git — son '
    + 'absence est un checkout casse, pas « rien a contredire ». Un test qui s\'esquive ici rend « ok ».');
  const rows = Object.values(JSON.parse(fs.readFileSync(DB, 'utf8')));
  assert.ok(rows.length > 0, 'succes VIDE: la base est presente mais ne contient aucune ligne.');
  return rows;
};

t('★ dropPct est une FRACTION partout — aucune ligne en pourcentage', () => {
  const rows = lireBase();
  const vals = rows.map((x) => x && x.dropPct).filter((v) => typeof v === 'number');
  /* Tout `rugged` DOIT porter un dropPct numerique. Sans ce croisement, le champ pourrait disparaitre
   * entierement et le garde resterait vert en n'inspectant plus rien — la panne d'a cote. */
  const rugs = rows.filter((x) => x && x.outcome === 'rugged');
  const rugsSansDrop = rugs.filter((x) => typeof x.dropPct !== 'number');
  assert.equal(rugsSansDrop.length, 0, rugsSansDrop.length + ' ligne(s) `rugged` sans dropPct numerique : '
    + 'le champ que ce garde surveille a disparu de la base, et le garde ne garde plus rien.');
  assert.ok(vals.length > 0, 'succes VIDE: aucune valeur dropPct inspectee sur ' + rows.length + ' ligne(s).');

  const horsBorne = vals.filter((v) => v > 1);
  assert.equal(horsBorne.length, 0,
    horsBorne.length + ' ligne(s) portent un dropPct > 1 : quelqu\'un a converti le champ en pourcentage, '
    + 'et la base mélange désormais deux unités dans le même champ. Exemples: ' + horsBorne.slice(0, 3).join(', '));
});

t('★ et le seuil de rug reste cohérent avec cette unité', () => {
  const vals = lireBase().filter((x) => x && x.outcome === 'rugged' && typeof x.dropPct === 'number');
  assert.ok(vals.length > 0, 'succes VIDE: aucune ligne `rugged` chiffree a confronter au seuil.');
  // RUG_DROP vaut 0.80 dans token-radar.js : aucune ligne marquée `rugged` ne peut être sous ce seuil.
  const sousSeuil = vals.filter((x) => x.dropPct < 0.80);
  assert.equal(sousSeuil.length, 0, sousSeuil.length + ' ligne(s) `rugged` sous le seuil de 0,80');
});
t('le formateur du rapport convertit bien la fraction (sinon « 100% » sortirait « 1% »)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'hermes', 'economy', 'token-radar.js'), 'utf8');
  assert.match(src, /const pct = \(n\) => Math\.round\(n \* 100\)/,
    'si ce formateur cesse de multiplier, chaque rapport publié divisera la chute par 100');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
