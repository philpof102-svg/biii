/*! BIII trust badge — one script tag, a fail-closed verdict next to any Base address OR tokenized asset.
 * ================================================================================================
 * Usage (any web page — marketplace listing, gallery card, escrow UI, tokenized-asset row):
 *   pay-safety of an ADDRESS:      <span data-biii-address="0x…"></span>
 *   authenticity of a TOKEN:       <span data-biii-asset="0x…" data-issuer="Ondo" data-symbol="OUSG"></span>
 *   …then once:                    <script src="https://YOUR-BIII-NODE/embed.js" async></script>
 *   (shorthands on the tag: data-address="0x…" and/or data-asset="0x…" render right where it sits.)
 *
 * ADDRESS badge (/trust) — no green "SAFE" by design: a LOCAL floor can prove "known-bad" / "not on the
 * floor", never "safe":  ✗ BLOCKED (red) · ~ not on known-bad floor (yellow) · ? unverified (grey).
 * ASSET badge (/asset) — here "genuine" IS a positive fact (the contract matches a VERIFIED issuer in the
 * registry), so green is honest:  ✓ genuine (green) · ✗ IMPERSONATION (red, the dangerous case) ·
 *   ✗ unsafe (red, denylisted) · ~ unknown (grey, unverified — never a false "genuine") · ? unverified (grey).
 * Shadow DOM (no style leak either way). Clicking opens the raw JSON — re-checkable, not a logo to trust.
 * Non-custodial, advisory. The badge informs a human; it authorizes nothing.
 */
(function () {
  'use strict';
  var me = document.currentScript;
  if (!me) return;
  var origin = (me.getAttribute('data-biii') || (function () { try { return new URL(me.src).origin; } catch (e) { return ''; } })()).replace(/\/$/, '');
  var isAddr = function (s) { return /^0x[0-9a-fA-F]{40}$/.test(String(s || '')); };
  var enc = encodeURIComponent;

  var TRUST_STATES = {
    blocked: { badge: '✗ BLOCKED', bg: '#2a1416', fg: '#f87171', bd: '#f87171', title: 'On the known-bad floor (OFAC/public lists). Do not pay.' },
    caution: { badge: '~ not on known-bad floor', bg: '#221d0f', fg: '#eab308', bd: '#a16207', title: 'Not on this node’s known-bad floor — NOT a clean bill: no behavioral score is computed locally.' },
    unverified: { badge: '? unverified', bg: '#17181d', fg: '#8a8fa0', bd: '#3a3d47', title: 'No verdict available (endpoint unreachable, floor unavailable, or malformed address). Absence of a verdict is not safety.' }
  };
  var ASSET_STATES = {
    genuine: { badge: '✓ genuine', bg: '#0f2318', fg: '#16C784', bd: '#16794a', title: 'Contract matches a VERIFIED issuer in the registry (registry-sourced — re-verify on-chain).' },
    impersonation: { badge: '✗ IMPERSONATION', bg: '#2a1416', fg: '#f87171', bd: '#f87171', title: 'This contract is NOT the claimed issuer’s — a lookalike/impersonator. Do not acquire.' },
    unsafe: { badge: '✗ unsafe', bg: '#2a1416', fg: '#f87171', bd: '#f87171', title: 'Contract is denylisted (scam / known-bad).' },
    unknown: { badge: '~ unknown', bg: '#221d0f', fg: '#eab308', bd: '#a16207', title: 'Not a verified issuer contract — unverified. Never assume genuine.' },
    unverified: { badge: '? unverified', bg: '#17181d', fg: '#8a8fa0', bd: '#3a3d47', title: 'No verdict available (endpoint unreachable or malformed contract). Absence of a verdict is not authenticity.' }
  };

  function trustStateOf(payload) {
    try {
      var vet = payload && payload.vet;
      if (!vet || (vet.floor && vet.floor.available !== true)) return 'unverified';   // no floor ⇒ no verdict
      if (vet.screen && vet.screen.blocked === true) return 'blocked';
      return 'caution';                                        // best a LOCAL read can honestly say
    } catch (e) { return 'unverified'; }
  }
  function assetStateOf(payload) {
    try {
      var v = payload && payload.verdict; if (!v) return 'unverified';
      if (v.status === 'genuine') return 'genuine';
      if (v.status === 'impersonation') return 'impersonation';
      if (v.status === 'unsafe') return 'unsafe';
      return 'unknown';                                        // unknown/invalid → never a false "genuine"
    } catch (e) { return 'unverified'; }
  }

  // KIND config: how to build the URL, which state map, how to read the payload.
  var KINDS = {
    trust: { states: TRUST_STATES, read: trustStateOf, url: function (v) { return origin + '/trust?address=' + enc(v); } },
    asset: { states: ASSET_STATES, read: assetStateOf, url: function (v, opts) {
      var u = origin + '/asset?token=' + enc(v);
      if (opts.issuer) u += '&claimedIssuer=' + enc(opts.issuer);
      if (opts.symbol) u += '&claimedSymbol=' + enc(opts.symbol);
      return u;
    } }
  };

  function render(host, value, kind, opts) {
    var K = KINDS[kind]; opts = opts || {};
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var url = K.url(value, opts);
    var a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font:600 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;'
      + 'padding:4px 9px;border-radius:999px;text-decoration:none;letter-spacing:.2px;vertical-align:middle;';
    var paint = function (st) {
      var S = K.states[st] || K.states.unverified;
      a.textContent = S.badge + ' · BIII';
      a.title = S.title + ' — click to re-check the raw verdict.';
      a.style.background = S.bg; a.style.color = S.fg; a.style.border = '1px solid ' + S.bd;
    };
    paint('unverified');                                       // fail-closed default while loading
    root.appendChild(a);
    if (!isAddr(value) || !origin) return;                     // garbage gets no verdict — stays "unverified"
    fetch(url).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { paint(K.read(j)); })
      .catch(function () { paint('unverified'); });            // network failure NEVER upgrades the badge
  }

  // explicit placements
  var addrs = document.querySelectorAll('[data-biii-address]');
  for (var i = 0; i < addrs.length; i++) render(addrs[i], addrs[i].getAttribute('data-biii-address'), 'trust');
  var assets = document.querySelectorAll('[data-biii-asset]');
  for (var k = 0; k < assets.length; k++) render(assets[k], assets[k].getAttribute('data-biii-asset'), 'asset',
    { issuer: assets[k].getAttribute('data-issuer'), symbol: assets[k].getAttribute('data-symbol') });
  // shorthands on the script tag itself
  var oneAddr = me.getAttribute('data-address');
  if (oneAddr) { var s1 = document.createElement('span'); me.parentNode.insertBefore(s1, me); render(s1, oneAddr, 'trust'); }
  var oneAsset = me.getAttribute('data-asset');
  if (oneAsset) { var s2 = document.createElement('span'); me.parentNode.insertBefore(s2, me); render(s2, oneAsset, 'asset',
    { issuer: me.getAttribute('data-issuer'), symbol: me.getAttribute('data-symbol') }); }
})();
