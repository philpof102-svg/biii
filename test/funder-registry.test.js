#!/usr/bin/env node
'use strict';
/**
 * The registry's truth table.
 *
 * The rows that matter most are the LEAKAGE ones. This module's entire claim is that its evidence was
 * obtained prequentially — each judgement seeing only strictly earlier history — and that property is
 * invisible in a result. It has to be tested directly, because a replay that quietly consults the future
 * produces exactly the same shape of output, only better.
 */
const assert = require('node:assert');
const { build, assess, replay, VERDICTS } = require('../lib/funder-registry');

const T = (n) => new Date(Date.parse('2026-07-26T00:00:00.000Z') + n * 3600000).toISOString();
const tok = (over) => ({ sym: 'X', firstSeen: T(0), outcome: 'live', ...over });

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('the four states, and none of them is "safe":');
t('a payer with a prior kill is named as such', () => {
  const reg = build([tok({ funder: '0xAAA', outcome: 'rugged', firstSeen: T(0) })]);
  const a = assess(reg, '0xaaa');
  assert.equal(a.verdict, 'funder_has_killed');
  assert.equal(a.priorRugs, 1);
});
t('a payer we have seen but never seen kill is "clean SO FAR", never clean', () => {
  const reg = build([tok({ funder: '0xBBB', outcome: 'live' })]);
  const a = assess(reg, '0xbbb');
  assert.equal(a.verdict, 'funder_clean_so_far');
  assert.match(a.reason, /absence of a bad record, not as a good one/i);
  assert.match(a.reason, /two payers/i, 'the weakness of this side must travel with it');
});
t('a payer never seen gets no judgement at all', () => {
  const a = assess(build([]), '0xCCC');
  assert.equal(a.verdict, 'funder_unseen');
  assert.match(a.reason, /No history means no judgement/i);
});
/* Ce cas exigeait « 45% » DANS la phrase — il epinglait donc le chiffre, pas la propriete, et un chiffre
 * faux le satisfaisait parfaitement. Mesure du 2026-07-29: 373 des 785 tokens suivis n'ont pas de
 * financeur enregistre, mais 360 de ces 373 n'ont JAMAIS ete traces (plafond par run), 11 ont echoue a
 * l'explorateur et 2 seulement n'en avaient reellement aucun. Le 45 % decrivait notre budget, pas la
 * chaine — et token-radar.js l'ecrivait deja en commentaire depuis le 26/07.
 * On epingle desormais les DEUX proprietes qui comptent, et l'absence de toute statistique de couverture
 * presentee comme un fait sur les lancements. */
t('★ un payeur non trace n est ni une absolution NI un constat sur le lancement', () => {
  const a = assess(build([]), null);
  assert.equal(a.verdict, 'funder_untraceable');
  assert.match(a.reason, /NOT a clearance/i, 'la premiere propriete: ce n est pas un feu vert');
  assert.match(a.reason, /not a finding either|never asked|gap in coverage/i,
    'la seconde: ce n est pas non plus une propriete du lancement');
  assert.doesNotMatch(a.reason, /\d+% of the launches/i,
    'aucune statistique de couverture presentee comme un fait sur les lancements');
});

t('★ LES DEUX BORNES: un financeur CONNU rend toujours son verdict chiffre', () => {
  const reg = build([tok({ funder: '0xF00D', outcome: 'rugged' })]);
  const a = assess(reg, '0xF00D');
  assert.equal(a.verdict, 'funder_has_killed', 'sans cette borne, « tout abstenir » passerait le cas ci-dessus');
  assert.ok(a.priorRugs >= 1, 'et les compteurs restent des mesures, pas des null');
});
t('the case is ignored when matching a funder', () => {
  const reg = build([tok({ funder: '0xAbCdEf', outcome: 'rugged' })]);
  assert.equal(assess(reg, '0xABCDEF').verdict, 'funder_has_killed');
});

console.log('\nLEAKAGE — the property that cannot be seen in a result:');
t('replay judges a token on STRICTLY EARLIER history only', () => {
  // One funder, two tokens. The first rugs. If the replay leaked, the FIRST token would already be judged
  // "has killed" by its own outcome — the classic way a backtest reports a signal it never had.
  const rows = [
    tok({ funder: '0xAAA', firstSeen: T(0), outcome: 'rugged' }),
    tok({ funder: '0xAAA', firstSeen: T(1), outcome: 'rugged' }),
  ];
  const r = replay(rows, () => 'rugged');
  assert.equal(r.funder_unseen.rugged, 1, 'the first token had NO history and must land in unseen');
  assert.equal(r.funder_has_killed.rugged, 1, 'only the second one could know');
});
t('a later kill never back-dates onto an earlier token', () => {
  const rows = [
    tok({ funder: '0xAAA', firstSeen: T(0), outcome: 'live' }),
    tok({ funder: '0xAAA', firstSeen: T(1), outcome: 'rugged' }),
    tok({ funder: '0xAAA', firstSeen: T(2), outcome: 'rugged' }),
  ];
  const r = replay(rows, (x) => (x.outcome === 'rugged' ? 'rugged' : 'survived'));
  assert.equal(r.funder_unseen.survived, 1, 'token 1: nothing known');
  assert.equal(r.funder_clean_so_far.rugged, 1, 'token 2: one prior token, no prior kill yet');
  assert.equal(r.funder_has_killed.rugged, 1, 'token 3: the kill is now in the past');
});
t('out-of-order input is sorted before replay, or the protocol means nothing', () => {
  const rows = [
    tok({ funder: '0xAAA', firstSeen: T(2), outcome: 'rugged' }),
    tok({ funder: '0xAAA', firstSeen: T(0), outcome: 'rugged' }),
  ];
  const r = replay(rows, () => 'rugged');
  assert.equal(r.funder_unseen.rugged, 1);
  assert.equal(r.funder_has_killed.rugged, 1);
});

