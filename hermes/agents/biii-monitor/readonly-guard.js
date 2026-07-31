#!/usr/bin/env node
'use strict';
/**
 * readonly-guard — a Hermes `pre_tool_call` hook that makes the unattended biii-monitor PROVABLY read-only.
 * ====================================================================================================
 * The monitor observes + delegates; it must NEVER autonomously write or move value. This hook is the
 * hard enforcement of that rule — it survives `/yolo` (approvals.mode off), because YOLO bypasses
 * approval prompts but NOT tool-filtering / hard-blocks. Wire it in config.yaml:
 *
 *   hooks:
 *     - event: pre_tool_call
 *       command: node /root/.hermes-biii/hooks/readonly-guard.js
 *       timeout: 5
 *
 * Contract: reads the tool call as JSON on stdin; to block, prints {"action":"block","message":...}.
 */
const DENY = new Set([
  // biii — anything that creates a charge / invoice / spend authorization
  'till_create_charge', 'till_create_invoice', 'till_authorize',
  // gitlawb — anything that writes to the network / signs / moves reputation or value
  'repo_create', 'pr_create', 'pr_review', 'pr_merge', 'issue_create', 'issue_comment',
  'bounty_create', 'bounty_claim', 'bounty_submit', 'task_create', 'task_claim', 'task_complete',
  'webhook_create', 'webhook_delete', 'agent_register', 'ucan_delegate', 'identity_sign',
  // base-mcp (if ever added) — the absolute never-autonomous set.
  // 2026-07-31: `fund`, `initiate_x402_request` and `complete_x402_request` added after enumerating the
  // Base MCP toolset actually offered today. `fund` moves value into the wallet and the x402 pair settles
  // a payment — they belong in the same class as send/swap/sign, and were simply not in the list because
  // the list predates seeing that server's real tool names. No wallet MCP is mounted in this fleet; this
  // stays a pre-emptive block, which is the only kind worth having before the server appears.
  'send', 'swap', 'sign', 'send_calls', 'fund', 'initiate_x402_request', 'complete_x402_request',
  // lawbor — the agent-to-agent economy WRITES (post/offer/bid/settle/block). Descriptor-only, but an
  // unattended monitor must not autonomously speak, list, bid, lock a price, or bind a settlement.
  'lawbor_say', 'lawbor_bot_say', 'lawbor_offer', 'lawbor_post_job', 'lawbor_bid', 'lawbor_confirm',
  'lawbor_quote', 'lawbor_settle', 'lawbor_validate', 'lawbor_block', 'lawbor_unblock', 'lawbor_accept',
]);

// Backstop for UNKNOWN paid toolsets (e.g. monid, whose tools we can't enumerate until OAuth): block any
// tool whose name carries an unambiguous MONEY / execute verb. `monid.run` / `*.pay` / `*.checkout` spend
// per call — an unattended monitor must never trigger them. Read verbs (discover/inspect/list/get/…) pass.
const MONEY_VERB = /(^|_)(run|pay|buy|purchase|order|checkout|charge|spend|exec|execute|withdraw|deposit|transfer|remit|topup)($|_)/i;

/* Journal des FORMES observees (jamais les valeurs — un payload peut porter un secret). Le fail-closed
 * ci-dessous est correct mais aveugle: si Hermes renomme le champ, le garde bloquera TOUT et on
 * apprendra la nouvelle forme par une panne. En enregistrant les cles a chaque refus d'identification,
 * on apprend la forme reelle AVANT qu'elle ne casse quoi que ce soit — l'hypothese devient une mesure.
 * L'ecriture ne peut jamais decider d'un appel: toute erreur ici est avalee. */
const JOURNAL = process.env.READONLY_GUARD_LOG || '/root/.hermes-biii/hooks/observed-shapes.log';
function noteForme(etiquette, cles) {
  try {
    require('fs').appendFileSync(JOURNAL, `${new Date().toISOString()} ${etiquette} keys=${cles}\n`);
  } catch { /* le journal ne bloque ni n'autorise rien */ }
}

