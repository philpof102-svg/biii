'use strict';
/**
 * bash-runner — COMMENT ON ADRESSE CE DEPOT DEPUIS `bash`, en un seul endroit.
 * ===========================================================================
 * Ce depot a paye DEUX FOIS le meme defaut, a cinq jours d'ecart, et la deuxieme fois avec le
 * correctif de la premiere deja ecrit a cote:
 *
 *   2026-08-05 -> 08-10  `note-refusal.test.js` rouge cinq jours. `bash` resout vers
 *                        C:\Windows\system32\bash.exe (WSL), qui n'adresse pas `D:\...`. Les cinq cas
 *                        rendaient 127 et la chaine `&&` de `npm test` s'arretait la: 17 fichiers de
 *                        test n'ont JAMAIS tourne pendant ce temps.
 *   2026-08-15           `runner-reachability.test.js`, ecrit CINQ JOURS APRES ce correctif, refait
 *                        exactement la meme chose sans l'appeler: `execFileSync('bash', ['-n', p])`
 *                        avec un `p` Windows. Mesure du 2026-08-14: 127 « No such file or directory »
 *                        sur DEUX scripts qui sont en realite parfaitement valides (verifie: en forme
 *                        `/mnt/d/...` les deux sortent en 0). Le garde publiait
 *                        « script(s) shell invalide(s) » sur des fichiers que bash n'a jamais ouverts,
 *                        et 12 fichiers de test ne tournaient plus derriere.
 *
 * C'est le motif que ce depot traque — une lecture ratee qui rend ce que rend un vrai verdict —
 * installe dans l'instrument, PLUS le motif « le helper correct existe, l'appelant a fort enjeu en
 * ecrit une copie plus faible ». La copie plus faible n'avait meme pas de traduction de chemin: elle
 * ne mesurait donc rien, tout en accusant. Le savoir vit ici desormais; les deux appelants l'importent.
 *
 * ⛔ NE PAS deviner la forme de chemin selon `process.platform`: sur cette machine, Windows peut
 * resoudre `bash` vers WSL (`/mnt/d/...`) OU vers Git Bash (`/d/...`), et rien dans la plateforme ne
 * le dit. On ESSAIE, avec un temoin, et on garde celle qui travaille.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** `D:\a\b` -> `<prefixe>d/a/b`. Sans lettre de lecteur (Linux/CI), ne change que les separateurs. */
const posix = (prefixe) => (p) =>
  p.replace(/^([A-Za-z]):[\\/]/, (_, d) => prefixe + d.toLowerCase() + '/').replace(/\\/g, '/');

/**
 * Les trois formes, dans l'ordre d'essai. `noms` liste les variables d'environnement que l'appelant
 * veut voir traverser jusqu'au script.
 *
 * ⚠️ `env` n'est pas decoratif: WSL n'herite AUCUNE variable Windows sauf celles nommees dans WSLENV.
 * Sans lui, le script part, rend 0, et ecrit ailleurs que la ou Node regarde — le succes est
 * parfaitement imite. On passe des chemins DEJA traduits, donc surtout pas le drapeau `/p`.
 */
function bashFormes(noms = []) {
  const wslenv = (e) => (noms.length
    ? { ...e, WSLENV: (e.WSLENV ? e.WSLENV + ':' : '') + noms.join(':') }
    : e);
  return [
    // Linux/CI: pas de lettre de lecteur, les trois traductions coincident et celle-ci gagne d'abord.
    { nom: 'posix', chemin: (p) => p, env: (e) => e },
    { nom: 'gitbash', chemin: posix('/'), env: (e) => e },
    { nom: 'wsl', chemin: posix('/mnt/'), env: wslenv },
  ];
}

/**
 * Etat d'un controle de syntaxe. TROIS etats, jamais deux — c'est tout l'objet de ce fichier.
 * Statuts mesures le 2026-08-14 (bash 5.x, WSL): valide 0 · erreur de syntaxe 2 · illisible 127.
 * On ne se fie pas au seul chiffre: un stderr qui dit « No such file » est une non-lecture quel que
 * soit le code, et `ENOENT` cote Node veut dire qu'il n'y a pas de bash du tout.
 */
function classer(e) {
  if (!e) return { etat: 'valide' };
  if (e.code === 'ENOENT') return { etat: 'illisible', detail: 'aucun bash executable sur ce systeme' };
  const err = String(e.stderr || e.message || '').trim();
  if (/No such file or directory|cannot open|Permission denied|command not found/i.test(err)) {
    return { etat: 'illisible', detail: err.slice(0, 160) };
  }
  return { etat: 'invalide', detail: err.slice(0, 160) };
}

/** Lance `bash -n` sur un chemin DEJA traduit. Rend { etat, detail? }. */
function syntaxeBrute(arg) {
  try { execFileSync('bash', ['-n', arg], { stdio: 'pipe' }); return { etat: 'valide' }; }
  catch (e) { return classer(e); }
}

/**
 * Choisit la forme de chemin en faisant TRAVAILLER bash, avec un temoin POSITIF et son OPPOSE.
 *
 * Le temoin oppose n'est pas du zele: une forme qui rendrait « valide » sur les deux fixtures ne
 * controle rien — sortie constante, aucune mesure — et signerait ensuite tous les scripts du depot.
 * On exige donc que le script casse ressorte `invalide`. C'est le controle que ce depot impose a
 * chacun de ses gardes de derive, applique ici au portillon lui-meme.
 *
 * Rend { forme, echecs } ; `forme` vaut null si AUCUNE ne travaille — et ce troisieme etat doit
 * remonter jusqu'a l'appelant, jamais etre aplati sur « les scripts vont bien ».
 */
function choisirFormeSyntaxe() {
  const echecs = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-runner-'));
  const bon = path.join(tmp, 'temoin-valide.sh');
  const casse = path.join(tmp, 'temoin-casse.sh');
  fs.writeFileSync(bon, '#!/bin/bash\necho ok\n');
  fs.writeFileSync(casse, '#!/bin/bash\nif [ 1 ; then\n');           // `then` sans `fi`, `[` non ferme
  try {
    for (const f of bashFormes()) {
      const vu = syntaxeBrute(f.chemin(bon));
      if (vu.etat !== 'valide') { echecs.push(f.nom + ': temoin valide rendu ' + vu.etat + ' — ' + (vu.detail || '')); continue; }
      const vuCasse = syntaxeBrute(f.chemin(casse));
      if (vuCasse.etat !== 'invalide') {
        echecs.push(f.nom + ': temoin CASSE rendu ' + vuCasse.etat + ' — sortie constante, ce bash ne controle rien');
        continue;
      }
      return { forme: f, echecs };
    }
    return { forme: null, echecs };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** Controle de syntaxe d'un fichier donne en chemin NATIF, via une forme deja choisie. */
function verifierSyntaxe(forme, fichier) {
  if (!forme) return { etat: 'illisible', detail: 'aucune forme de chemin utilisable pour bash ici' };
  if (!fs.existsSync(fichier)) return { etat: 'illisible', detail: 'fichier absent cote Node: ' + fichier };
  return syntaxeBrute(forme.chemin(fichier));
}

module.exports = { posix, bashFormes, choisirFormeSyntaxe, verifierSyntaxe, syntaxeBrute, classer };