console.log('\nopen outcomes are excluded from the rates AND counted:');
t('a token that has not answered is neither a hit nor a miss', () => {
  const rows = [
    tok({ funder: '0xAAA', firstSeen: T(0), outcome: 'rugged' }),
    tok({ funder: '0xAAA', firstSeen: T(1), outcome: 'live' }),
  ];
  const r = replay(rows, (x) => (x.outcome === 'rugged' ? 'rugged' : 'open'));
  assert.equal(r.funder_has_killed.open, 1);
  assert.equal(r.funder_has_killed.resolved, 0);
  assert.equal(r.funder_has_killed.rate, null, 'no resolved case means no rate to claim');
});

console.log('\nindependence is reported, because 62 observations are not 62 operators:');
t('distinctFunders travels with every bucket', () => {
  const rows = [
    tok({ funder: '0xAAA', firstSeen: T(0), outcome: 'rugged' }),
    tok({ funder: '0xAAA', firstSeen: T(1), outcome: 'rugged' }),
    tok({ funder: '0xAAA', firstSeen: T(2), outcome: 'rugged' }),
    tok({ funder: '0xBBB', firstSeen: T(3), outcome: 'rugged' }),
    tok({ funder: '0xBBB', firstSeen: T(4), outcome: 'rugged' }),
  ];
  const r = replay(rows, () => 'rugged');
  assert.equal(r.funder_has_killed.rugged, 3, 'three tokens landed in the bucket');
  assert.equal(r.funder_has_killed.distinctFunders, 2, 'but they came from only two operators');
});

console.log('\nit claims nothing it cannot support:');
t('an empty database yields no rates at all', () => {
  const r = replay([], () => 'open');
  assert.equal(r.baseRate, null);
  for (const v of VERDICTS) assert.equal(r[v].rate, null);
});
t('tokens with no funder never enter the registry', () => {
  const reg = build([tok({ outcome: 'rugged' }), tok({ funder: '', outcome: 'rugged' })]);
  assert.equal(reg.size, 0);
});
t('the reason names STRUCTURE and refuses intent', () => {
  const reg = build([tok({ funder: '0xAAA', outcome: 'rugged' })]);
  assert.match(assess(reg, '0xAAA').reason, /Structure, not intent/i);
  assert.match(assess(reg, '0xAAA').reason, /never who anyone is/i);
});
t('it is pure — no network, no clock, no disk', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'funder-registry.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(/function replay/.test(code), 'sanity: the comment stripper left the code intact');
  for (const forbidden of ['node:https', 'fetch(', 'Date.now()', 'readFileSync', 'process.env']) {
    assert.ok(!code.includes(forbidden), 'funder-registry.js must not contain ' + forbidden);
  }
});

/* ── la liste de symboles porte son total ───────────────────────────────────────────────────────
 * `symbols` est une ILLUSTRATION plafonnee a douze, et `priorFunded` ne peut pas en tenir lieu: il
 * compte des TOKENS, or un financeur peut en lancer trente sous cinq symboles. Sans `symbolsTotal`,
 * un appelant qui compte la liste ne distingue pas « douze symboles » de « douze montres sur vingt ». */
console.log('\nune liste plafonnee doit dire combien elle cache:');

const nSymboles = (n, over) => Array.from({ length: n }, (_, i) =>
  tok({ funder: '0xCCC', sym: 'S' + i, firstSeen: T(i), ...over }));

t('★ au-dela du plafond, la liste est coupee ET le total voyage', () => {
  const a = assess(build(nSymboles(20, { outcome: 'rugged' })), '0xccc');
  assert.equal(a.symbols.length, 12, 'la liste servie est plafonnee a douze');
  assert.equal(a.symbolsTotal, 20, 'et le VRAI compte de symboles distincts se lit a cote');
});

t('★ `priorFunded` NE PEUT PAS tenir lieu de total — il compte des tokens, pas des symboles', () => {
  /* Vingt tokens lances sous TROIS symboles seulement. C est le cas qui separe les deux quantites, et
   * sans lui on pourrait croire que `priorFunded` suffisait: dans la fixture precedente il vaut 20 comme
   * `symbolsTotal`, par coincidence de construction. Une assertion qui ne peut pas echouer ne prouve
   * rien, et la premiere version de ce cas en etait une. */
  const vingtTokensTroisSymboles = Array.from({ length: 20 }, (_, i) =>
    tok({ funder: '0xDDD', sym: 'S' + (i % 3), firstSeen: T(i), outcome: 'rugged' }));
  const a = assess(build(vingtTokensTroisSymboles), '0xddd');
  assert.equal(a.priorFunded, 20, 'vingt tokens finances');
  assert.equal(a.symbolsTotal, 3, 'mais seulement trois symboles distincts');
  assert.notEqual(a.priorFunded, a.symbolsTotal, 'les deux quantites divergent — l une ne remplace pas l autre');
});

t('★ le cas OPPOSE: sous le plafond, le total EGALE la liste', () => {
  /* Sans ce cas, un `symbolsTotal` cable sur une constante passerait comme le correctif. */
  const a = assess(build(nSymboles(3, { outcome: 'rugged' })), '0xccc');
  assert.equal(a.symbols.length, 3);
  assert.equal(a.symbolsTotal, 3);
});

t('la branche « clean so far » publie le total elle aussi — les deux sorties, pas une', () => {
  const a = assess(build(nSymboles(20, { outcome: 'live' })), '0xccc');
  assert.equal(a.verdict, 'funder_clean_so_far');
  assert.equal(a.symbols.length, 12);
  assert.equal(a.symbolsTotal, 20);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
