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

  /* ⚠️ UNE ECHELLE, PAS UN BARREAU. Le 2026-08-13 cette sonde a repondu ✅ et sorti 0 sur un noeud a qui
   * il manquait NEUF jours de correctifs, dont le fail-open de 13 points ou un agent qui n a jamais paye
   * est note comme s il avait paye aujourd hui. Elle avait la preuve dans la main: elle recupere /health,
   * l IMPRIME, et ne s en sert pas pour juger. Un marqueur unique ne date pas un deploiement, il repond a
   * une seule question de l annee ou il a ete ecrit — et un vert sur un noeud defectueux est l AFFIRMATION,
   * la faute que ce depot chasse partout ailleurs.
   *
   * ⛔ QUAND UN CORRECTIF NOTABLE PART, AJOUTER SON BARREAU ICI, en tete. Chaque marqueur doit etre pose
   * INCONDITIONNELLEMENT sur son chemin, sinon son absence ne prouve rien. */
  const santeLue = !!(sante && sante.ok === true);
  const ECHELLE = [
    { date: '2026-08-13', quoi: '`deployment` dans /health (le noeud sait se nommer)',
      lu: santeLue, present: () => !!(sante && sante.deployment && typeof sante.deployment === 'object'),
      cout: 'sans lui, seule une chasse au champ manquant dit quel arbre tourne — c est ainsi que le retard a ete trouve.' },
    { date: '2026-08-12', quoi: '`collector` dans /health (etat du collecteur)',
      lu: santeLue, present: () => !!(sante && sante.collector && typeof sante.collector.state === 'string'),
      cout: 'son absence date le noeud AVANT le 12/08 — donc avant le correctif finite(null) du 13/08, ou une lecture NULLE (jamais paye) est notee comme un paiement du jour: 13 points de fail-open, du cote flatteur.' },
    { date: '2026-08-04', quoi: '`error` sur le chemin d echec de till_trace_theft',
      lu: true, present: () => typeof charge.error === 'string' && charge.error.length > 0,
      cout: 'un agent qui suit la convention `{ error }` lit cet echec comme une reponse; et du meme lot manque le correctif de la route PAYANTE, ou une transaction en attente de minage est annoncee inexistante.' },
  ];

  console.log('');
  /* ⚠️ C est le plus ANCIEN barreau manquant qui borne, pas le plus recent. L echelle est lue du neuf au
   * vieux, donc le premier ABSENT rencontre est le moins informatif: annoncer « anterieur au 13/08 » quand
   * le 12/08 manque aussi elargit la borne d un jour ET imprime le cout le moins grave, ce qui enterre le
   * plus grave. Le plus recent PRESENT donne l autre cote: le retard s encadre, il ne s estime pas. */
  let illisible = null; const absents = [], presents = [];
  for (const b of ECHELLE) {
    /* TROIS ETATS. Un barreau dont la SOURCE n a pas ete lue ne vaut ni present ni absent: le compter
     * absent serait accuser sur notre propre incapacite a lire, le compter present serait un fail-open. */
    const etat = !b.lu ? 'NON LU' : (b.present() ? 'PRESENT' : 'ABSENT');
    console.log(`  ${b.date}  ${etat.padEnd(7)}  ${b.quoi}`);
    if (etat === 'ABSENT') absents.push(b);
    if (etat === 'PRESENT') presents.push(b);
    if (etat === 'NON LU' && !illisible) illisible = b;
  }

  if (absents.length) {
    const borne = absents[absents.length - 1];            // le plus ANCIEN manquant: la borne la plus serree
    const plancher = presents[0] || null;                  // le plus RECENT present: l autre cote
    console.log(`\n  ⛔ Le noeud en ligne est ANTERIEUR au ${borne.date}`
      + (plancher ? `, et POSTERIEUR au ${plancher.date}.` : '.'));
    console.log(`     ${borne.cout}`);
    if (absents.length > 1) {
      console.log(`     (${absents.length} barreaux manquants au total; les plus recents sont impliques par celui-ci.)`);
    }
    process.exitCode = 1;
  } else if (illisible) {
    console.log(`\n  ⚠️ NON CONCLU: la source du barreau ${illisible.date} n a pas pu etre lue.`);
    console.log('     Ce n est PAS « a jour » — c est « on n a pas pu savoir ».');
    process.exitCode = 2;
  } else {
    console.log('\n  ✅ Le noeud en ligne porte tous les marqueurs de cette echelle.');
    console.log('     ⛔ Ce qui ne dit PAS « a jour »: l echelle ne connait que les correctifs qu on y a');
    console.log('     ajoutes. Elle borne le retard par le bas, jamais par le haut.');
  }
  console.log('\n  ⛔ Deployer reste un geste humain: chaque `railway up` coupe le HTTP (~90 s mesures).');
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
