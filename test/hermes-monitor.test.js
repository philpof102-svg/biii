'use strict';
// biii-monitor scan engine — the surveillance core (scanWatchlist) is fail-closed: it flags known-bad
// wallets + impersonation/unsafe tokens, and NEVER alerts on clean or merely-unverified items. Each flag
// carries a delegate task (Hermes task-delegation). Offline. Run: node test/hermes-monitor.test.js
const assert = require('node:assert');
const { scanWatchlist } = require('../hermes/agents/biii-monitor/scan');
const { loadScreen } = require('../lib/screen');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const BAD = '0x' + 'de'.repeat(20), CLEAN = '0x' + 'c1'.repeat(20);
const REAL = '0x' + '1a'.repeat(20);           // a genuine issuer token in the registry
const FLOOR = loadScreen({ asOf: '2026-07-22', sources: ['t'], addresses: [BAD] });
const REGISTRY = [{ issuer: 'Dinari', symbol: 'AAPL', name: 'Apple - Dinari', chainId: 8453, address: REAL, source: 'issuer: factory (verified)' }];

console.log('biii-monitor scan engine (surveillance, fail-closed, delegating):');

t('flags a KNOWN-BAD wallet and attaches a delegate task', () => {
  const r = scanWatchlist({ addresses: [BAD] }, { floor: FLOOR, registry: REGISTRY });
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].verdict, 'known-bad');
  assert.match(r.flags[0].delegate, /trace.*counterpart/i, 'a follow-up is delegated, not just alerted');
});

t('flags an IMPERSONATION token (real contract, wrong claimed issuer) with a look-alike investigation', () => {
  const r = scanWatchlist({ tokens: [{ address: REAL, claimedIssuer: 'BlackRock' }] }, { floor: FLOOR, registry: REGISTRY });
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].verdict, 'impersonation');
  assert.match(r.flags[0].delegate, /deployer|drained|look-alike/i);
});

t('does NOT alert on a clean wallet or a genuine token (a monitor raises the alarm on threats, not silence)', () => {
  const r = scanWatchlist({ addresses: [CLEAN], tokens: [{ address: REAL, claimedSymbol: 'AAPL' }] }, { floor: FLOOR, registry: REGISTRY });
  assert.equal(r.flags.length, 0, 'clean wallet + genuine token → zero flags');
  assert.equal(r.checked, 2);
  assert.match(r.brief, /clean/i);
});

t('an UNKNOWN (unverified) token is not a flag either — fail-closed, but not a false alarm', () => {
  const r = scanWatchlist({ tokens: [{ address: '0x' + 'ab'.repeat(20) }] }, { floor: FLOOR, registry: REGISTRY });
  assert.equal(r.flags.length, 0, 'unknown ≠ threat; it is surfaced as unverified elsewhere, not alerted here');
});

t('malformed watchlist never throws; a mixed list flags only the threats', () => {
  assert.doesNotThrow(() => scanWatchlist(null, { floor: FLOOR, registry: REGISTRY }));
  const r = scanWatchlist({ addresses: [BAD, CLEAN], tokens: [{ address: REAL, claimedIssuer: 'X' }, { address: REAL, claimedSymbol: 'AAPL' }] }, { floor: FLOOR, registry: REGISTRY });
  assert.equal(r.flags.length, 2, 'the known-bad wallet + the impersonation; the clean wallet + genuine token stay quiet');
});

/* ════════════════════════════════════════════════════════════════════════════════════════════════════
 * LE GARDE QUI PORTE LA PROMESSE « PROVABLY READ-ONLY » N'AVAIT AUCUN TEST.
 *
 * `hermes/agents/biii-monitor/readonly-guard.js` est le hook `pre_tool_call` qui rend le moniteur non
 * attendu incapable d'ecrire ou de bouger de la valeur — il survit meme a `/yolo`. Rien ne le
 * verifiait. Mesure du 2026-07-28 en EXECUTANT le script, cinq fail-open:
 *
 *   JSON malforme -> AUTORISE   tool_name absent -> AUTORISE   stdin vide -> AUTORISE
 *   tool_name:null -> AUTORISE  wallet.send.now  -> AUTORISE
 *
 * Les quatre premiers sont le motif de la journee applique a un garde de securite: une entree NON LUE
 * devenait une PERMISSION, parce que la fin du fichier pose « silence = allow » et que le `catch`
 * laissait le nom vide. Le risque realiste n'est pas le JSON casse: c'est qu'une mise a jour de Hermes
 * RENOMME `tool_name`. Le garde autoriserait alors tout, pour toujours, sans un signal.
 *
 * On appelle le VRAI script par stdin — c'est son contrat exact, un hook qui lit stdin et ecrit stdout.
 */
