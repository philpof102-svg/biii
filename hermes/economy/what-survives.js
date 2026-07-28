'use strict';
/**
 * what-survives.js — the inverted question: of everything we watched, what did the survivors have?
 *
 * Predicting which launch will rug has been a failure so far: warnings on 88% of them, strong warnings on
 * none. But the database is now roughly balanced between tokens that died and tokens that did not, which
 * makes the opposite question answerable — and it is a better question commercially, because a buyer does
 * not want a list of things to avoid, they want the one thing that is safe to touch.
 *
 * Compares the two groups on every feature captured AT FIRST SIGHT, so nothing here uses information that
 * only existed after the outcome was known.
 *
 * Read the output as a hypothesis generator, not a finding. With a sample this size a feature can separate
 * the groups perfectly by chance, and any rule taken from here must still be replayed by
 * backtest-weighting.js before it goes anywhere near a verdict — that is exactly how the last confident
 * rule died.
 *
 * FIRST RESULT, AND IT KILLED ITS OWN BEST CANDIDATE. The medians looked decisive: $11.6k of initial
 * liquidity among the rugs against $43.2k among the survivors, with a mechanism to match — seeded liquidity
 * is what a rug must spend to run, so a large seed is a poor return on a disposable launch. Sweeping a
 * threshold across both groups gave at best 5/8 rugs against 3/8 survivors, barely distinguishable from
 * chance. The raw values show why:
 *
 *   rugged    8124, 9341, 10533, 11592, 11605, 56804, 58231, 479678
 *   survived  7709, 9346, 9945, 18443, 43162, 45190, 56940, 61794
 *
 * They overlap almost entirely. The rugs are BIMODAL — five small launches and three large ones — and the
 * median, whose whole virtue is resisting extreme values, hid exactly the structure that mattered. On eight
 * points the summary statistic was the mistake; reading the list took seconds and settled it.
 *
 * So the honest state of this analysis: nothing in the captured features separates the two groups yet. That
 * is a real finding, and a more useful one than a fabricated signal — it says the radar is currently a
 * RECORDER rather than a predictor, and that its value is the accumulating evidence base, not its verdicts.
 * Anything printed below is a candidate for the next replay, nothing more.
 */