/* ── MESURE BORNEE 48h (fin: 2026-08-02T12:00Z) ──────────────────────────────────────────────────
 * On veut concevoir un controle sur les ARGUMENTS (voir ARGUMENT-GUARD-DESIGN.md). Il repose sur une
 * hypothese non mesuree: que ce hook voit les arguments. Indices: le binaire Hermes contient
 * `tool_input` ET `toolInput` (3 fois chacun) et ne contient ni `arguments` ni `params` — mais aucun
 * payload REEL n'a jamais ete observe, parce que le journal ci-dessus n'enregistre que les appels
 * NON identifies, et aucun n'a echoue.
 *
 * On enregistre donc la FORME de chaque appel: noms de cles de premier niveau, et si un champ
 * d'arguments existe, ses noms de champs et leur nombre. JAMAIS les valeurs — un payload peut porter
 * exactement le secret que ce controle existera pour proteger, et un journal qui les capture serait
 * l'exfiltration qu'il pretend empecher.
 *
 * La borne est en dur et depassee = plus rien n'est ecrit. Une mesure sans fin devient un fichier que
 * personne ne relit; celle-ci a une date de lecture. */
const FIN_MESURE = Date.parse('2026-08-02T12:00:00Z');
function mesurerForme(charge, tool) {
  try {
    if (!(Date.now() < FIN_MESURE)) return;              // borne depassee → silence total
    if (!charge || typeof charge !== 'object') return;
    const cles = Object.keys(charge).join('|');
    const args = charge.tool_input ?? charge.toolInput ?? charge.tool_args ?? charge.input;
    let desc;
    if (args === undefined) desc = 'args=ABSENT';
    else if (args === null) desc = 'args=null';
    else if (typeof args !== 'object') desc = `args=${typeof args}`;
    else {
      const noms = Object.keys(args);
      desc = `args=object n=${noms.length} fields=${noms.join(',') || '(none)'}`;
    }
    require('fs').appendFileSync(JOURNAL,
      `${new Date().toISOString()} SHAPE tool=${tool} keys=${cles} ${desc}\n`);
  } catch { /* mesurer ne doit jamais decider d'un appel */ }
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => {
  // stdin illisible = on ne verra jamais l'appel. Meme regle que partout ici: refuser, pas supposer.
  process.stdout.write(JSON.stringify({
    action: 'block',
    message: 'biii-monitor is READ-ONLY: the hook could not read the tool call (stdin error). Blocking — a guard that cannot see the call must not authorise it.',
  }));
  process.exit(0);
});
process.stdin.on('end', () => {
 try {
  /* ⚠️ « MALFORMED → TREAT AS UNKNOWN » VOULAIT DIRE AUTORISE.
   * L'ancien code laissait `tool = ''` sur un payload illisible, et la fin du fichier pose « silence =
   * allow ». Mesure du 2026-07-28 en executant CE script:
   *
   *   JSON malforme        -> AUTORISE      tool_name absent -> AUTORISE
   *   stdin vide           -> AUTORISE      tool_name: null  -> AUTORISE
   *
   * Sur un garde dont le seul metier est de bloquer, une entree non lue devenait une permission. Et le
   * risque realiste n'est pas le JSON casse: c'est qu'une mise a jour de Hermes RENOMME le champ. Le
   * garde autoriserait alors tout, pour toujours, sans un signal — un « provably read-only » qui ne
   * prouve plus rien, en silence.
   *
   * On accepte donc plusieurs noms de champ plausibles, et on BLOQUE quand on ne sait pas ce qui est
   * appele. Le cout du fail-closed est bruyant (l'agent ne fait plus rien, quelqu'un regarde), ce qui
   * est exactement l'inverse du cout d'un fail-open ici. */
  let charge; let illisible = false;
  try { charge = JSON.parse(raw.trim() || 'null'); } catch { illisible = true; }
  const nomBrut = charge && typeof charge === 'object'
    ? (charge.tool_name ?? charge.toolName ?? charge.tool ?? charge.name) : undefined;
  const tool = typeof nomBrut === 'string' ? nomBrut : '';
  if (illisible || !tool.trim()) {
    // On refuse, ET on enregistre la forme: c'est le seul endroit ou la forme reelle du payload se
    // manifeste. Sans ce journal, un renommage de champ se decouvre par un agent muet.
    noteForme(illisible ? 'UNPARSEABLE' : 'NO_TOOL_NAME',
      charge && typeof charge === 'object' ? Object.keys(charge).join('|') : '(none)');
    process.stdout.write(JSON.stringify({
      action: 'block',
      message: 'biii-monitor is READ-ONLY and could NOT identify this tool call'
        + (illisible ? ' (the hook payload did not parse)' : ' (no tool name in the payload)')
        + '. Blocking: a guard that cannot tell what is being called must refuse, not wave it through. '
        + 'If the payload shape changed, update readonly-guard.js — do not disable it.',
    }));
    process.exit(0);
  }
  mesurerForme(charge, tool);   // observation seule — n'influence aucune decision ci-dessous
  const segments = tool.split(/__|[.:/\s]/).filter(Boolean);
  const seg = segments[segments.length - 1];        // strip server namespace (., :, /, ws, or __), keep single _ in names
  // Supervised spend opt-in: MONID_ALLOW_SPEND=1 lets THIS run use monid's paid tools (the x-devradar
  // research skill, ~$0.025/cycle). It ONLY unblocks the monid namespace — base send/swap/sign and every
  // gitlawb/biii write stay blocked regardless. Unattended runs (no env) keep monid spend blocked too.
  const isMonid = seg.toLowerCase().startsWith('monid') || /(^|[._:/])monid_/i.test(tool);
  if (process.env.MONID_ALLOW_SPEND === '1' && isMonid) { process.exit(0); }
  /* `wallet.send.now` passait: `.pop()` ne regardait que le DERNIER segment, et MONEY_VERB ne contient
   * pas `send`/`swap`/`sign` (ils vivent dans DENY). On teste donc DENY sur CHAQUE segment.
   *
   * Volontairement PAS MONEY_VERB sur chaque segment: la regex est floue et attraperait des outils de
   * LECTURE legitimes (`get-transfer-history` porte `transfer`). Un garde qui bloque des lectures se
   * fait desactiver, et on perd tout. DENY est une liste EXACTE de noms dangereux connus: la tester
   * segment par segment ne cree aucun faux positif. Le trou restant — un verbe d'argent inconnu au
   * milieu d'un nom pointe — est nomme ici plutot que ferme au prix de faux blocages. */
  if (DENY.has(tool) || segments.some((s) => DENY.has(s)) || MONEY_VERB.test(seg) || MONEY_VERB.test(tool)) {
    process.stdout.write(JSON.stringify({
      action: 'block',
      message: `biii-monitor is READ-ONLY: '${tool}' is a write/spend tool, blocked by policy. ` +
               `Report the finding and delegate a follow-up instead — never write or move value autonomously.`,
    }));
  }
  process.exit(0);                                   // silence = allow
 } catch (e) {
  /* Une exception DANS le garde produisait un process mort sans stdout — et « silence = allow » plus
   * bas signifie que l'appel passait. Le seul moment ou ce garde a le droit d'etre indulgent, c'est
   * jamais: un garde casse doit refuser. */
  process.stdout.write(JSON.stringify({
    action: 'block',
    message: `biii-monitor is READ-ONLY: the guard itself failed (${e && e.message}). Blocking — a broken guard must fail closed, never wave the call through.`,
  }));
  process.exit(0);
 }
});
