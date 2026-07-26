'use strict';
// wallet-watch.js — the continuous half of the wallet guard. Diffs each watched address against what was
// recorded last run and reports only what CHANGED. A quiet run prints one line and nothing else, on purpose:
// a monitor that repeats its standing conditions every hour teaches its reader to close it, and a closed
// monitor is worth nothing. $0, deterministic, no LLM, read-only, holds no key.
//
// Set WALLET_WATCH="0xaddr,0xaddr" to change the list.
const { watchWallet } = require('../../lib/wallet-watch');

const CHAIN = process.env.WALLET_WATCH_CHAIN || 'base';
const ADDRESSES = (process.env.WALLET_WATCH ||
  // Phil's drained address: watched because a compromised key means the thief can still act at any time,
  // and because any approval left open there is a second route in.
  '0x47712673daBA17cc2ddEAA285A8aCBA33012e643'
).split(',').map((s) => s.trim()).filter(Boolean);

(async () => {
  const lines = [];
  let alerts = 0, blind = 0;

  for (const addr of ADDRESSES) {
    let r;
    try { r = await watchWallet(CHAIN, addr); } catch (e) { lines.push('  ⚠️ ' + addr.slice(0, 10) + '… — the watch itself failed to run'); blind++; continue; }
    if (!r.ok) { lines.push('  ⚠️ ' + addr.slice(0, 10) + '… — ' + r.reason); blind++; continue; }

    for (const a of r.alerts) {
      alerts++;
      lines.push('  ' + (a.severity === 'high' ? '🚨' : a.severity === 'medium' ? '⚠️ ' : '· ') +
        ' ' + addr.slice(0, 10) + '… ' + a.what);
      for (const n of (a.judgment || [])) lines.push('         · ' + n);
      lines.push('       ' + a.why);
    }
    // Blindness is reported every run, never swallowed: on a wallet monitor an empty alert list reads as
    // "you are safe", so a check that could not run has to be visible or it becomes a lie by omission.
    for (const u of r.unavailable) { blind++; lines.push('  🕳️ ' + addr.slice(0, 10) + '… ' + u); }
    if (r.firstRun) lines.push('       (first run on this address — the above is the baseline, not events)');
  }

  console.log(alerts
    ? '🚨 wallet-watch: ' + alerts + ' change(s) around ' + ADDRESSES.length + ' watched address(es).'
    : '✓ wallet-watch: nothing changed around ' + ADDRESSES.length + ' watched address(es)' +
      (blind ? ' — but ' + blind + ' check(s) could not run, so silence is not proof.' : '.'));
  for (const l of lines) console.log(l);
})();