const path = require('node:path');
const db = require(path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json'));

const all = Object.entries(db).map(([addr, t]) => ({ addr, ...t }));
const dead = all.filter((t) => t.outcome === 'rugged');
const alive = all.filter((t) => t.outcome === 'live');

const liveFlags = (t) => (t.flagsAtFirstSight || []).filter((f) => !/^\(defused/i.test(f));
const holdersOf = (t) => {
  const m = liveFlags(t).map((f) => f.match(/only (\d+) holders/)).find(Boolean);
  return m ? Number(m[1]) : null;
};
const pct = (n, d) => d ? Math.round((n / d) * 100) + '%' : '—';
const med = (xs) => { const a = xs.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

/* Un trait peut rendre `null` = PAS MESURÉ sur cette ligne. Ces lignes sortent du dénominateur au lieu
 * d'être comptées comme un « non » — un jugement non résolu n'est ni juste ni faux, et le compter faux
 * dilue exactement le signal qu'on cherche. Le nombre d'exclus est IMPRIMÉ: un taux sur 40 lignes et le
 * même taux sur 570 ne se lisent pas pareil, et cacher le dénominateur est la façon habituelle de faire
 * passer le second pour le premier.
 *
 * ⚠️ `typeof xs[0] === 'boolean'` ne testait QUE le premier élément. Dès qu'un trait rend `null`, une
 * colonne dont la première ligne n'est pas mesurée bascule dans la branche NUMÉRIQUE et calcule une
 * médiane de booléens. Le type était trop pauvre à la frontière: on détecte désormais sur l'ensemble. */
function compare(label, fn, fmt = (v) => String(v)) {
  const d = dead.map(fn), a = alive.map(fn);
  const estBool = [...d, ...a].some((v) => typeof v === 'boolean');
  /* Les exclus sont comptés PAR COLONNE, pas additionnés. Sur ce corpus, 61 % des ruggés ont un
   * financement tracé contre 50 % des vivants: un total unique (« 248 non mesurés ») aurait caché
   * précisément l'asymétrie qui décide si les deux taux sont comparables entre eux. */
  const omis = [];
  const both = [d, a].map((xs) => {
    const lus = xs.filter((v) => v != null);
    omis.push(xs.length - lus.length);
    return estBool ? pct(lus.filter(Boolean).length, lus.length) : fmt(med(lus));
  });
  const mark = both[0] !== both[1] ? ' ←' : '';
  console.log('  ' + label.padEnd(34) + String(both[0]).padStart(10) + '   ' + String(both[1]).padStart(10) + mark
    + (omis[0] + omis[1] ? '   (non mesurés — R:' + omis[0] + ' A:' + omis[1] + ', hors dénominateur)' : ''));
}

/* ⚠️ TOUT CHIFFRE D'ICI PORTE DESORMAIS SON INSTANT. Le 2026-07-28, une comparaison avant/apres a ete
 * faite en deux executions successives de ce script — et `tokens.json` est ecrit par le radar PENDANT
 * qu'on travaille: 570 lignes a 14h25, 579 a 14h28. Les deux moities du delta publie n'avaient donc
 * jamais coexiste. La signature de cette panne est « deux mesures identiques qui divergent », et elle se
 * diagnostique par les mtimes, pas par le code — mais on ne pense a regarder le mtime que si on l'a sous
 * les yeux. C'est pour ca qu'il s'imprime, meme quand personne ne le demande.
 *
 * Un delta entre DEUX versions de code se mesure sur UN instantane lu une seule fois, jamais en relancant
 * le script entre les deux. */
const instantane = require('node:fs').statSync(path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json'));
console.log('== what separates the ' + alive.length + ' survivors from the ' + dead.length + ' that died ==');
console.log('   instantané ' + instantane.mtime.toISOString() + ' — ' + all.length + ' lignes. Le radar écrit');
console.log('   dans ce fichier en continu: un chiffre d\'ici n\'est comparable qu\'à un autre du MÊME instant.\n');
console.log('  ' + 'feature'.padEnd(34) + '     RUGGED' + '      ALIVE');
console.log('  ' + '-'.repeat(58));

compare('initial liquidity (median)', (t) => Math.round(t.firstLiq || 0), (v) => v == null ? '—' : '$' + v.toLocaleString('en-US'));
compare('live flags at first sight', (t) => liveFlags(t).length);
compare('pool withdrawable', (t) => liveFlags(t).some((f) => /liquidity is locked or burned/i.test(f)));
compare('too few holders flagged', (t) => liveFlags(t).some((f) => /only \d+ holders/i.test(f)));
compare('holder count when known', (t) => holdersOf(t));
compare('had NO security data at all', (t) => t.firstVerdict === 'unknown');
/* ⚠️ CE N'EST PAS UN TRAIT DU TOKEN, C'EST NOTRE COUVERTURE. `t.deployer` n'est renseigné que si le
 * traceur a tourné et abouti. Vérifié le 2026-07-28 sur les 570 lignes: `!!t.deployer` et
 * « siblingCount est un nombre » coïncident sur 570/570, zéro divergence — les deux disent « on a tracé
 * cette ligne ». Affiché parmi les traits avec le marqueur « ← », il se lisait « les rugs ont plus
 * souvent un déployeur identifiable (61 % vs 50 %) », alors que l'énoncé vrai est « on a réussi à tracer
 * 61 % des rugs et 50 % des survivants ». Même nombre, autre sujet — et c'est le dénominateur de la
 * ligne « launch factory » juste en dessous, donc il se lit AVEC elle, pas comme un résultat. */
compare('[couverture] financement tracé', (t) => !!t.deployer);
/* `(t.siblingCount || 0) >= 5` comptait comme « pas financé par une usine » TROIS choses distinctes:
 * un financeur réellement solitaire, un balayage que l'explorateur a refusé cette nuit-là, et un token
 * dont le financement n'a jamais été tracé du tout. Les deux derniers ne sont pas des observations —
 * c'est le biais de survivant que nos propres notes signalaient déjà dans le bucket « unknown ». */
compare('funded by a launch factory', (t) => {
  if (t.siblingsRead === false) return null;                  // lecture tentée et manquée
  if (typeof t.siblingCount !== 'number') return null;         // financement jamais tracé
  return t.siblingCount >= 5;
});
compare('deployer wallet was single-use', (t) => t.freshDeployer === true);
compare('found via paid promotion', (t) => t.source === 'boosted');

console.log('\n== the survivors, one by one ==');
for (const t of alive.sort((x, y) => (y.lastLiq || 0) - (x.lastLiq || 0))) {
  const growth = t.firstLiq > 0 ? Math.round(((t.lastLiq - t.firstLiq) / t.firstLiq) * 100) : 0;
  console.log('  ' + String(t.sym || '?').padEnd(22) +
    ('$' + Math.round(t.firstLiq).toLocaleString('en-US')).padStart(10) + ' → ' +
    ('$' + Math.round(t.lastLiq).toLocaleString('en-US')).padStart(10) +
    (growth > 0 ? '  +' + growth + '%' : '  ' + growth + '%').padStart(9) +
    '  | ' + (t.rejudgedVerdict || t.firstVerdict) +
    (t.siblingCount >= 5 ? ' | factory-funded' : '') +
    (t.deployer ? '' : ' | deployer unknown'));
}

console.log('\n  Hypotheses only. A feature can separate ' + dead.length + ' from ' + alive.length + ' by pure chance.');
console.log('  Anything promising goes through backtest-weighting.js before it touches a verdict.');
