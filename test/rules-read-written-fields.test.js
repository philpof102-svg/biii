#!/usr/bin/env node
'use strict';
/**
 * UNE REGLE NE PEUT PAS LIRE UN CHAMP QUE LE PRODUCTEUR N'ECRIT JAMAIS
 * ================================================================================================
 * ⛔ CE GATE EXISTE PARCE QU'UN PARI ANNONCE S'ABSTENAIT SUR 100 % DE SA POPULATION, EN SILENCE.
 *
 * Mesure du 2026-08-10 par le vrai scoreur: `natif-b20` rendait 488 abstentions sur 488 eligibles.
 * Cause: sa `predict` lit `t.addr`, et `addr` n'est ECRIT nulle part par `token-radar.js` — l'adresse
 * est la CLE de `tokens.json`, pas une propriete de la valeur. Deux autres regles font pareil
 * (`suffixe-01`, et `verdict-caution-sans-natifs` dont l'exclusion des natifs ne s'applique donc JAMAIS,
 * ce qui le rend identique a `verdict-caution` — 1499/848 des deux cotes).
 *
 * 💀 ET LA PANNE PORTAIT LE MASQUE LE PLUS RASSURANT: la carte affichait `trop-peu`, qui se lit
 * « pas encore assez de donnees ». Un pari MORT deguise en pari JEUNE. Le verdict `inerte` nomme
 * desormais cet etat, mais NOMMER une panne ne l'empeche pas de revenir — d'ou ce gate.
 *
 * ⚠️ SES BORNES, ECRITES ICI PARCE QU'UN GATE QUI NE DIT PAS CE QU'IL IGNORE FINIT PAR RASSURER A TORT:
 *   · l'extraction est TEXTUELLE des deux cotes. Elle voit `t.<champ>` et `db[...].<champ> =`, pas la
 *     destructuration ni un acces dynamique `t[nom]`;
 *   · la liste des champs ECRITS est volontairement PERMISSIVE — la regex ramasse aussi des mots de
 *     commentaire (`champ`, `null`, `most`…). Un gate permissif peut RATER un orphelin dont le nom
 *     traine dans ce bruit; il ne peut pas en INVENTER un. Le sens de l'erreur est donc le bon, et il
 *     est dit plutot que masque;
 *   · elle ne verifie pas qu'un champ ecrit est ecrit SOUVENT — juste qu'il peut exister.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { RULES } = require('../lib/prequential');

let pass = 0, fail = 0;
const encours = [];
async function lancerCas(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}
const t = (name, fn) => { encours.push(lancerCas(name, fn)); };

console.log('une regle ne peut pas lire un champ que le producteur n ecrit jamais');

const PRODUCTEUR = path.join(__dirname, '..', 'hermes', 'economy', 'token-radar.js');
const src = fs.readFileSync(PRODUCTEUR, 'utf8');

/** Les champs que le producteur pose sur une ligne. Permissif par construction — voir les bornes. */
function champsEcrits(source) {
  const s = new Set();
  for (const m of source.matchAll(/db\[[^\]]+\]\.([A-Za-z_$][\w$]*)\s*=/g)) s.add(m[1]);
  for (const m of source.matchAll(/db\[[^\]]+\]\s*=\s*\{([^}]*)\}/g)) {
    for (const p of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) s.add(p[1]);
  }
  return s;
}

/** Les champs qu'une regle lit sur le token juge. */
function champsLus(regle) {
  const s = new Set();
  const source = String(regle.predict) + String(regle.threshold || '');
  for (const m of source.matchAll(/\bt\.([A-Za-z_$][\w$]*)/g)) s.add(m[1]);
  return s;
}

const ecrits = champsEcrits(src);

/* ── 1. LE GATE ───────────────────────────────────────────────────────────────────────────────────── */

