'use strict';
// BIII trust triangle — pure composition. Run: node test/trust.test.js
const assert = require('node:assert');
const { assessTriangle, standingVertex, settlementVertex } = require('../lib/trust');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };

const PAID = { paid: true, tier: 'confirmed', txHash: '0x' + 'cd'.repeat(32) };

console.log('BIII trust triangle — three vertices, one fail-closed verdict:');

t('a flag on the counterparty overrides EVERYTHING — never pay', () => {
  const r = assessTriangle({ reputation: { decision: 'REFUSE' }, standing: { paidMicro: '9999999' }, settlement: PAID });
  assert.equal(r.trust, 'unsafe');
  assert.equal(r.payable, false);
});

t('settled = the top state: a verified on-chain payment is proven, whatever else', () => {
  const r = assessTriangle({ reputation: { decision: 'PROCEED', score: 70 }, settlement: PAID });
  assert.equal(r.trust, 'settled'); assert.equal(r.proven, true); assert.equal(r.payable, true);
  assert.equal(r.vertices.settlement.txHash, PAID.txHash);
});

t('trusted (safe to pay) when reputation is safe OR standing is proven, before settlement', () => {
  assert.equal(assessTriangle({ reputation: { decision: 'PROCEED', score: 55 } }).trust, 'trusted');
  assert.equal(assessTriangle({ standing: { paidMicro: '5000000' } }).trust, 'trusted');
  assert.equal(assessTriangle({ standing: { paidMicro: '5000000' } }).vertices.standing.paidUsd, '5.00');
});

t('unknown when there is no positive signal (fail-closed: absence is never trust)', () => {
  const r = assessTriangle({});
  assert.equal(r.trust, 'unknown'); assert.equal(r.payable, false);
  assert.equal(r.vertices.reputation.status, 'unknown');
  /* CHANGED 2026-07-27: this line used to assert 'none', and in doing so it LOCKED IN the defect —
   * it required a never-consulted vertex to report the same verdict as a consulted-and-empty one.
   * A test can protect a bug as firmly as it protects a property. The vertex is now 'unqueried'
   * because assessTriangle({}) passes no standing at all: nobody was asked. */
  assert.equal(r.vertices.standing.status, 'unqueried');
  assert.equal(r.vertices.settlement.status, 'pending');
});

t('a weak score is not safe and not unsafe — it does not by itself make a payment trusted', () => {
  const r = assessTriangle({ reputation: { decision: 'PROCEED', score: 12 } });   // below floor 40
  assert.equal(r.vertices.reputation.status, 'weak');
  assert.equal(r.trust, 'unknown', 'a weak score alone is not enough to trust');
});

t('greens count + a failed settlement never reads as paid', () => {
  const r = assessTriangle({ reputation: { decision: 'PROCEED', score: 90 }, standing: { paidMicro: '3000000' }, settlement: { paid: false, reason: 'underpaid' } });
  assert.equal(r.trust, 'trusted');          // vetted, but the payment itself failed
  assert.equal(r.proven, false);
  assert.equal(r.greens, 2);                 // reputation + standing green, settlement failed
  assert.equal(r.vertices.settlement.status, 'failed');
});

/* ════════════════════════════════════════════════════════════════════════════════════════════════════
 * NOT ASKING IS NOT A FINDING — the three states of the standing vertex.
 *
 * Fixed 2026-07-27. `standingVertex` folded `null` (never consulted) and `paidMicro: 0` (consulted, no
 * history) into ONE verdict with ONE sentence: "no proven history yet". Those are opposite facts — the
 * first is a gap on OUR side, the second is information about the counterparty.
 *
 * Measured on the shipped binary before the fix, with BIII_LAWBOR_URL unset: `till_trust` returned
 * `standing: {status:'none', reason:'no proven history yet'}` while never having made a call. The word
 * LAWBOR appeared nowhere in the output and nothing flagged the missing vertex — a caller read a "trust
 * triangle" computed from two vertices without knowing it.
 *
 * This is the SAME repair already made in rugsignals (`ownerState`: live/renounced/unknown), where a
 * missing owner read as a renounced one and defused live flags. Same fault, one module over, still in
 * place because nobody had gone to look. These tests exist so it cannot come back a third time.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\nnot asking is not a finding: the standing vertex has THREE states');

t('null standing = UNQUERIED, and the reason blames OUR side, not the counterparty', () => {
  const v = standingVertex(null);
  assert.equal(v.status, 'unqueried', 'never consulted must not read as "none"');
  assert.match(v.reason, /not.*set|never asked/i, 'the reason must name the missing configuration');
  assert.match(v.reason, /NOT a statement about the counterparty/i,
    'it must state explicitly that this is NOT a claim about the counterparty');
});

t('an explicit unqueried marker carries ITS OWN reason through', () => {
  const v = standingVertex({ unqueried: true, reason: 'HTTP 503 from the node' });
  assert.equal(v.status, 'unqueried');
  assert.match(v.reason, /503/, 'a node failure must not be flattened into a generic message');
});

/* ⚠️ CE TEST AFFIRMAIT L'INVERSE JUSQU'AU 2026-07-27, et il avait tort.
 * Il posait `standingVertex({ paidMicro: '0' })` puis exigeait 'none' — « consulte, et c'est vide ».
 * Un zero n'est une trouvaille que si le noeud POUVAIT voir autre chose. Le standing est borne par la
 * depense propre du noeud; a spend zero il rend zero pour toute adresse de Base. Mesure sur le noeud de
 * prod: `bound.spendMicro` = "0" — il aurait dit 'none' sur tout le monde, honnetes compris. */
