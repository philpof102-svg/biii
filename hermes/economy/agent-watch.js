'use strict';
/**
 * agent-watch.js — watch the PUBLIC agent surface change, not just measure it once.
 * ================================================================================
 * The one-off survey answered "what do public MCP servers expose today". The more useful question is the one
 * that made the wallet guard worth reading: what CHANGED. A server that has always taken an amount is a
 * standing fact its users already accepted; a server that added a key-requesting tool in an update is an
 * event, and nobody is watching for it. The registry publishes versions, not diffs.
 *
 * It also fixes the survey's real weakness. `wantsSecret` — the branch that matters most — has never fired on
 * live input, and a 30-server sample from one page will probably never meet it. Covering the registry
 * continuously and remembering what each server looked like is how a rare case eventually walks past.
 *
 * ⚠️ CE QUE « 0 » VEUT DIRE ICI, ET DEPUIS QUAND. Jusqu'au 2026-07-28, ce zero couvrait deux etats
 * OPPOSES — « aucun serveur public ne demande de cle » et « le detecteur ne marche pas » — et rien dans
 * le depot ne permettait de les distinguer. Sortie constante = l'instrument, pas le sujet.
 * `test/agent-vet-secret-branch.test.js` fait desormais passer `vetAgent` par un VRAI serveur MCP local
 * et prouve la chaine complete (initialize -> tools/list -> auditTools -> verdict `refuse`).
 *
 * La distinction reste entiere, et il faut la dire proprement: le detecteur est PROUVE, il n'a toujours
 * JAMAIS tire sur une entree reelle. Ce qui a change n'est pas le chiffre, c'est ce qu'on a le droit d'en
 * lire — un zero live signifie maintenant « personne n'a demande », plus « detecteur non teste ».
 *
 * Trou connu et borne, epingle par ce meme test: le motif secret n'est cherche que dans les NOMS DE
 * CHAMPS du schema, jamais dans le nom de l'outil. `import_private_key({ value })` sort en lecture seule.
 * Le fermer demanderait de separer `import_private_key` de `check_private_key_leak` sur le seul nom —
 * une decision de conception, pas un correctif mecanique.
 *
 * ROTATES ON PURPOSE. A slice per run, advancing through the registry, so full coverage accumulates without
 * anyone's endpoint being hit every thirty minutes. Introspection only: initialize and tools/list, exactly
 * what any MCP client sends on connect, and no tool is ever called. Measuring strangers rudely would be its
 * own dishonesty.
 *
 * $0: keyless, no LLM, read-only.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { vetAgent } = require('../../lib/agent-vet');

const STATE = path.join(__dirname, '..', '..', 'data', 'agent-watch', 'registry.json');
const PER_RUN = Number(process.env.AGENT_WATCH_N || 20);   // endpoints introspected per run
const PAGES = Number(process.env.AGENT_WATCH_PAGES || 3);  // registry pages fetched per run
const PACE_MS = 700;

const get = (url) => new Promise((resolve) => {
  https.get(url, { headers: { accept: 'application/json' } }, (res) => {
    let d = ''; res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
  }).on('error', () => resolve(null));
});

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { servers: {}, offset: 0 }; } };

/** Every distinct HTTP endpoint the registry knows about, deduplicated (it lists each published version). */
/* ⚠️ UNE PAGE NON LUE DEVENAIT UNE PAGE VIDE, ET METTAIT FIN A LA PAGINATION. `((j && j.servers) || [])`
 * absorbait l'echec; puis `cursor` se calculait sur le meme `j` nul, donc valait `null`, donc `break`.
 * Un hoquet reseau sur la page 2 rendait la page 1 COMME SI C'ETAIT TOUT le registre — et l'appelant
 * recevait un tableau sans aucun moyen de savoir qu'il etait tronque.
 *
 * Ce que ca coute: cette liste est le DENOMINATEUR du recensement d'auditabilite (« 62 % des endpoints
 * publics ne sont pas auditables avant connexion »). Un denominateur silencieusement tronque donne un
 * pourcentage qui a l'air d'un resultat. Meme chose pour le plafond `PAGES`: s'arreter parce qu'on a
 * atteint la limite et s'arreter parce que la liste est finie sont deux faits differents.
 *
 * Le retour DIT desormais ce qu'il a lu. Et `get` est injectable: sans joint, cette fonction etait
 * intestable par construction, ce qui explique qu'aucun test ne l'ait jamais nommee. */