t('★ chaque champ lu par une regle est ECRIT quelque part par le producteur', () => {
  /* ⛔ La liste des orphelins CONNUS est nommee: ces trois regles lisent `addr` et le dossier le sait.
   * Les exempter en silence transformerait ce gate en decoration; les nommer le laisse mordre sur tout
   * le reste, et rend leur reparation visible le jour ou elle arrivera (le compte doit tomber a zero). */
  const CONNUS = new Set(['verdict-caution-sans-natifs', 'natif-b20', 'suffixe-01']);
  const nouveaux = [];
  let regles = 0, acces = 0;
  for (const r of RULES) {
    regles++;
    const lus = champsLus(r);
    acces += lus.size;
    for (const c of lus) {
      if (ecrits.has(c)) continue;
      if (CONNUS.has(r.key) && c === 'addr') continue;      // dette nommee, pas silence
      nouveaux.push(r.key + ' lit `t.' + c + '`, que le producteur n ecrit jamais');
    }
  }
  /* ⛔ Un gate qui n'a RIEN examine passe en vert: il compte ce qu'il a inspecte. */
  assert.ok(regles >= 10, 'le gate doit voir les regles: ' + regles);
  assert.ok(acces >= 12, 'et des acces de champ: ' + acces);
  assert.deepStrictEqual(nouveaux, [],
    'une regle qui lit un champ inexistant s abstient POLIMENT ET POUR TOUJOURS:\n       ' + nouveaux.join('\n       '));
});

/* ── 1bis. LE MIROIR: UN CHAMP ECRIT QUE PERSONNE NE LIT ──────────────────────────────────────────
 *
 * Le gate ci-dessus interdit de LIRE un champ jamais ECRIT. Son miroir n'existait pas, et deux cas ont
 * ete trouves PAR HASARD le 2026-08-11 — ce qui est exactement la raison d'ecrire un gate.
 *
 * Mesure du 2026-08-11 sur les 29 champs persistes par `token-radar.js`: **11 n'ont AUCUN lecteur**
 * dans `lib/` ni `bin/`. Ils ne se valent pas, et le melange est le piege:
 *   · SIGNAUX DORMANTS — `relaunchOfRugged` (c'est `relance`, mesure a 7-8 pts par operateur, lu par
 *     TROIS sondes et zero produit), `industrialFunder`, `cleanBand`/`cleanBandUnknown`;
 *   · PANNES ENREGISTREES ET IGNOREES — `funderTraceError` et `symbolCheckError` stockent le message
 *     d'une lecture qui a echoue, et rien dans le produit ne les ouvre;
 *   · 🚨 `firstReason` — ecrit DEUX fois (a la creation, puis REECRIT ligne ~720 avec une phrase
 *     construite sur le financeur) et lu par PERSONNE, ni produit ni sonde. Or `firstVerdict` EST lu
 *     par le produit: **le verdict voyage sans son pourquoi**, et la raison d'origine est ecrasee.
 *
 * ⚠️ BORNES, dans le meme sens d'erreur que le gate ci-dessus: la recherche de lecteurs est TEXTUELLE
 * et par NOM. Des noms courants (`funder`, `outcome`, `deployer`) matchent du code sans rapport, donc
 * ce gate peut RATER un orphelin; il ne peut pas en INVENTER un. Il ne verifie pas non plus qu'un
 * lecteur trouve UTILISE la valeur pour decider.
 * ⛔ Il ne dit RIEN de ce qu'il faut faire d'un orphelin — consommer un signal ou retirer un champ est
 * une decision produit. Il refuse seulement que la liste GRANDISSE en silence. */
t('★ MIROIR: aucun NOUVEAU champ persiste ne reste sans lecteur produit', () => {
  /* ⛔ LA DETTE EST NOMMEE, pas exemptee en silence — meme discipline que `CONNUS` ci-dessus.
   * Le jour ou l'un d'eux est consomme ou retire, ce test rougit et la liste doit maigrir. */
  const ORPHELINS_CONNUS = new Set([
    'cleanBandUnknown', 'firstReason', 'funderTraceError', 'identicalAmountEth', 'identityWarning',
    'industrialFunder', 'liqMissStreak', 'rejudgedAt', 'relaunchOfRugged', 'symbolCheck', 'symbolCheckError',
    /* ⚠️ Trouve PAR CE GATE, pas par le sweep manuel qui l'avait rate: mon grep ne lisait que les
     * ecritures `db[...].X =`, et celui-ci est pose dans l'OBJET LITTERAL de creation. L'extracteur
     * partage lit les deux — c'est exactement pourquoi un gate vaut mieux qu'un comptage a la main.
     * 🚨 Et il complete un motif: `armedAtFirstSight` (2 lecteurs) et `basisAtFirstSight` (2 lecteurs)
     * SONT lus, mais les DRAPEAUX du verdict ne le sont pas — comme `firstReason`. On garde le verdict
     * et sa base, on jette ce qui explique POURQUOI il a ete rendu. */
    'flagsAtFirstSight',
  ]);
  /* `champ` n'est pas un champ: il vient d'un COMMENTAIRE du producteur (`db[c.addr].champ =`) que
   * l'extracteur permissif ramasse. Nomme ici plutot que filtre en douce. */
  const BRUIT = new Set(['champ']);

  const lireDossier = (rel) => {
    const dir = path.join(__dirname, '..', rel);
    let out = '';
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      out += fs.readFileSync(path.join(dir, f), 'utf8');
    }
    return out;
  };
  const produit = lireDossier('lib') + lireDossier('bin');
  assert.ok(produit.length > 50000, 'le gate doit avoir lu le produit: ' + produit.length + ' octets');

  const persistes = [...champsEcrits(src)].filter((c) => !BRUIT.has(c));
  assert.ok(persistes.length >= 20, 'le gate doit voir les champs persistes: ' + persistes.length);

  const orphelins = persistes.filter((c) => !new RegExp('\\b' + c + '\\b').test(produit));
  const nouveaux = orphelins.filter((c) => !ORPHELINS_CONNUS.has(c));
  assert.deepStrictEqual(nouveaux, [],
    'champ(s) persiste(s) que RIEN dans lib/ ni bin/ ne lit — signal dormant ou poids mort, mais jamais\n'
    + '       par accident. Consommer ou retirer est une decision produit; ce gate refuse seulement le silence:\n       '
    + nouveaux.join('\n       '));
});

