#!/usr/bin/env node
// probe-deployed-biii.js — le noeud EN LIGNE porte-t-il les correctifs, ou seulement le depot ?
// ================================================================================================
// Un correctif commite n'a corrige personne. Ce depot a deja mesure un ecart de 219 commits entre son
// arbre et la copie qui tournait, et la lecon n'a jamais ete « ca arrive » : c'est que **reparer le
// depot ne repare pas ce qui tourne**, et que rien dans le depot ne le signale.
//
// Ce script pose au noeud public une question dont la reponse ne peut venir que du code, et qui
// n'est pas ambigue: `till_trace_theft` en mode `bridge` sur une chaine non cablee. Le handler sort
// avant tout appel reseau, donc la reponse est deterministe, gratuite, et sans effet de bord.
//
//   AVANT le correctif du 2026-08-04 : { ok: false, reason: 'chain not wired' }
//   APRES                            : { ok: false, reason: ..., error: 'chain not wired' }
//
// La cle `error` est le marqueur: elle est posee INCONDITIONNELLEMENT sur ce chemin d'echec, donc son
// absence prouve que le code deploye est anterieur. Un marqueur conditionnel ne prouverait rien — c'est
// l'erreur qui a fait rater trois verifications de deploiement le meme jour sur le service jumeau.
//
// ⛔ Lecture pure. Aucun paiement, aucune signature. L'en-tete `x-ms-monitor: 1` est OBLIGATOIRE ici:
// sans lui, nos propres sondes seraient comptees comme des appels externes et deviendraient la preuve
// que le produit est utilise.
'use strict';

const URL_BASE = process.env.BIII_URL || 'https://biii-production.up.railway.app';

const CORPS = {
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'till_trace_theft', arguments: {
    mode: 'bridge', chain: 'chaine-qui-n-existe-pas', txHash: '0x' + 'cd'.repeat(32) } },
};

async function main() {
  console.log(`\n  noeud sonde : ${URL_BASE}`);

  let sante = null;
  try {
    const r = await fetch(URL_BASE + '/health', { headers: { 'x-ms-monitor': '1' }, signal: AbortSignal.timeout(20000) });
    sante = r.ok ? await r.json() : { ok: false, status: r.status };
  } catch (e) { sante = { erreurReseau: String((e && e.message) || e) }; }
  console.log(`  /health     : ${JSON.stringify(sante)}`);

  let texte = null, panne = null;
  try {
    const r = await fetch(URL_BASE + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-ms-monitor': '1' },
      body: JSON.stringify(CORPS), signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    texte = j && j.result && j.result.content && j.result.content[0] && j.result.content[0].text;
  } catch (e) { panne = String((e && e.message) || e); }

  /* ⚠️ TROIS ETATS, et le troisieme est celui qui compte le plus.
   * Une sonde qui ne repond pas ne dit RIEN sur la version deployee. La compter comme « pas a jour »
   * serait accuser sur notre propre incapacite a lire — le motif que ce depot a corrige quatre fois. */
  if (panne) {
    console.log(`\n  ⚠️ NON LU : ${panne}`);
    console.log('  Ce n est PAS « le noeud est en retard » — c est « on n a pas pu savoir ».');
    process.exitCode = 2;
    return;
  }

  let charge = null;
  try { charge = JSON.parse(texte); } catch { /* laisse null: forme inattendue */ }
  console.log(`  reponse     : ${texte}`);

  if (!charge || typeof charge !== 'object') {
    console.log('\n  ⚠️ Forme inattendue — le marqueur ne peut pas etre lu. Ne rien conclure.');
    process.exitCode = 2;
    return;
  }

  const aLeMarqueur = typeof charge.error === 'string' && charge.error.length > 0;
  console.log(`\n  marqueur \`error\` sur le chemin d echec : ${aLeMarqueur ? 'PRESENT' : 'ABSENT'}`);
  if (aLeMarqueur) {
    console.log('  ✅ Le noeud en ligne porte le correctif du 2026-08-04.');
  } else {
    console.log('  ⛔ Le noeud en ligne est ANTERIEUR au correctif du 2026-08-04.');
    console.log('     Consequence directe: un agent qui suit la convention `{ error }` de ce tool lit');
    console.log('     cet echec comme une reponse. Et si ce correctif-la n y est pas, ceux du meme lot');
    console.log('     n y sont pas non plus — dont celui de la route PAYANTE, ou une transaction encore');
    console.log('     en attente de minage est annoncee comme inexistante.');
    process.exitCode = 1;
  }
  console.log('\n  ⛔ Deployer reste un geste humain: chaque `railway up` coupe le HTTP (~90 s mesures).');
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
