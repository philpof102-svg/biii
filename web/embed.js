/*! BIII trust badge — one script tag, the fail-closed local verdict next to any Base address.
 * ================================================================================================
 * Usage (any web page — marketplace listing, gallery card, escrow UI):
 *   <script src="https://YOUR-BIII-NODE/embed.js" data-address="0x…" async></script>
 * or bind several placements:
 *   <span data-biii-address="0x…"></span> … <script src="…/embed.js" async></script>
 *
 * What it renders (Shadow DOM — no style leaks either way), STRICTLY fail-closed:
 *   ✗ BLOCKED       (red)    — the address is on this node's known-bad floor. Decisive.
 *   ~ NOT ON FLOOR  (yellow) — not known-bad, but NO behavioral score is computed locally; the
 *                              badge NEVER shows green/"safe" (a local read cannot promise that).
 *   ? UNVERIFIED    (grey)   — endpoint unreachable / floor unavailable / malformed address.
 *                              Absence of a verdict is NEVER rendered as safety.
 * Clicking the badge opens the raw /trust JSON — the verdict is re-checkable, not a logo to trust.
 * Non-custodial, advisory. The badge informs a human; it authorizes nothing.
 */
(function () {
  'use strict';
  var me = document.currentScript;
  if (!me) return;
  var origin = (me.getAttribute('data-biii') || (function () { try { return new URL(me.src).origin; } catch (e) { return ''; } })()).replace(/\/$/, '');
  var isAddr = function (s) { return /^0x[0-9a-fA-F]{40}$/.test(String(s || '')); };

  // The three honest states. No green "SAFE" exists by design: this is a LOCAL floor + capped
  // classifier — it can prove "known-bad" and "not on the floor", never "safe".
  var STATES = {
    blocked: { badge: '✗ BLOCKED', bg: '#2a1416', fg: '#f87171', bd: '#f87171', title: 'On the known-bad floor (OFAC/public lists). Do not pay.' },
    caution: { badge: '~ not on known-bad floor', bg: '#221d0f', fg: '#eab308', bd: '#a16207', title: 'Not on this node’s known-bad floor — NOT a clean bill: no behavioral score is computed locally.' },
    unverified: { badge: '? unverified', bg: '#17181d', fg: '#8a8fa0', bd: '#3a3d47', title: 'No verdict available (endpoint unreachable, floor unavailable, or malformed address). Absence of a verdict is not safety.' }
  };

  function stateOf(payload) {
    try {
      var vet = payload && payload.vet;
      if (!vet || vet.floor && vet.floor.available !== true) return 'unverified';   // no floor ⇒ no verdict
      if (vet.screen && vet.screen.blocked === true) return 'blocked';
      return 'caution';                                       // best a LOCAL read can honestly say
    } catch (e) { return 'unverified'; }
  }

  function render(host, addr) {
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var S = STATES.unverified;
    var a = document.createElement('a');
    var url = origin + '/trust?address=' + encodeURIComponent(addr);
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font:600 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;'
      + 'padding:4px 9px;border-radius:999px;text-decoration:none;letter-spacing:.2px;vertical-align:middle;';
    var paint = function (st) {
      S = STATES[st] || STATES.unverified;
      a.textContent = S.badge + ' · BIII';
      a.title = S.title + ' — click to re-check the raw verdict.';
      a.style.background = S.bg; a.style.color = S.fg; a.style.border = '1px solid ' + S.bd;
    };
    paint('unverified');                                       // fail-closed default while loading
    root.appendChild(a);
    if (!isAddr(addr) || !origin) return;                      // stays "unverified" — garbage gets no verdict
    fetch(url).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { paint(stateOf(j)); })
      .catch(function () { paint('unverified'); });            // network failure NEVER upgrades the badge
  }

  // 1) explicit placements: <span data-biii-address="0x…">
  var slots = document.querySelectorAll('[data-biii-address]');
  for (var i = 0; i < slots.length; i++) render(slots[i], slots[i].getAttribute('data-biii-address'));
  // 2) single-address shorthand on the script tag itself: renders right where the tag sits
  var one = me.getAttribute('data-address');
  if (one) { var span = document.createElement('span'); me.parentNode.insertBefore(span, me); render(span, one); }
})();
