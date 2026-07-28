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
  // base-mcp (if ever added) — the absolute never-autonomous set
  'send', 'swap', 'sign', 'send_calls',
  // lawbor — the agent-to-agent economy WRITES (post/offer/bid/settle/block). Descriptor-only, but an
  // unattended monitor must not autonomously speak, list, bid, lock a price, or bind a settlement.
  'lawbor_say', 'lawbor_bot_say', 'lawbor_offer', 'lawbor_post_job', 'lawbor_bid', 'lawbor_confirm',
  'lawbor_quote', 'lawbor_settle', 'lawbor_validate', 'lawbor_block', 'lawbor_unblock', 'lawbor_accept',
]);

// Backstop for UNKNOWN paid toolsets (e.g. monid, whose tools we can't enumerate until OAuth): block any
// tool whose name carries an unambiguous MONEY / execute verb. `monid.run` / `*.pay` / `*.checkout` spend
// per call — an unattended monitor must never trigger them. Read verbs (discover/inspect/list/get/…) pass.
const MONEY_VERB = /(^|_)(run|pay|buy|purchase|order|checkout|charge|spend|exec|execute|withdraw|deposit|transfer|remit|topup)($|_)/i;

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
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
    process.stdout.write(JSON.stringify({
      action: 'block',
      message: 'biii-monitor is READ-ONLY and could NOT identify this tool call'
        + (illisible ? ' (the hook payload did not parse)' : ' (no tool name in the payload)')
        + '. Blocking: a guard that cannot tell what is being called must refuse, not wave it through. '
        + 'If the payload shape changed, update readonly-guard.js — do not disable it.',
    }));
    process.exit(0);
  }
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
});
