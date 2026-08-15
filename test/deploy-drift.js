#!/usr/bin/env node
'use strict';
/**
 * CE QUI TOURNE EN LIGNE EST-IL CE QUE CE DEPOT CONTIENT ?
 * Run: npm run test:deploy          (reseau — DELIBEREMENT hors de `npm test`)
 *
 * ⚠️ LE PROBLEME QU'IL RESOUT, ET POURQUOI UN MARQUEUR NE SUFFIT PAS.
 * `lib/server.js` publie depuis le 2026-08-13 un `deployment.marker` fait pour repondre a « quel arbre
 * tourne ici ». Mesure du 2026-08-15 sur le noeud public: le champ N'EST PAS LA. Le commit qui l'a
 * ajoute n'a jamais ete deploye — autrement dit **l'instrument construit pour detecter le retard est
 * lui-meme en retard**, et le seul moyen de voir l'ecart reste de remarquer un champ MANQUANT. C'est
 * exactement ce que decrit le commit d'origine, `13f0e55`: « a MISSING field is how I found out ».
 *
 * 💎 Tout marqueur a ce defaut: il ne peut rien dire tant qu'il n'est pas deploye. La comparaison de
 * FORME, elle, marche des le premier jour, parce qu'elle derive l'attendu du depot LOCAL et le confronte
 * au distant. Rien a deployer pour qu'elle commence a servir.
 *
 * 🔬 COMMENT. On demarre le serveur de CE depot en memoire (le meme `build()` que la suite), on lit son
 * /health, et on compare l'ENSEMBLE DE SES CLES a celui du noeud public. Une cle presente ici et absente
 * la-bas date l'arbre distant AVANT le commit qui l'a ajoutee. L'attendu n'est jamais ecrit en dur: il
 * est produit par le code du depot a chaque execution, donc il ne peut pas vieillir a cote de lui.
 *
 * ⛔ CE QU'IL NE PEUT PAS VOIR — a lire avant de prendre un vert pour « la prod est a jour ».
 * Il ne detecte que les changements qui MODIFIENT LA FORME de /health. Un correctif qui change un
 * comportement sans ajouter de champ — le refus de /charge qui nomme sa cause, l'echappement d'une page,
 * le montant paye rendu en trois etats — reste INVISIBLE ici. Un vert dit « aucune derive de forme
 * detectee », jamais « le code en ligne est celui du depot ».
 *
 * ⛔ LECTURE SEULE. Un seul GET sur /health, borne. Aucun POST, aucune route d'ecriture, aucun paiement.
 */
const http = require('node:http');
const { build } = require('../lib/server');

const DISTANT = process.env.BIII_LIVE_URL || 'https://biii-production.up.railway.app';
const M = '0x' + 'ab'.repeat(20);

const get = async (url) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'x-ms-monitor': '1', 'user-agent': 'biii-deploy-drift' }, signal: ctl.signal });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch { /* pas du JSON */ }
    return { status: r.status, j };
  } catch (e) { return { status: 0, erreur: e.message }; }
  finally { clearTimeout(t); }
};

(async () => {
  console.log('derive de deploiement — ce depot contre ' + DISTANT + ':\n');

  // 1) LA FORME ATTENDUE, produite par LE CODE DE CE DEPOT. Jamais recopiee.
  const local = build({ merchant: M, findPayment: async () => null });
  await new Promise((r) => local.listen(0, r));
  const ici = await get('http://127.0.0.1:' + local.address().port + '/health');
  /* ⚠️ ATTENDRE la fermeture, et ne JAMAIS appeler process.exit() ensuite. Mesure du 2026-08-15: un
   * `local.close()` non attendu suivi d'un `process.exit()` fait sauter une assertion libuv sur Windows
   * (« UV_HANDLE_CLOSING », async.c:76) et le processus sort en **127** — pas en 1. Ce fichier est un
   * GATE: ses trois codes (0 vert / 1 derive / 2 sonde muette) sont tout ce qu'il produit d'exploitable,
   * et 127 les ecrasait tous les trois. On pose `process.exitCode` et on laisse la boucle se vider. */
  await new Promise((r) => local.close(r));

  if (!ici.j) {
    console.log('  ECHEC: le serveur local n a pas rendu de /health lisible — rien a comparer.');
    process.exitCode = 1; return;
  }
  const clesIci = Object.keys(ici.j).sort();
  console.log('  attendu (ce depot) : ' + clesIci.join(', '));

  // 2) CE QUE LE NOEUD PUBLIC REND.
  const la = await get(DISTANT + '/health');
  if (la.erreur || !la.j) {
    // ⚖️ Un reseau muet n'est PAS un verdict de derive: on sort en 2 pour que ce soit distinguable
    // d'un vrai ecart (1) et d'un vert (0). Une panne de sonde ne doit jamais se lire comme un resultat.
    console.log('  noeud public INJOIGNABLE : ' + (la.erreur || ('HTTP ' + la.status + ', reponse non-JSON')));
    console.log('\n  ⚠️ AUCUNE CONCLUSION. Ne pas lire cette sortie comme « pas de derive ».');
    process.exitCode = 2; return;
  }
  const clesLa = Object.keys(la.j).sort();
  console.log('  servi   (en ligne) : ' + clesLa.join(', '));

  // 3) LA DERIVE.
  const manquantes = clesIci.filter((k) => !clesLa.includes(k));
  const enPlus = clesLa.filter((k) => !clesIci.includes(k));
  console.log('');
  if (enPlus.length) {
    // Le sens INVERSE existe aussi et il compte: un champ servi que le depot ne produit plus veut dire
    // que la copie en ligne porte du code qui n'est dans AUCUN arbre ici.
    console.log('  ⚠️ servi mais absent du depot : ' + enPlus.join(', '));
    console.log('     -> la copie en ligne porte du code qui n est pas dans ce depot.');
  }
  if (manquantes.length) {
    console.log('  🔴 DERIVE — champs presents ici et ABSENTS en ligne : ' + manquantes.join(', '));
    console.log('     -> l arbre deploye est ANTERIEUR au commit qui a ajoute chacun de ces champs.');
    console.log('     -> tout correctif pousse depuis n est PAS en ligne.');
    console.log('\n  ⛔ Rappel de borne: seuls les changements de FORME sont visibles ici.');
    process.exitCode = 1; return;
  }
  if (!enPlus.length) console.log('  aucune derive de FORME detectee sur /health.');
  console.log('  ⛔ Ce n est PAS « la prod est a jour »: un correctif de comportement ne change aucune cle.');
  process.exitCode = enPlus.length ? 1 : 0;
})();