t('★ TEMOIN du miroir: le gate MORD — il retrouve les orphelins connus', () => {
  /* ⛔ Sans ce cas, une recherche qui trouverait TOUT (ou un `produit` vide) rendrait zero orphelin et
   * le cas ci-dessus passerait au vert sur un instrument mort. */
  const lireDossier = (rel) => {
    const dir = path.join(__dirname, '..', rel);
    let out = '';
    for (const f of fs.readdirSync(dir)) { if (f.endsWith('.js')) out += fs.readFileSync(path.join(dir, f), 'utf8'); }
    return out;
  };
  const produit = lireDossier('lib') + lireDossier('bin');
  /* `firstReason` est le cas le plus net: ecrit deux fois par le producteur, lu nulle part. */
  assert.ok(!new RegExp('\\bfirstReason\\b').test(produit),
    'si `firstReason` est desormais lu par le produit, RETIRER-le de ORPHELINS_CONNUS');
  /* ...et le temoin OPPOSE: un champ dont on SAIT qu'il est lu doit etre trouve, sinon la recherche ment. */
  assert.ok(new RegExp('\\bsiblingCount\\b').test(produit),
    'temoin: `siblingCount` EST lu par le produit — si ce cas casse, la recherche est cassee');
});

/* ── 2. LE TEMOIN — sans lui, un extracteur qui rend TOUJOURS vide passerait le cas ci-dessus ──────── */

t('★ TEMOIN: le gate MORD vraiment — il retrouve les trois orphelins connus', () => {
  const CONNUS = ['verdict-caution-sans-natifs', 'natif-b20', 'suffixe-01'];
  const attrapes = CONNUS.filter((k) => {
    const r = RULES.find((x) => x.key === k);
    return r && [...champsLus(r)].some((c) => !ecrits.has(c));
  });
  assert.deepStrictEqual(attrapes.sort(), CONNUS.slice().sort(),
    'si le gate ne retrouve plus ces trois-la, soit elles sont REPAREES (retirer la dette ci-dessus), '
    + 'soit l extracteur est casse — les deux demandent un regard, pas un vert silencieux');
});

t('★ les DEUX extracteurs trouvent quelque chose — un vide passerait tout', () => {
  assert.ok(ecrits.size >= 20, 'champs ECRITS trouves: ' + ecrits.size);
  assert.ok(ecrits.has('siblingCount') && ecrits.has('firstVerdict'),
    'et il doit trouver des champs qu on SAIT ecrits: ' + [...ecrits].slice(0, 8).join(','));
  assert.strictEqual(ecrits.has('addr'), false, '`addr` ne doit PAS apparaitre — c est la CLE, pas un champ');
  const total = RULES.reduce((n, r) => n + champsLus(r).size, 0);
  assert.ok(total >= 12, 'champs LUS trouves: ' + total);
});

/* 3 cas d'origine + 2 pour le MIROIR (le gate des champs persistes sans lecteur, et son temoin). */
const ATTENDUS = 5;
Promise.all(encours).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (pass + fail !== ATTENDUS) {
    console.log('  FAIL harnais: ' + (pass + fail) + ' cas comptes, ' + ATTENDUS + ' attendus');
    process.exitCode = 1;
  }
  if (fail) process.exitCode = 1;
});
