'use strict';
/* commit-radar-data — le committeur non attendu de la base d'observations, sur un ARBRE PARTAGÉ.
 *
 * ⚠️ IL N'AVAIT AUCUN TEST, ET IL ÉTAIT BLOQUÉ. Mesure du 2026-07-28: il refusait en disant
 *
 *   « REFUSED — modified files outside the data paths — that is code, and code gets reviewed, not
 *     swept:  M data/token-radar/blackouts.json »
 *
 * Or ce fichier n'est ni du code ni hors de `data/`. C'est un QUATRIÈME fichier de données que le radar
 * s'est mis à écrire, absent de la liste blanche explicite. Le garde avait RAISON de refuser — une liste
 * sans joker est précisément ce qui empêche un fichier que personne n'a voulu publier de partir avec le
 * lot. C'est le MESSAGE qui était faux, et le coût était réel:
 *
 *   609 lignes en base, 437 dans le dernier commit — 172 observations bloquées,
 *   et le blocage était PERMANENT tant que la liste n'était pas mise à jour.
 *
 * Un seul message couvrait deux situations opposées, et la différence est exactement ce qu'il faut
 * faire: ajouter le fichier délibérément, ou relire du code.
 *
 * Run: node test/commit-radar-data.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
/* Requérir ce fichier ne doit lancer AUCUNE commande git — c'est la seule façon de tester un committeur
 * sans en devenir un. Si ce require avait un effet de bord, le test le déclencherait à chaque suite. */
const { classer, valider, DATA_PATHS } = require('../scripts/commit-radar-data.js');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e && e.message)); } };
const m = (file, code = ' M') => ({ code, file });

console.log('commit-radar-data — un arbre partagé se commite par pathspec, jamais par balayage:');

t('★ un fichier de DONNÉES hors liste n est pas classé « du code »', () => {
  const r = classer([m('data/token-radar/NOUVEAU.json')], DATA_PATHS);
  assert.strictEqual(r.duCode.length, 0, 'c est une donnée, pas du code — le geste à faire est différent');
  assert.strictEqual(r.nouvellesDonnees.length, 1);
  assert.strictEqual(r.nouvellesDonnees[0].file, 'data/token-radar/NOUVEAU.json');
});

t('★ un fichier hors de data/ reste du CODE', () => {
  const r = classer([m('lib/asset.js'), m('scripts/quoi.js')], DATA_PATHS);
  assert.strictEqual(r.duCode.length, 2);
  assert.strictEqual(r.nouvellesDonnees.length, 0);
});

t('★ les deux situations sont SÉPARÉES quand elles arrivent ensemble', () => {
  /* Le cas qui compte pour un opérateur: il doit voir les deux gestes, pas un seul message qui en
   * mélange deux. */
  const r = classer([m('lib/asset.js'), m('data/token-radar/NOUVEAU.json')], DATA_PATHS);
  assert.strictEqual(r.duCode.length, 1);
  assert.strictEqual(r.nouvellesDonnees.length, 1);
});

t('★ blackouts.json est DANS la liste — c est ce qui débloquait le committeur', () => {
  /* Ajouté après lecture du contenu: 631 octets, deux enregistrements de trous d observation, aucun
   * secret. Il appartient au même lot que tokens.json — un chiffre tiré d observations ne veut rien dire
   * sans la trace des périodes où l on ne regardait pas. */
  assert.ok(DATA_PATHS.includes('data/token-radar/blackouts.json'));
  const r = classer([m('data/token-radar/blackouts.json'), m('data/token-radar/tokens.json')], DATA_PATHS);
  assert.strictEqual(r.duCode.length, 0);
  assert.strictEqual(r.nouvellesDonnees.length, 0, 'plus rien ne bloque');
  assert.deepStrictEqual(r.aCommiter.sort(),
    ['data/token-radar/blackouts.json', 'data/token-radar/tokens.json']);
});

t('LES DEUX BORNES: la liste reste EXPLICITE — aucun joker, aucun préfixe qui grandit', () => {
  /* La règle qui empêche un secret de voyager: `data/` n est PAS un laissez-passer. Un fichier sous
   * data/ qui n est pas nommé doit rester hors du lot, meme s il est classé comme donnée. */
  const r = classer([m('data/secrets.env.json')], DATA_PATHS);
  assert.strictEqual(r.aCommiter.length, 0, 'être sous data/ ne suffit JAMAIS à être commité');
  assert.strictEqual(r.nouvellesDonnees.length, 1, 'il est signalé, pas balayé');
  for (const p of DATA_PATHS) assert.ok(!/[*?]/.test(p), 'aucun joker dans la liste: ' + p);
});

