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
t('★ tout compteur `let X = 0` lu dans une ligne publiee vit dans un bloc encore OUVERT', () => {
  const prof = []; let d = 0;
  for (const l of lines) {
    prof.push(d);
    const nu = l.replace(/'(\\.|[^'\\])*'/g, "''").replace(/"(\\.|[^"\\])*"/g, '""')
                .replace(/`(\\.|[^`\\])*`/g, '``').replace(/\/\/.*$/, '');
    for (const ch of nu) { if (ch === '{') d++; else if (ch === '}') d--; }
  }
  const horsPortee = [];
  let examines = 0;                 // ⚠️ un garde qui n'a RIEN a examiner passe en vert: il faut le dire.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*let\s+([\w\s,=0-9]+);\s*(?:\/\/.*)?$/);
    if (!m) continue;
    const noms = m[1].split(',').map((s) => s.split('=')[0].trim()).filter((s) => /^\w+$/.test(s));
    for (const nom of noms) {
      const re = new RegExp('(^|[^.\\w])' + nom + '([^\\w]|$)');
      for (let u = i + 1; u < lines.length; u++) {
        if (!/lines\.push\(/.test(lines[u]) || !re.test(lines[u])) continue;
        examines++;
        let ferme = 0;
        for (let k = i + 1; k <= u; k++) if (prof[k] < prof[i]) { ferme = k + 1; break; }
        if (ferme) horsPortee.push(`${nom}: declare L${i + 1}, lu L${u + 1}, bloc referme L${ferme}`);
      }
    }
  }
  assert.deepStrictEqual(horsPortee, [],
    'un identifiant publie depuis un bloc ferme = ReferenceError le jour ou la branche s\'execute:\n       '
    + horsPortee.join('\n       '));
  /* Mesure du 2026-07-29: ce garde a affiche « 8 passed » sur une version du radar qui ne contenait
   * AUCUN compteur — il n'avait rien a inspecter et l'a annonce en vert. Un succes vide est une erreur:
   * c'est le motif meme que ce depot chasse, applique a l'instrument qui le chasse. */
  assert.ok(examines >= 3, 'succes VIDE: seulement ' + examines + ' couple(s) declaration/publication inspecte(s). '
    + 'Soit les compteurs de divulgation ont disparu du radar, soit ce garde ne les reconnait plus.');
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
const DB = path.join(__dirname, '..', 'data', 'token-radar', 'tokens.json');
t('★ dropPct est une FRACTION partout — aucune ligne en pourcentage', () => {
  if (!fs.existsSync(DB)) return;                    // pas de base locale: rien à contredire
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const vals = Object.values(db).map((x) => x && x.dropPct).filter((v) => typeof v === 'number');
  if (!vals.length) return;                          // aucun rug enregistré encore
  const horsBorne = vals.filter((v) => v > 1);
  assert.equal(horsBorne.length, 0,
    horsBorne.length + ' ligne(s) portent un dropPct > 1 : quelqu\'un a converti le champ en pourcentage, '
    + 'et la base mélange désormais deux unités dans le même champ. Exemples: ' + horsBorne.slice(0, 3).join(', '));
});
t('★ et le seuil de rug reste cohérent avec cette unité', () => {
  if (!fs.existsSync(DB)) return;
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const vals = Object.values(db).filter((x) => x && x.outcome === 'rugged' && typeof x.dropPct === 'number');
  if (!vals.length) return;
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