const { execFileSync } = require('node:child_process');
const GARDE = require('node:path').join(__dirname, '..', 'hermes', 'agents', 'biii-monitor', 'readonly-guard.js');
const passeGarde = (entree) => {
  const out = execFileSync(process.execPath, [GARDE], { input: entree, encoding: 'utf8' });
  return out.trim() ? 'block' : 'allow';
};
const appel = (nom, champ = 'tool_name') => JSON.stringify({ [champ]: nom });

t('★ un payload ILLISIBLE bloque — une entree non lue n est pas une permission', () => {
  for (const [nom, entree] of [['JSON malforme', '{pas du json'], ['stdin vide', ''],
    ['tool_name absent', JSON.stringify({ outil: 'send' })], ['tool_name null', appel(null)]]) {
    assert.strictEqual(passeGarde(entree), 'block', nom + ' doit BLOQUER');
  }
});

t('★ un champ RENOMME ne desarme pas le garde', () => {
  /* Le scenario realiste: Hermes renomme `tool_name`. Avant, le garde autorisait tout en silence. */
  assert.strictEqual(passeGarde(appel('send', 'toolName')), 'block');
  assert.strictEqual(passeGarde(appel('send', 'tool')), 'block');
  /* Et un nom qu on ne sait pas lire du tout bloque plutot que de passer. */
  assert.strictEqual(passeGarde(JSON.stringify({ tool_name: { objet: 'send' } })), 'block');

  /* ⚠️ CE CAS EXISTE PARCE QU UNE MUTATION EST RESTEE MUETTE. Asserter seulement « bloque » sur un champ
   * renomme passe AUSSI quand le garde ne reconnait rien: il bloque alors pour « nom introuvable ». Les
   * deux sont surs, donc le test ne prouvait pas la propriete que le code ajoute.
   * Ce que les noms alternatifs achetent VRAIMENT: apres un renommage, le moniteur reste UTILISABLE —
   * les lectures continuent de passer. Sans eux, tout bloque, y compris les lectures, et le premier
   * reflexe de quelqu un sera de retirer le hook: on perdrait la protection entiere. */
  assert.strictEqual(passeGarde(appel('till_trust', 'toolName')), 'allow',
    'apres un renommage du champ, une LECTURE doit encore passer');
  assert.strictEqual(passeGarde(appel('till_vet_merchant', 'tool')), 'allow');
});

t('★ le message de blocage dit de CORRIGER le garde, pas de le desactiver', () => {
  const out = execFileSync(process.execPath, [GARDE], { input: '{casse', encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.strictEqual(j.action, 'block');
  assert.match(j.message, /could NOT identify this tool call/i);
  assert.match(j.message, /do not disable it/i, 'sinon le premier reflexe sera de retirer le hook');
});

t('★ un verbe dangereux au MILIEU d un nom pointe est attrape', () => {
  /* `.pop()` ne regardait que le dernier segment, et `send`/`swap`/`sign` vivent dans DENY, pas dans la
   * regex de verbes. `wallet.send.now` passait. DENY est teste sur CHAQUE segment desormais. */
  assert.strictEqual(passeGarde(appel('wallet.send.now')), 'block');
  assert.strictEqual(passeGarde(appel('a.swap.b')), 'block');
});

t('les ecritures connues restent bloquees, sous toutes les formes de namespace', () => {
  for (const n of ['send', 'swap', 'sign', 'send_calls', 'mcp__base-mcp__send', 'till_create_charge',
    'till_create_invoice', 'lawbor_settle', 'pr_merge', 'ucan_delegate', 'monid.run', 'x.pay']) {
    assert.strictEqual(passeGarde(appel(n)), 'block', n + ' doit rester bloque');
  }
});

t('★ LES DEUX BORNES: les LECTURES passent — un garde qui bloque tout se fait desactiver', () => {
  /* La borne qui compte autant que l autre. Un fail-closed pousse jusqu a bloquer les lectures rend le
   * moniteur inutile, et quelqu un retire le hook — on perd alors la protection entiere. */
  for (const n of ['till_trust', 'till_vet_merchant', 'till_rug_powers', 'mcp__gitlawb__repo_get',
    'lawbor_read', 'till_verify_delivery', 'till_resolve']) {
    assert.strictEqual(passeGarde(appel(n)), 'allow', n + ' est une LECTURE et doit passer');
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
