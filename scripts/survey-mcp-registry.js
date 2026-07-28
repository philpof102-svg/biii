'use strict';
/**
 * survey-mcp-registry.js — run the agent vetter across real, publicly registered MCP servers.
 *
 * Written because agent-vet had no true positive. Every check on it so far was either an example I wrote
 * myself or our own endpoint, which is the weakest kind of validation and exactly the sort this project keeps
 * catching in other people's work. A security tool exercised only on friendly input is untested.
 *
 * The official MCP registry publishes servers with `server.remotes[].url`, so the wild is one API call away.
 * Two things come out of this: the vetter meets input it did not anticipate, and the distribution itself is a
 * finding — how many publicly listed agents simply do not answer, how many expose a payment surface, how many
 * ask for key material.
 *
 * POLITE BY CONSTRUCTION: it sends `initialize` and `tools/list` and nothing else. That is precisely what any
 * MCP client does when it connects, no tool is ever called, and the sweep is paced. Being rude to strangers'
 * endpoints to measure them would be its own kind of dishonesty.
 */
const https = require('node:https');
const path = require('node:path');
const { vetAgent } = require(path.join(__dirname, '..', 'lib', 'agent-vet'));

const SAMPLE = Number(process.env.SURVEY_N || 30);
const PACE_MS = 700;

const get = (url) => new Promise((resolve) => {
  https.get(url, { headers: { accept: 'application/json' } }, (res) => {
    let d = ''; res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
  }).on('error', () => resolve(null));
});

/**
 * distribution — les lignes du recensement. Extrait pur, parce que ce script n'exportait rien et que le
 * chiffre qu'il produit est destine a etre PUBLIE: un artefact public sans lecteur est un artefact qu'on
 * croit sur parole.
 *
 * ⚠️ `if (v)` SUPPRIMAIT LES CATEGORIES A ZERO. Sur un recensement, « refuse: 0/79 » EST une mesure —
 * elle dit qu'on a regarde et qu'on n'en a pas trouve. La faire disparaitre rend le zero indiscernable
 * d'un controle qui n'a pas tourne, c'est-a-dire exactement ce que ce depot passe la journee a separer.
 * Toutes les cases sont donc imprimees, y compris vides.
 */
function distribution(tally, total, totalTools) {
  const lignes = [];
  for (const [k, v] of Object.entries(tally)) {
    lignes.push('  ' + k.padEnd(14) + v + '/' + total + (v === 0 ? '   (mesuré, aucun)' : ''));
  }
  if (tally.surveyFailed) {
    lignes.push('  ⚠️ surveyFailed compte NOS échecs (DNS, débit, socket), pas leurs endpoints — ces '
      + tally.surveyFailed + ' ne disent rien sur les services concernés.');
  }
  lignes.push('  tools seen in total: ' + totalTools);
  return lignes;
}

/**
 * classerReponse — dans quelle case tombe UNE reponse de `vetAgent`. Extrait pur pour la meme raison que
 * `distribution`: la ligne vivait dans la boucle reseau, donc aucun test ne pouvait l'atteindre — et la
 * mutation « notre panne comptee comme la leur » revenait MUETTE, c'est-a-dire que le correctif le plus
 * important du fichier n'avait pas de lecteur.
 *
 * `null` = notre appel a jete (DNS, debit, socket). Ce n'est PAS `unreachable`, qui est un verdict SUR
 * leur service.
 */
function classerReponse(r) {
  if (!r) return { cle: 'surveyFailed', noToolList: false, tools: 0 };
  const s = r.surface;
  return {
    cle: r.verdict,
    // Un endpoint garde n'a pas de surface PARCE QU'il nous a refuses — c'est deja son verdict, et le
    // compter deux fois gonflait ce chiffre.
    noToolList: r.verdict === 'answers' && !s,
    tools: s ? (s.toolCount || 0) : 0,
  };
}

module.exports = { distribution, classerReponse };
if (require.main !== module) return;

