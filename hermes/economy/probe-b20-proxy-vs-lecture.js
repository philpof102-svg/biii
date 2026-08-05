#!/usr/bin/env node
// probe-b20-proxy-vs-lecture.js — la regle annoncee note un PROXY; la LECTURE existe maintenant.
// ================================================================================================
// `natif-b20`, gelee dans lib/announced-rules.js, est notee vers l'avant depuis le 2026-08-05T00:00Z.
// Son predicat (lib/prequential.js) ne lit PAS le code on-chain: il rejoue par le prefixe d'adresse
// `0xb200`, faute d'avoir eu le champ en base pour l'historique. Le commentaire le dit et c'etait
// honnete a l'ecriture.
//
// ⛔ MAIS LE PREFIXE EST EXACTEMENT CE QUE LE DIG B20 A DEMONTE. Le marqueur natif est le CODE
// `0xef` — infalsifiable par EIP-3541 — et l'usurpation par prefixe (`0xb200` + precompile a ~0
// octet de bytecode) est un cas documente de ce depot. Un prefixe est un NOM, un code est une PREUVE.
//
// Depuis le 2026-08-05 le radar enregistre `b20Check` et `b20Kind`. La lecture reelle existe donc
// pour les tokens recents, et la question se tranche au lieu de se supposer:
//   · le proxy et la lecture disent-ils la meme chose ?
//   · combien de tokens portent `b20Check: 'unread'` — c'est-a-dire l'etat sur lequel la regle
//     annoncee ne peut PAS s'abstenir, puisqu'elle n'a pas de branche ABSTAIN pour lui ?
//
// ⛔ AUCUNE REGLE ANNONCEE N'EST MODIFIEE ICI. Une entree gelee se note, elle ne se corrige pas —
// sinon la note vers l'avant ne prouve plus rien. Cet instrument MESURE, il ne repare pas.
//
// Lecture SEULE.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maturityWindow, outcomeKnownAt } = require('../../lib/prequential');
const { ANNOUNCED } = require('../../lib/announced-rules');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const rows = Object.entries(JSON.parse(fs.readFileSync(DB, 'utf8'))).map(([addr, v]) => ({ addr, ...v }));

const FRONTIERE = Date.parse((ANNOUNCED.find((a) => a.key === 'natif-b20') || {}).announcedAt || 0);
const MAINTENANT = Date.parse(process.argv[2] || new Date().toISOString());
const { maturityH } = maturityWindow(rows);

/* Le predicat de la regle GELEE, recopie tel quel — pas importe: on veut comparer ce qu'elle DIT,
 * et une importation masquerait une divergence entre ce qu'on croit et ce qui tourne. */
const EXCEPTION = '0xb200fb5839afa4d7761981143617c5799f063b7f';
const proxyDit = (a) => (!a ? 'abstain' : (!a.startsWith('0xb200') ? 'safe' : (a === EXCEPTION ? 'safe' : 'danger')));

const apres = rows.filter((t) => Number.isFinite(Date.parse(t.firstSeen)) && Date.parse(t.firstSeen) >= FRONTIERE);
console.log(`\n  frontiere de l annonce : ${new Date(FRONTIERE).toISOString()}`);
console.log(`  tokens apparus APRES   : ${apres.length}  (sur ${rows.length} en base)\n`);

if (!apres.length) {
  console.log('  ⛔ AUCUN token posterieur a la frontiere. Ce rapport ne dit RIEN sur la regle —');
  console.log('     ce n est pas « le proxy est bon », c est « rien n a encore ete note ».\n');
  process.exit(0);
}

