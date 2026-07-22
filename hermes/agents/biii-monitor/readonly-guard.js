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
]);

// Backstop for UNKNOWN paid toolsets (e.g. monid, whose tools we can't enumerate until OAuth): block any
// tool whose name carries an unambiguous MONEY / execute verb. `monid.run` / `*.pay` / `*.checkout` spend
// per call — an unattended monitor must never trigger them. Read verbs (discover/inspect/list/get/…) pass.
const MONEY_VERB = /(^|_)(run|pay|buy|purchase|order|checkout|charge|spend|exec|execute|withdraw|deposit|transfer|remit|topup)($|_)/i;

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let tool = '';
  try { tool = String(JSON.parse(raw || '{}').tool_name || ''); } catch { /* malformed → treat as unknown */ }
  const seg = tool.split(/__|[.:/\s]/).pop();       // strip server namespace (., :, /, ws, or __), keep single _ in names
  if (DENY.has(tool) || DENY.has(seg) || MONEY_VERB.test(seg) || MONEY_VERB.test(tool)) {
    process.stdout.write(JSON.stringify({
      action: 'block',
      message: `biii-monitor is READ-ONLY: '${tool}' is a write/spend tool, blocked by policy. ` +
               `Report the finding and delegate a follow-up instead — never write or move value autonomously.`,
    }));
  }
  process.exit(0);                                   // silence = allow
});