t('un zero SANS borne declaree n\'est pas une trouvaille', () => {
  const v = standingVertex({ paidMicro: '0' });
  assert.strictEqual(v.status, 'uninformative',
    'sans borne on ne peut pas savoir si ce zero est une mesure ou un angle mort');
  assert.match(v.reason, /blind spot|cannot tell/i, 'la raison doit dire ce qui manque');
});

t('un zero d\'un noeud a borne ZERO est un demarrage a froid, pas un verdict', () => {
  const v = standingVertex({ paidMicro: '0', bound: { spendMicro: '0', maxTotalMicro: '0' } });
  assert.strictEqual(v.status, 'uninformative');
  assert.match(v.reason, /every address|cold start/i,
    'il doit dire que ce noeud rend zero pour TOUT LE MONDE — c est ca l information utile');
});

t('un zero d\'un noeud qui a REELLEMENT depense est, lui, une mesure', () => {
  /* La contrepartie de la correction: sans ce cas, `uninformative` avalerait tout et le sommet ne
   * pourrait plus jamais rien affirmer — on aurait remplace un faux positif par une cecite totale. */
  const v = standingVertex({ paidMicro: '0', bound: { spendMicro: '5000000' } });
  assert.strictEqual(v.status, 'none', 'un noeud qui a paye des gens et ne voit rien ici, ca compte');
  assert.match(v.reason, /consulted/i, 'la formulation doit la distinguer de "unqueried"');
});

t('les quatre etats du sommet ont quatre formulations distinctes', () => {
  /* Le defaut d'origine etait deux etats partageant un texte. Le meme piege se rejoue a chaque etat
   * ajoute, donc on verifie l'ensemble plutot que la paire. */
  const raisons = [
    standingVertex(null).reason,
    standingVertex({ paidMicro: '0' }).reason,
    standingVertex({ paidMicro: '0', bound: { spendMicro: '0' } }).reason,
    standingVertex({ paidMicro: '0', bound: { spendMicro: '5000000' } }).reason,
  ];
  assert.strictEqual(new Set(raisons).size, raisons.length,
    'deux etats qui se lisent pareil sont deux etats qu un lecteur confondra');
});

t('une borne illisible ne se devine pas — elle vaut non-declaree', () => {
  const { standingCeiling } = require('../lib/trust.js');
  assert.strictEqual(standingCeiling(null), null);
  assert.strictEqual(standingCeiling({}), null, 'un objet sans champ de borne');
  assert.strictEqual(standingCeiling({ spendMicro: 'abc' }), null, 'une borne non numerique ne vaut pas 0');
  assert.strictEqual(standingCeiling({ spendMicro: '42' }), 42n);
  assert.strictEqual(standingCeiling({ maxTotalMicro: '9' }), 9n, 'repli quand seul maxTotal est publie');
  /* La somme DIRECTE est bornee par spend, pas par (1+alpha)*spend: quand les deux sont la, c est spend
   * qui gouverne, sinon on s autoriserait une borne trop large. */
  assert.strictEqual(standingCeiling({ spendMicro: '3', maxTotalMicro: '99' }), 3n);
});