(async () => {
  const reg = await get('https://registry.modelcontextprotocol.io/v0/servers?limit=100');
  const entries0 = ((reg && reg.servers) || [])
    .map((e) => e && e.server)
    .filter(Boolean)
    .map((s) => ({
      name: s.name,
      url: (s.remotes || []).filter((r) => /http/i.test(r.type || ''))
        .map((r) => r.url).find((u) => /^https:\/\//.test(u || '')),
    }))
    .filter((s) => s.url);
  // The registry lists every published version, so the same server appears several times. Deduplicating by
  // URL is what makes the sample size mean what it says.
  const seen = new Set();
  const deduped = entries0.filter((e) => { const k = e.url; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, SAMPLE);

  const entries = deduped;
  console.log('== surveying ' + entries.length + ' distinct publicly registered MCP servers ==');
  console.log('   (deduplicated by URL — the registry lists every published version separately)');
  console.log('   introspection only: initialize + tools/list, no tool is ever called\n');

  /* `surveyFailed` est DISTINCT d'`unreachable`: le premier est notre instrument, le second leur service.
   * Les confondre publie notre panne sous le nom de quelqu'un d'autre. */
  const tally = { unreachable: 0, unauditable: 0, answers: 0, high_risk: 0, refuse: 0, noToolList: 0,
    surveyFailed: 0 };
  const notable = [];
  let totalTools = 0;

  for (const e of entries) {
    let r;
    /* ⚠️ NOTRE PANNE DEVENAIT UN FAIT PUBLIE SUR UN TIERS.
     * Un `vetAgent` qui JETTE de notre cote (DNS, limite de debit, socket) atterrissait dans
     * `unreachable` — le seau qui veut dire « leur endpoint ne repond pas ». Or tout le propos de ce
     * recensement est de qualifier LEUR auditabilite: publier notre echec sous leur nom est la meme
     * faute que toutes les accusations corrigees aujourd'hui, sur un chiffre destine a sortir. */
    try { r = await vetAgent({ url: e.url }); } catch { r = null; }
    await new Promise((s) => setTimeout(s, PACE_MS));
    const cl = classerReponse(r);
    tally[cl.cle] = (tally[cl.cle] || 0) + 1;
    if (cl.noToolList) tally.noToolList++;
    totalTools += cl.tools;
    if (!r) continue;
    const s = r.surface;

    const flag = (s && s.wantsSecret.length) ? 'ASKS FOR KEY MATERIAL: ' + s.wantsSecret.map((x) => x.name).join(', ')
      : (s && s.movesValue.length) ? 'payment surface: ' + s.movesValue.map((x) => x.name + ' (' + x.field + ')').join(', ')
      : null;
    if (flag) notable.push({ name: e.name, url: e.url, flag, tools: s.toolCount });

    const mark = r.verdict === 'refuse' ? '⛔' : r.verdict === 'high_risk' ? '⚠️ ' : r.verdict === 'unreachable' ? '🕳️' : r.verdict === 'unauditable' ? '🔒' : '· ';
    console.log('  ' + mark + ' ' + String(e.name).slice(0, 38).padEnd(40) +
      r.verdict.padEnd(12) + (s ? s.toolCount + ' tools' : (r.liveness && r.liveness.reason || '').slice(0, 44)));
  }

  console.log('\n== distribution ==');
  for (const l of distribution(tally, entries.length, totalTools)) console.log(l);

  if (notable.length) {
    console.log('\n== what a caller should know before connecting ==');
    for (const n of notable) console.log('  ' + n.name + '\n     ' + n.flag + '\n     ' + n.url);
  } else {
    console.log('\n== no endpoint in this sample asked for key material or exposed a payment surface ==');
  }

  console.log('\n  A verdict of "answers" is the floor, not a clearance: it means the endpoint exists and its');
  console.log('  tools take neither key material nor an amount. Nothing here grades how good the prose is.');
})();