async function listEndpoints({ get: fetchImpl = get } = {}) {
  const seen = new Map();
  let cursor = null, pagesRead = 0, pagesFailed = 0, hitPageCap = false;
  for (let p = 0; p < PAGES; p++) {
    const url = 'https://registry.modelcontextprotocol.io/v0/servers?limit=100' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const j = await fetchImpl(url);
    // Une page qui n'a pas repondu, ou dont la forme n'est pas celle attendue, n'est pas une page vide.
    if (!j || !Array.isArray(j.servers)) { pagesFailed++; break; }
    pagesRead++;
    for (const e of j.servers) {
      const s = e && e.server;
      if (!s) continue;
      const remote = (s.remotes || []).find((r) => /http/i.test(r.type || '') && /^https:\/\//.test(r.url || ''));
      if (remote && !seen.has(remote.url)) seen.set(remote.url, { name: s.name, url: remote.url });
    }
    cursor = j.metadata && (j.metadata.nextCursor || j.metadata.next_cursor);
    if (!cursor) break;                       // vraie fin de liste
    if (p === PAGES - 1) { hitPageCap = true; break; }   // on s'arrete par PLAFOND, ce qui n'est pas la fin
    await new Promise((r) => setTimeout(r, 300));
  }
  const endpoints = [...seen.values()];
  return { endpoints, pagesRead, pagesFailed, hitPageCap,
    complete: pagesFailed === 0 && !hitPageCap,
    note: pagesFailed ? 'a registry page did not answer, so this list is a FLOOR — endpoints beyond it were never seen'
      : hitPageCap ? 'stopped at the ' + PAGES + '-page cap while the registry still had more, so this list is a FLOOR'
        : null };
}

/** A stable description of what a server can do, so a change in it is detectable without storing everything. */
/* ⚠️ DEUX CHAMPS SUR QUATRE PORTAIENT LA DISTINCTION, ET PAS LES DEUX QUI COMPTENT.
 * `tools` et `names` valaient `null` quand la surface etait illisible — l'auteur connaissait donc la
 * forme a trois etats. `movesValue` et `wantsSecret` retombaient a `[]`, c'est-a-dire « verifie: cet
 * agent n'expose aucune surface de paiement et ne demande aucune cle ». Ce sont exactement les deux
 * champs qui portent tout le propos de ce surveillant.
 *
 * Mesure du 2026-07-28 sur l'etat REEL (data/agent-watch/registry.json): 49 entrees sur 79 — 62 % —
 * portaient `tools: null` a cote de `movesValue: []`. Le `verdict` disait la verite (`unreachable`,
 * `unauditable`) et les tableaux la contredisaient DANS LE MEME OBJET. Ce n'etait pas latent: c'etait
 * la majorite de l'etat stocke.
 *
 * Deux consequences, opposees et toutes deux mauvaises:
 *   - maintenant: un appelant qui lit `movesValue` sans croiser `verdict` lit « aucune surface » sur une
 *     surface qu'on n'a jamais ouverte;
 *   - plus tard: au premier passage REUSSI, `gainedValue` vaut TOUT, et on annonce « X added a payment
 *     surface » — faux, il ne l'a pas ajoutee, on ne la voyait pas. Une panne de lecture fabrique une
 *     alerte de securite une semaine apres.
 *
 * `null` = PAS LU. `[]` = lu, et il n'y a rien. */
function fingerprint(r) {
  const s = r.surface;
  return {
    verdict: r.verdict,
    tools: s ? s.toolCount : null,
    names: s ? [...s.readOnly, ...s.movesValue.map((x) => x.name), ...s.namedButNoSurface.map((x) => x.name),
      ...s.wantsSecret.map((x) => x.name)].sort().join(',') : null,
    movesValue: s ? s.movesValue.map((x) => x.name).sort() : null,
    wantsSecret: s ? s.wantsSecret.map((x) => x.name).sort() : null,
  };
}

/** Une surface est LUE quand on en a rapporte une liste — un tableau vide en est une, `null` non. */
const lue = (v) => Array.isArray(v);

/**
 * judgeChange — ce qu'il faut dire d'UN agent, entre l'observation precedente et celle-ci. Extrait pur
 * pour qu'un test puisse l'atteindre: tant que la logique vivait dans l'IIFE, aucun lecteur ne pouvait
 * l'appeler, et c'est ce qui a laisse vivre le defaut ci-dessus. Rend { alerts, quiet }.
 */
function judgeChange(prev, now, e) {
  const alerts = [], quiet = [];
  const ou = '  ' + e.url;

  if (!lue(now.wantsSecret) || !lue(now.movesValue)) {
    /* Rien a comparer, et surtout rien a absoudre. On le dit au lieu de classer l'agent « rien a
     * signaler » — un silence issu d'une porte fermee n'est pas un silence rassurant. */
    quiet.push(e.name + ': surface NOT read (' + now.verdict + ') — this is not a clean read, nothing about '
      + 'its payment surface is known this run.' + ou);
    return { alerts, quiet };
  }

  if (!prev) {
    if (now.wantsSecret.length) alerts.push('🚨 NEW to the registry and it asks for key material: ' + e.name + ' — ' + now.wantsSecret.join(', ') + ou);
    else if (now.movesValue.length) alerts.push('⚠️  new: ' + e.name + ' exposes a payment surface (' + now.movesValue.join(', ') + ')' + ou);
    else quiet.push('first look: ' + e.name + ' [' + now.verdict + (now.tools != null ? ', ' + now.tools + ' tools' : '') + ']');
    return { alerts, quiet };
  }

  /* Un « il l'a AJOUTE » exige d'avoir vu l'avant. Si la lecture precedente avait echoue, ce passage-ci
   * est la PREMIERE lecture reelle, pas un changement — l'annoncer comme un ajout serait une accusation
   * fabriquee par notre propre panne. */
  if (!lue(prev.wantsSecret) || !lue(prev.movesValue)) {
    if (now.wantsSecret.length) alerts.push('🚨 ' + e.name + ' asks for key material (' + now.wantsSecret.join(', ')
      + ') — FIRST readable look, the previous run could not open its surface, so this is a state, not a change.' + ou);
    else if (now.movesValue.length) quiet.push(e.name + ' exposes a payment surface (' + now.movesValue.join(', ')
      + ') — first readable look after an unread run; state, not a change.' + ou);
    else quiet.push(e.name + ': surface readable again [' + now.verdict + '], nothing dangerous on it.' + ou);
    return { alerts, quiet };
  }

  if (now.wantsSecret.length && !prev.wantsSecret.length)
    alerts.push('🚨 ' + e.name + ' NOW ASKS FOR KEY MATERIAL (' + now.wantsSecret.join(', ') + ') — it did not before.' + ou);
  const gainedValue = now.movesValue.filter((n) => !prev.movesValue.includes(n));
  if (gainedValue.length) alerts.push('⚠️  ' + e.name + ' added a payment surface: ' + gainedValue.join(', ') + ou);
  if (prev.verdict === 'answers' && now.verdict === 'unreachable')
    alerts.push('🕳️ ' + e.name + ' answered before and is dark now.' + ou);
  if (now.names && prev.names && now.names !== prev.names && !gainedValue.length && !now.wantsSecret.length)
    quiet.push(e.name + ' changed its tool set (' + prev.tools + ' → ' + now.tools + ') with nothing dangerous added');
  return { alerts, quiet };
}

/**
 * summarise — la ligne de titre, extraite pour qu'un test puisse l'epingler.
 *
 * ⚠️ DEUX DEFAUTS TROUVES EN LANCANT LE SCRIPT POUR DE VRAI, qu'aucun test unitaire ne pouvait voir.
 * Sortie observee le 2026-07-28 sur deux agents dont la surface etait inauditable:
 *
 *   ✓ agent-watch: nothing dangerous appeared in 2 agents this run.
 *     coverage: 79 of 39 registered endpoints
 *
 *   1. `blind` ne comptait que les INJOIGNABLES. Un agent qui repond mais dont on n'ouvre pas la
 *      surface etait compte comme « verifie », donc la clause « so silence is partial » ne se
 *      declenchait pas: le titre affirmait un balayage propre de 2 agents dont on n'avait ouvert
 *      AUCUN. Le meme fail-open que dans `fingerprint`, un etage plus haut.
 *   2. « 79 of 39 » — un ratio dont les deux cotes viennent de populations differentes: `known` est
 *      l'etat accumule sur tous les passages, `all.length` ce que le registre a rendu CE run. Avec la
 *      pagination par defaut le rapport a l'air plausible, ce qui est exactement pourquoi il a survecu.
 */
function summarise({ alerts, checked, blind, unread, known, registryThisRun, offset }) {
  const ouverts = checked - blind - unread;
  const partiel = [];
  if (blind) partiel.push(blind + ' unreachable');
  if (unread) partiel.push(unread + ' answered but their surface could not be opened');
  const reserve = partiel.length ? ' — ' + partiel.join(', ') + ', so this silence is PARTIAL' : '';
  return [
    alerts
      ? '🚨 agent-watch: ' + alerts + ' change(s) worth knowing across ' + checked + ' agents checked this run.'
      : '✓ agent-watch: nothing dangerous appeared on the ' + ouverts + ' surface(s) actually opened, of '
        + checked + ' agents visited' + reserve + '.',
    '  coverage: ' + known + ' endpoint(s) seen at least once across all runs; the registry returned '
      + registryThisRun + ' this run; next run resumes at #' + offset,
  ];
}

/* Exporte AVANT l'IIFE, et l'IIFE ne tourne plus qu'en execution directe. Sans ce garde, requerir ce
 * fichier depuis un test lancerait un balayage reseau du registre — c'est pour ca qu'il n'exportait
 * rien, et donc que sa logique de jugement n'avait aucun lecteur. Le meme oubli est deja documente en
 * tete de scripts/biii-known-bad-ingest.js. */
module.exports = { fingerprint, judgeChange, summarise, listEndpoints };

if (require.main === module) (async () => {
  const state = readState();
  const listing = await listEndpoints();
  const all = listing.endpoints;
  /* Trois issues, pas deux. « Le registre n'a pas repondu » et « le registre a repondu, il est vide »
   * meritent des phrases differentes — et une liste TRONQUEE doit se dire avant qu'on en tire un taux. */
  if (!listing.pagesRead) { console.log('⚠️ agent-watch: the registry did not answer at all — nothing was checked, which is not the same as nothing changed.'); return; }
  if (!all.length) { console.log('⚠️ agent-watch: the registry answered but listed no HTTP endpoint. That is a reading, not a failure — and not a reason to conclude anything about the agents.'); return; }
  if (!listing.complete) console.log('⚠️ agent-watch: ' + listing.note + ' (' + listing.pagesRead + ' page(s) read, ' + all.length + ' endpoint(s) — a FLOOR, not a census).');

  // Rotate: take a slice starting where the last run stopped, wrapping around.
  const start = (state.offset || 0) % all.length;
  const slice = [];
  for (let i = 0; i < Math.min(PER_RUN, all.length); i++) slice.push(all[(start + i) % all.length]);

  const alerts = [], quiet = [];
  let blind = 0;
  let unread = 0;                 // a repondu, mais sa surface n a pas pu etre ouverte

  for (const e of slice) {
    let r;
    try { r = await vetAgent({ url: e.url }); } catch { r = null; }
    await new Promise((s) => setTimeout(s, PACE_MS));
    if (!r) { blind++; continue; }

    const now = fingerprint(r);
    if (!Array.isArray(now.movesValue)) unread++;
    const jugement = judgeChange(state.servers[e.url], now, e);
    alerts.push(...jugement.alerts);
    quiet.push(...jugement.quiet);
    state.servers[e.url] = { ...now, name: e.name, lastSeen: new Date().toISOString() };
  }

  state.offset = (start + slice.length) % all.length;
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

  for (const l of summarise({ alerts: alerts.length, checked: slice.length, blind, unread,
    known: Object.keys(state.servers).length, registryThisRun: all.length, offset: state.offset })) console.log(l);
  for (const a of alerts) console.log('  ' + a);
  for (const q of quiet.slice(0, 6)) console.log('  · ' + q);
})();