/* ── 1. la lecture reelle est-elle seulement PRESENTE ? ─────────────────────────────────────── */
const etats = new Map();
for (const t of apres) {
  const e = t.b20Check == null ? '(champ absent)' : String(t.b20Check);
  etats.set(e, (etats.get(e) || 0) + 1);
}
console.log('  etat de la LECTURE reelle (b20Check) sur ces tokens :');
for (const [e, n] of [...etats.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${e.padEnd(18)} ${String(n).padStart(4)}`);
}

/* ── 2. proxy contre lecture, la ou les deux existent ───────────────────────────────────────── */
console.log('\n  proxy (prefixe 0xb200) contre lecture (code on-chain) :\n');
console.log('    proxy      lecture            n   verdict');
console.log('    ' + '-'.repeat(62));
const croise = new Map();
let divergents = 0, comparables = 0, nonLus = 0;
for (const t of apres) {
  const p = proxyDit(String(t.addr || '').toLowerCase());
  const lu = t.b20Check === 'ok' ? (t.b20Kind === 'native' ? 'native' : 'non-native')
    : (t.b20Check == null ? '(absent)' : String(t.b20Check));
  const cle = p + ' | ' + lu;
  croise.set(cle, (croise.get(cle) || 0) + 1);
  if (lu === 'native' || lu === 'non-native') {
    comparables++;
    const luDit = lu === 'native' ? 'danger' : 'safe';
    if (luDit !== p) divergents++;
  } else nonLus++;
}
for (const [cle, n] of [...croise.entries()].sort((a, b) => b[1] - a[1])) {
  const [p, lu] = cle.split(' | ');
  const comparable = lu === 'native' || lu === 'non-native';
  const luDit = lu === 'native' ? 'danger' : 'safe';
  const verdict = !comparable ? 'NON COMPARABLE — la regle ne peut pas s abstenir'
    : (luDit === p ? 'accord' : '⛔ DIVERGENT');
  console.log(`    ${p.padEnd(10)} ${lu.padEnd(14)} ${String(n).padStart(4)}   ${verdict}`);
}

console.log(`\n  ${comparables} token(s) comparable(s), dont ${divergents} DIVERGENT(S).`);
console.log(`  ${nonLus} token(s) sans lecture exploitable — la regle gelee leur assigne quand meme`);
console.log('     un verdict, puisque son predicat n a aucune branche ABSTAIN pour l illisible.');

/* ── 3. combien sont deja RESOLUS ? ─────────────────────────────────────────────────────────── */
const resolus = apres.filter((t) => outcomeKnownAt(t, MAINTENANT, maturityH) !== null).length;
console.log(`\n  ${resolus} token(s) deja resolu(s) (fenetre ${maturityH} h) — les autres sont OUVERTS,`);
console.log('     ce qui n est ni un succes ni un echec de la regle.');
/* ── 4. POURQUOI la lecture est absente: l'ordre, pas le reseau ─────────────────────────────── */
const radar = fs.readFileSync(path.join(__dirname, 'token-radar.js'), 'utf8').split('\n');
const ligneDe = (motif) => radar.findIndex((l) => l.includes(motif)) + 1;
const selection = ligneDe('const toJudge = candidates.filter');
const ecriture = radar.findIndex((l) => /db\[c\.addr\]\.b20Check = /.test(l)) + 1;
const insertion = ligneDe('db[c.addr] = { sym:');
const avecChamp = rows.filter((t) => t.b20Check !== undefined).length;

console.log('\n  ── pourquoi la lecture manque: un ORDRE, pas une panne reseau ──\n');
console.log(`    ligne ${selection} : toJudge ne garde QUE les tokens absents de db (!db[c.addr])`);
console.log(`    ligne ${ecriture} : les ecritures b20Check sont gardees par if (db[c.addr])`);
console.log(`    ligne ${insertion} : db[c.addr] = { ... }  <-- l insertion, APRES la garde`);
console.log(`\n    => pour un token FRAIS, db[c.addr] est indefini par construction a la ligne ${ecriture},`);
console.log('       donc les trois ecritures (failed / unread / ok) ne peuvent JAMAIS tirer.');
console.log(`\n    verification sur la donnee : ${avecChamp} token(s) sur ${rows.length} portent b20Check.`);
console.log(avecChamp === 0
  ? '    ⛔ ZERO — la garde neutre a tout avale en silence, et les compteurs b20NonLu/b20Echec'
    + '\n       continuaient d incrementer, donc le digest pouvait annoncer des lectures qui n ecrivaient rien.'
  : '    ⚠️ non nul: l analyse d ordre ci-dessus ne suffit pas a expliquer la donnee, la relire.');

console.log('\n  ⛔ BORNE : cet instrument compare deux LECTURES, il ne dit pas laquelle predit mieux.');
console.log('     Trancher cela demanderait des issues resolues, et il n y en a pas encore assez.');
console.log('  ⛔ token-radar.js est un PAYLOAD EPINGLE: le corriger casse son sha256 et ARRETE le cron');
console.log('     en silence. Aucune edition ici — la mesure va au chip, la reparation avec son re-epinglage.\n');