t('a real paid history still reads as proven', () => {
  const v = standingVertex({ paidMicro: '2500000' });
  assert.equal(v.status, 'proven');
  assert.ok(v.paidUsd, 'the amount must be surfaced for the reader');
});

console.log('\nan incomplete triangle must SAY it is incomplete');

t('an unqueried vertex flips `complete` and names itself', () => {
  const r = assessTriangle({ reputation: null, standing: null, settlement: null });
  assert.equal(r.complete, false, 'two-of-three is not a triangle');
  assert.deepStrictEqual(r.unqueriedVertices, ['standing']);
  assert.match(r.incompleteNote, /INCOMPLETE/);
  assert.match(r.incompleteNote, /not a negative one/i,
    'the note must say a missing vertex is not a negative one');
});

t('a fully read triangle carries NO warning — a permanent banner stops being read', () => {
  const r = assessTriangle({
    reputation: { decision: 'PROCEED', score: 80 },
    /* La borne est ce qui rend ce sommet LU: elle prouve que le noeud aurait pu voir un historique et
     * n en a pas vu. Le meme appel sans borne est desormais `uninformative`, cf. le test suivant. */
    standing: { paidMicro: '0', bound: { spendMicro: '5000000' } },
    settlement: null,
  });
  assert.strictEqual(r.complete, true, 'all three were consulted, even if two answered negatively');
  assert.deepStrictEqual(r.unqueriedVertices, []);
  assert.strictEqual(r.incompleteNote, undefined, 'no note when there is nothing to warn about');
});

t('un sommet UNINFORMATIF compte comme non-lu, comme un sommet absent', () => {
  /* LE COEUR DE LA CORRECTION. Une reponse complete en apparence, qui ne distingue rien, comptait comme
   * un sommet lu: `complete: true`, aucun avertissement, et un lecteur croyait a un triangle a trois
   * sommets. C est plus traitre qu une absence, parce que ca a la forme d une reponse. */
  const r = assessTriangle({
    reputation: { decision: 'PROCEED', score: 80 },
    standing: { paidMicro: '0', bound: { spendMicro: '0' } },
    settlement: null,
  });
  assert.strictEqual(r.complete, false, 'un noeud aveugle ne rend pas le triangle complet');
  assert.deepStrictEqual(r.unqueriedVertices, ['standing']);
  assert.match(r.incompleteNote, /carry no information/i);
  assert.match(r.incompleteNote, /without distinguishing this counterparty/i,
    'la note doit couvrir le cas « a repondu, mais sans rien distinguer », pas seulement « illisible »');
});

/* ── un rail que BIII ne sait pas temoigner (carte, virement, Mastercard Agent Pay) ──────────────── */

t('★ un rail NON OBSERVABLE ne se lit pas « en attente »', () => {
  /* `pending` porte une promesse: « rien vu POUR L'INSTANT, ca va arriver on-chain ». Vrai d'un virement
   * USDC non confirme. FAUX d'une jambe carte: ca n'arrivera jamais, et BIII dirait « en attente » pour
   * toujours a propos d'un paiement deja abouti ailleurs. Question posee le 2026-07-27 a propos d'Agent
   * Pay for Machines, qui regle en cartes, comptes bancaires ET stablecoins. */
  const v = settlementVertex({ offChain: true, rail: 'mastercard-agent-pay' });
  assert.strictEqual(v.status, 'not_observable');
  assert.strictEqual(v.rail, 'mastercard-agent-pay');
  assert.match(v.reason, /cannot witness/i);
  assert.match(v.reason, /NOT "pending"/, 'la difference avec pending doit etre dite, pas devinee');
  assert.match(v.reason, /may well have completed/i,
    'ne pas laisser entendre que le paiement a echoue: on ne sait pas, c est tout');
});

t('★ un rail non observable compte comme NON-LU, donc le triangle s avoue incomplet', () => {
  const r = assessTriangle({
    reputation: { decision: 'PROCEED', score: 80 },
    standing: { paidMicro: '5000000' },
    settlement: { offChain: true, rail: 'carte' },
  });
  assert.strictEqual(r.complete, false);
  assert.deepStrictEqual(r.unqueriedVertices, ['settlement']);
  assert.match(r.incompleteNote, /carry no information/i);
});