t('LES DEUX BORNES: un arbre où seuls les fichiers listés bougent ne refuse rien', () => {
  const r = classer(DATA_PATHS.map((f) => m(f)), DATA_PATHS);
  assert.strictEqual(r.duCode.length + r.nouvellesDonnees.length, 0);
  assert.strictEqual(r.aCommiter.length, DATA_PATHS.length);
});

/* ── valider — la fenêtre 0-octet du writer ne doit jamais atteindre un commit ──────────────────────
 *
 * Mesuré le 2026-08-16: `token-radar.js` réécrit `tokens.json` (3,3 Mo) par writeFileSync DIRECT, et
 * 2 lectures sur 30 tombent sur un fichier de ZÉRO octet. Avant `valider`, le committeur horaire pris
 * dans cette fenêtre commitait la base déchirée TELLE QUELLE (prouvé en bac à sable: exit 0, message
 * « could not be summarised — committing the files as they are ») — et `--push` l'aurait publiée.
 * Ces cas écrivent de VRAIS fichiers: `valider` lit le disque, pas une fixture en mémoire. */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'biii-valider-'));
const pose = (rel, contenu) => {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (contenu !== null) fs.writeFileSync(abs, contenu);
  return rel;
};

t('valider: un tokens.json de ZÉRO octet CASSE le lot — la fenêtre mesurée du writer', () => {
  const f = pose('data/token-radar/tokens.json', '');
  const r = valider([f], TMP);
  assert.strictEqual(r.length, 1, 'le fichier vide doit être signalé');
  assert.strictEqual(r[0].file, f);
  assert.ok(r[0].why.length > 0, 'le refus porte sa cause');
});

t('valider: un JSON DÉCHIRÉ (écriture interrompue) casse le lot aussi', () => {
  const f = pose('data/token-radar/scorecard.json', '{"a": {"outcome": "rug');
  assert.strictEqual(valider([f], TMP).length, 1);
});

t('valider: un fichier du lot DISPARU casse le lot — le radar ne supprime jamais sa base', () => {
  const r = valider(['data/token-radar/absent.json'], TMP);
  assert.strictEqual(r.length, 1);
});

t('valider TÉMOIN: un lot entièrement valide passe sans bruit', () => {
  const a = pose('data/token-radar/ok-tokens.json', '{"0xd": {"outcome": "rugged"}}\n');
  const b = pose('data/token-radar/ok-blackouts.json', '[]\n');
  assert.deepStrictEqual(valider([a, b], TMP), []);
});

t('valider BORNE: un .log de zéro octet est LÉGAL — seuls les .json sont jugés', () => {
  /* fleet-refusals.log vide veut dire « aucun refus », pas « fichier déchiré ». Le juger casserait le
   * committeur en permanence sur un état parfaitement sain. */
  const f = pose('data/fleet-refusals.log', '');
  assert.deepStrictEqual(valider([f], TMP), []);
});

t('valider est CÂBLÉ dans le flux, avant le staging — pas seulement exporté', () => {
  /* Un garde exporté mais jamais appelé est le motif « canonical-helper-weaker-copy ». On lit la source:
   * l'appel doit exister entre le calcul de `changed` et le `git add`. Fragile au renommage — c'est
   * voulu: renommer ce garde doit faire relire ce test. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'commit-radar-data.js'), 'utf8');
  const iChanged = src.indexOf('const changed = tracked.filter');
  const iValider = src.indexOf('valider(changed, ROOT)');
  const iAdd = src.indexOf("git('add'");
  assert.ok(iChanged > 0 && iValider > 0 && iAdd > 0, 'les trois repères existent');
  assert.ok(iChanged < iValider && iValider < iAdd, 'valider court APRÈS le tri du lot et AVANT le staging');
  assert.ok(/refuse\(/.test(src.slice(iValider, iValider + 600)), 'un lot cassé se REFUSE, il ne se journalise pas');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