t('mais reputation et standing PORTENT encore — sinon BIII serait inutile hors chaine', () => {
  /* La contrepartie: si un rail non observable rendait tout inutilisable, BIII ne servirait a rien devant
   * une carte. Les deux autres sommets ne dependent pas de la chaine et continuent de decider. */
  const r = assessTriangle({
    reputation: { decision: 'PROCEED', score: 80 },
    standing: { paidMicro: '5000000' },
    settlement: { offChain: true, rail: 'carte' },
  });
  assert.strictEqual(r.payable, true, 'vetté a payer par reputation + standing');
  assert.strictEqual(r.proven, false, 'mais JAMAIS prouve: on n a rien vu');
  assert.notStrictEqual(r.trust, 'settled', '« settled » exige une preuve on-chain');
});

t('un drapeau sur la contrepartie l emporte, meme hors chaine', () => {
  const r = assessTriangle({
    reputation: { decision: 'BLOCK' },
    standing: { paidMicro: '5000000' },
    settlement: { offChain: true, rail: 'carte' },
  });
  assert.strictEqual(r.trust, 'unsafe');
  assert.strictEqual(r.payable, false, 'le rail ne change rien a un blocage');
});

t('les quatre etats du sommet settlement sont distincts', () => {
  const etats = [
    settlementVertex({ paid: true, tier: 'confirmed' }).status,
    settlementVertex({ paid: false, reason: 'wrong amount' }).status,
    settlementVertex(null).status,
    settlementVertex({ offChain: true }).status,
  ];
  assert.deepStrictEqual(etats, ['settled', 'failed', 'pending', 'not_observable']);
  assert.strictEqual(new Set(etats).size, 4, 'quatre faits distincts, quatre valeurs');
});

t('uninformative n\'est jamais un vert et ne leve jamais le verdict', () => {
  const froid = assessTriangle({ reputation: null, standing: { paidMicro: '0', bound: { spendMicro: '0' } }, settlement: null });
  assert.strictEqual(froid.trust, 'unknown', 'un noeud aveugle n accorde aucune confiance');
  assert.strictEqual(froid.greens, 0);
  assert.strictEqual(froid.payable, false, 'fail-closed: on ne paie pas sur une absence d information');
});

t('unqueried never counts as a green, and never lifts the verdict', () => {
  const r = assessTriangle({ reputation: null, standing: null, settlement: null });
  assert.equal(r.greens, 0, 'a vertex we did not read cannot be a positive signal');
  assert.equal(r.trust, 'unknown');
  assert.equal(r.payable, false, 'fail-closed: an unread vertex never makes something payable');
});

/* ── LA CONSERVATION S'APPLIQUAIT UNIQUEMENT LA OU ELLE NE POUVAIT RIEN CONTREDIRE ──────────────────
 * `Σ direct ≤ spend(V)` est LA regle de LAWBOR: un noeud ne peut attester plus que sa propre depense
 * irrecuperable. Elle etait ecrite, commentee, et confrontee seulement a la branche ZERO — le `return`
 * du positif etant place AVANT le calcul du plafond, la seule branche capable de la contredire ne la
 * voyait jamais. Mesure du 2026-07-28, avant correctif:
 *
 *     standingVertex({paidMicro:'9000000', bound:{spendMicro:'1'}}) -> {status:'proven', paidUsd:'9.00'}
 *
 * 9,00 USD de standing adosses a une depense d'un millionieme de dollar, promus en preuve. */
t('un standing superieur a la borne du noeud est INEXPLOITABLE, pas prouve', () => {
  const v = standingVertex({ paidMicro: '9000000', bound: { spendMicro: '1' } });
  assert.strictEqual(v.status, 'inconsistent');
  /* Les DEUX nombres sortent: un lecteur doit pouvoir refaire la soustraction sans nous croire. */
  assert.strictEqual(v.paidUsd, '9.00');
  assert.strictEqual(v.boundUsd, '0.000001');
  /* Le controle porte sur le NOEUD, jamais sur la contrepartie — la structure ne prouve pas l'intention. */
  assert.ok(/about the NODE, not about\s+the counterparty/.test(v.reason), 'la raison doit nommer qui est en cause');
});

t('le meme chiffre DANS la borne reste prouve — un fail-closed qui refuse tout n\'informe plus', () => {
  const v = standingVertex({ paidMicro: '9000000', bound: { spendMicro: '9000000' } });
  assert.strictEqual(v.status, 'proven');       // egalite: la borne est atteinte, pas depassee
  assert.strictEqual(v.boundChecked, true);
});

/* Sans borne on NE refuse PAS (un noeud hostile en fabriquerait une; le cout serait l'interoperabilite
 * pour rien). Mais « verification impossible » et « verification passee » ne doivent pas sortir pareil. */
t('sans borne declaree, `proven` porte boundChecked:false — la verification non faite se voit', () => {
  const sans = standingVertex({ paidMicro: '9000000' });
  assert.strictEqual(sans.status, 'proven');
  assert.strictEqual(sans.boundChecked, false);
  /* ⚠️ Ces deux-la doivent DIFFERER. `assert.strictEqual(false, undefined)` echoue, contrairement a la
   * forme lache — c'est precisement la distinction a trois etats qui porte tous nos fail-closed. */
  assert.notStrictEqual(sans.boundChecked, standingVertex({ paidMicro: '9000000', bound: { spendMicro: '9000000' } }).boundChecked);
  /* Une borne ILLISIBLE est traitee comme absente, jamais devinee (standingCeiling rend null). */
  assert.strictEqual(standingVertex({ paidMicro: '9000000', bound: { spendMicro: 'oups' } }).boundChecked, false);
});

/* ⚠️ `paid > ceiling` seul ne suffit PAS: les operateurs relationnels coercent null en 0, donc une borne
 * absente se lirait « borne de zero » et TOUT positif tomberait en `inconsistent`. Constate en retirant
 * la garde: trois cas rouges. Meme famille que Number(null)===0. Ce cas verrouille la garde. */
t('une borne absente n\'est pas une borne de zero (piege de coercion)', () => {
  assert.strictEqual(standingVertex({ paidMicro: '1', bound: null }).status, 'proven');
  assert.strictEqual(standingVertex({ paidMicro: '1', bound: { spendMicro: '0' } }).status, 'inconsistent');
});

/* Le module qui PORTE la discipline des trois etats jetait sur une forme illisible: 'abc', 'n/a', '1.5'
 * remontaient en SyntaxError jusqu'au handler, qui repondait « check arguments » en perdant les deux
 * autres sommets. bin/biii-mcp.js promet pourtant `unqueried` pour une forme qu'on ne comprend pas. */
t('une forme de standing illisible rend `unqueried`, elle ne jette pas', () => {
  for (const brut of ['abc', 'n/a', '1.5', '  ', '9,000000']) {
    const v = standingVertex({ paidMicro: brut, bound: { spendMicro: '9000000' } });
    assert.strictEqual(v.status, 'unqueried', brut + ' devrait etre non-lu');
  }
  /* '0x10' est LISIBLE et vaut 16 — BigInt accepte les litteraux hexadecimaux. Ecrit d'abord comme
   * illisible dans ce test, dementi par la mesure. Epingle ici parce que c'est surprenant: un noeud qui
   * publierait de l'hexa serait lu, pas rejete. L'interpretation reste mathematiquement juste, donc on
   * l'accepte — mais elle est ecrite, pas subie. */
  assert.strictEqual(standingVertex({ paidMicro: '0x10', bound: { spendMicro: '9000000' } }).status, 'proven');
  /* Un champ PRESENT mais vide est illisible, pas zero. `BigInt('  ')` et `BigInt('')` valent tous deux 0n
   * — les espaces sont rognes avant le parse — donc ces deux formes sortaient `none`, une affirmation sur
   * la contrepartie tiree d'un champ vide. Trouve par ce test meme, contre le code que je venais d'ecrire. */
  assert.strictEqual(standingVertex({ paidMicro: '', bound: { spendMicro: '9000000' } }).status, 'unqueried');

  /* Le champ ABSENT, lui, reste la branche zero: c'est le cas « consulte, rien trouve », et l'effacer
   * ferait disparaitre la distinction demarrage-a-froid / mesure que la borne sert justement a trancher. */
  assert.strictEqual(standingVertex({ paidMicro: null, bound: { spendMicro: '9000000' } }).status, 'none');
  assert.strictEqual(standingVertex({ bound: { spendMicro: '9000000' } }).status, 'none');
});

t('un noeud qui se contredit rend le triangle INCOMPLET (il a repondu, il n\'a rien appris)', () => {
  const r = assessTriangle({ reputation: { score: 55 },
    standing: { paidMicro: '9000000', bound: { spendMicro: '1' } }, settlement: null });
  assert.strictEqual(r.complete, false);
  assert.deepStrictEqual(r.unqueriedVertices, ['standing']);
});

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
