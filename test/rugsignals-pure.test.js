#!/usr/bin/env node
'use strict';
/**
 * rugsignals — les fonctions pures que personne ne testait.
 *
 * POURQUOI CE FICHIER
 * Couverture V8 du 2026-07-27: 51 % sur lib/rugsignals.js, le plus gros module du depot (373 lignes) et le
 * moteur de verdict lui-meme. `owner-state.test.js` couvre les trois etats du proprietaire (12 tests), mais
 * QUATRE fonctions exportees n'etaient appelees par aucun test:
 *
 *     lpLockedShare  topWalletShare  ownerIsLive  assessFromSimulationOnly
 *
 * Les deux premieres sont les signaux de concentration — les ENTREES du verdict. La derniere porte
 * l'invariant le plus fort du fichier, et il n'etait verrouille par rien.
 *
 * L'INVARIANT EN QUESTION
 * `assessFromSimulationOnly` ne rend JAMAIS `clean`. Sa raison est ecrite dans le module: on peut dire
 * qu'une vente passe aujourd'hui, on ne peut pas dire qui aura le droit de changer ca demain. Un token
 * frais qui se vend bien n'est pas sur, il est JEUNE — et l'ecart entre les deux est exactement l'endroit
 * ou l'argent se perd. Un refactor ajoutant une branche `clean` passerait la suite en vert.
 */
const assert = require('node:assert');
const R = require('../lib/rugsignals.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

console.log('concentration: absence de donnee != absence de risque');

t('lpLockedShare rend null quand il n y a PAS de donnee, jamais 0', () => {
  /* La distinction fait tout: 0 veut dire "j ai regarde, rien n est verrouille" et null veut dire "je n ai
   * pas pu regarder". Les confondre ferait passer un pool non observe pour un pool ouvert — ou l inverse,
   * selon le sens de la faute. Ici le module choisit null, et l appelant doit le traiter en inconnu. */
  assert.equal(R.lpLockedShare({}), null, 'champ absent');
  assert.equal(R.lpLockedShare({ lp_holders: [] }), null, 'tableau vide');
  assert.equal(R.lpLockedShare({ lp_holders: null }), null, 'null explicite');
  assert.equal(R.lpLockedShare({ lp_holders: 'pas un tableau' }), null, 'type inattendu');
});

t('lpLockedShare rend 0 quand il a regarde et que rien n est verrouille', () => {
  const r = R.lpLockedShare({ lp_holders: [{ percent: '0.9', is_locked: 0 }, { percent: '0.1', is_locked: 0 }] });
  assert.equal(r, 0, 'observe et non verrouille = 0, pas null');
});

t('lpLockedShare additionne is_locked ET les adresses de burn', () => {
  const r = R.lpLockedShare({ lp_holders: [
    { percent: '0.40', is_locked: 1 },                       // verrouille par un locker
    { percent: '0.35', tag: 'Burn Address' },                // brule
    { percent: '0.05', tag: 'null address' },                // brule aussi
    { percent: '0.20', is_locked: 0 },                       // libre
  ] });
  assert.ok(Math.abs(r - 0.80) < 1e-9, 'attendu 0.80, vu ' + r);
});

t('is_locked accepte les trois formes que GoPlus renvoie', () => {
  for (const v of ['1', 1, true]) {
    assert.equal(R.lpLockedShare({ lp_holders: [{ percent: '1', is_locked: v }] }), 1, 'forme ' + JSON.stringify(v));
  }
  for (const v of ['0', 0, false, undefined]) {
    assert.equal(R.lpLockedShare({ lp_holders: [{ percent: '1', is_locked: v }] }), 0, 'forme ' + JSON.stringify(v));
  }
});

t('topWalletShare rend null sans donnee, et 0 si tous les holders sont des CONTRATS', () => {
  assert.equal(R.topWalletShare({}), null, 'champ absent -> inconnu');
  assert.equal(R.topWalletShare({ holders: [] }), null, 'vide -> inconnu');
  // Un pool, un locker, un bridge ne sont pas des vendeurs. Zero wallet detenteur est une REPONSE.
  const r = R.topWalletShare({ holders: [{ percent: '0.9', is_contract: 1 }, { percent: '0.1', is_contract: true }] });
  assert.equal(r, 0, 'observe, aucun wallet -> 0 et non null');
});

t('topWalletShare rend le MAXIMUM des wallets, pas leur somme', () => {
  /* La question est "un seul portefeuille peut-il vider le marche", pas "combien pesent les portefeuilles
   * ensemble". Sommer transformerait une distribution saine en alerte. */
  const r = R.topWalletShare({ holders: [
    { percent: '0.20' }, { percent: '0.31' }, { percent: '0.15' },
    { percent: '0.90', is_contract: 1 },                     // le pool: ignore
  ] });
  assert.equal(r, 0.31, 'le plus gros WALLET, pas la somme (0.66) ni le contrat (0.90)');
});

t('un pourcentage illisible compte pour 0 au lieu de casser le calcul', () => {
  const r = R.topWalletShare({ holders: [{ percent: 'n/a' }, { percent: '0.12' }] });
  assert.equal(r, 0.12, 'la valeur illisible ne doit ni propager NaN ni ecraser la bonne');
  assert.ok(!Number.isNaN(r));
});

/* ════════════════════════════════════════════════════════════════════════════════════════════════════
 * DES WALLETS QU'ON N'A PAS SU LIRE NE SONT PAS DES WALLETS QUI NE DETIENNENT RIEN.
 *
 * `num(h.percent) || 0` repliait une part ILLISIBLE sur zero, et zero est la valeur la plus rassurante
 * que `topWalletShare` sache rendre. Mesure du 2026-07-28 AVANT correctif, via assessRugFields:
 *
 *     holders:[{is_contract:0}]  ->  topWalletPct: 0, flags: [], unknowns SANS 'holder distribution'
 *
 * soit, octet pour octet, la sortie d'un jeton dont la distribution a ete verifiee et va bien. Le lecteur
 * ne pouvait pas distinguer « verifie » de « pas su lire » — une absence devenue affirmation.
 *
 * Les deux bornes sont epinglees ici. Un fail-closed qui rendrait `null` des qu'une part manque effacerait
 * le zero LEGITIME (tous les holders sont des contrats: chaque part a bien ete lue) et les concentrations
 * REELLEMENT faibles, et cesserait donc d'informer. Les deux cas rassurants sont donc testes a cote du cas
 * hostile — sinon un sur-durcissement passerait pour un correctif. */
t('des wallets dont AUCUNE part n\'est lisible rendent null (inconnu), jamais 0 (rassurant)', () => {
  for (const part of [{}, { percent: 'n/a' }, { percent: '' }, { percent: null }, { percent: '  ' }]) {
    const h = Object.assign({ is_contract: 0 }, part);
    assert.strictEqual(R.topWalletShare({ holders: [h] }), null,
      'part illisible ' + JSON.stringify(part) + ' -> inconnu, pas « aucune concentration »');
  }
});

t('BORNE INVERSE: les zeros et les faibles concentrations REELS survivent au durcissement', () => {
  /* Tous les holders sont des CONTRATS (pool, locker, bridge): chaque part a ete lue, aucune n'appartient
   * a un portefeuille. C'est une REPONSE, et elle doit rester 0 — pas null. */
  assert.strictEqual(R.topWalletShare({ holders: [{ percent: '0.9', is_contract: 1 }] }), 0,
    'lu, aucun wallet detenteur -> 0 reste un vrai zero');
  /* Une distribution reellement saine reste un CHIFFRE, sinon le signal ne dit plus rien de personne. */
  assert.strictEqual(R.topWalletShare({ holders: [{ percent: '0.05' }, { percent: '0.03' }] }), 0.05);
  /* Une seule ligne sale ne doit pas effacer un drapeau porte par une ligne propre. */
  assert.strictEqual(R.topWalletShare({ holders: [{ percent: 'n/a' }, { percent: '0.90' }] }), 0.90);
});

t('PAR LE PRODUCTEUR: assessRugFields REPORTE la distribution comme inconnue au lieu de se taire', () => {
  /* Le test qui compte: `topWalletShare` pourrait rendre null sans que personne ne le dise au lecteur.
   * On passe donc par assessRugFields — le producteur du verdict — et on regarde ce qui est PUBLIE. */
  const ligne = (holders) => ({ owner_address: '0x' + '0'.repeat(40), lp_holders: [{ percent: '1', is_locked: 1 }],
    holder_count: '500', holders });

  const illisible = R.assessRugFields(ligne([{ is_contract: 0 }]), null);
  assert.strictEqual(illisible.topWalletPct, null, 'aucun chiffre de concentration n\'est invente');
  assert.ok(illisible.unknowns.includes('holder distribution'),
    'et le verdict DIT qu\'il ne sait pas — c\'est la difference entre un trou et une affirmation');

  /* Le meme verdict, sur une distribution reellement mesuree et saine: aucun inconnu sur cet axe. */
  const mesure = R.assessRugFields(ligne([{ percent: '0.05', is_contract: 0 }]), null);
  assert.strictEqual(mesure.topWalletPct, 0.05);
  assert.strictEqual(mesure.unknowns.includes('holder distribution'), false,
    'une mesure reelle ne doit PAS etre rangee dans les inconnus');

  /* Et un vrai gros portefeuille leve toujours son drapeau. */
  const gros = R.assessRugFields(ligne([{ percent: '0.90', is_contract: 0 }]), null);
  assert.strictEqual(gros.topWalletPct, 0.90);
  assert.ok(gros.flags.some((f) => /one wallet holds/.test(f)), 'le drapeau de concentration tient encore');
});

t('ownerIsLive est exactement ownerState() === live, sur les trois etats', () => {
  const cas = [
    [{ owner_address: '0x' + 'a'.repeat(40) }, 'live', true],
    [{ owner_address: '0x' + '0'.repeat(40) }, 'renounced', false],
    [{ owner_address: '0x000000000000000000000000000000000000dead' }, 'renounced', false],
    [{ owner_address: '' }, 'unknown', false],
    [{}, 'unknown', false],
  ];
  for (const [r, etat, live] of cas) {
    assert.equal(R.ownerState(r), etat, JSON.stringify(r));
    assert.equal(R.ownerIsLive(r), live, JSON.stringify(r) + ' -> ownerIsLive');
  }
});

console.log('\nsimulation seule: "ca se vend" n est pas "c est sur"');

t('assessFromSimulationOnly ne rend JAMAIS clean — balaye sur 200+ combinaisons', () => {
  /* L invariant central du chemin fresh-launch. Balaye plutot que teste sur trois cas, parce qu une
   * branche clean ajoutee par megarde se cacherait justement dans la combinaison qu on n aurait pas ecrite. */
  const vus = new Set();
  let n = 0;
  for (const honeypot of [true, false, undefined]) {
    for (const sellTax of [null, 0, 5, 10, 49, 50, 99]) {
      for (const buyTax of [null, 0, 9, 10, 80]) {
        for (const holders of [null, 0, 49, 50, 5000]) {
          for (const flags of [[], ['proxy'], ['blacklist', 'mint']]) {
            const v = R.assessFromSimulationOnly({ ok: true, honeypot, sellTax, buyTax, holders, flags });
            vus.add(v.verdict); n++;
            assert.notEqual(v.verdict, 'clean',
              'clean rendu pour ' + JSON.stringify({ honeypot, sellTax, buyTax, holders, flags }));
            assert.equal(v.simulationOnly, true, 'le drapeau simulationOnly doit toujours etre pose');
          }
        }
      }
    }
  }
  assert.ok(n >= 200, 'balayage trop maigre: ' + n + ' combinaisons');
  assert.ok(!vus.has('clean'), 'verdicts vus: ' + [...vus].join(', '));
});

t('un honeypot confirme par la simulation est rug_ready, quoi qu il arrive par ailleurs', () => {
  const v = R.assessFromSimulationOnly({ ok: true, honeypot: true, sellTax: 0, holders: 100000, flags: [] });
  assert.equal(v.verdict, 'rug_ready');
  assert.match(v.reason, /HONEYPOT/);
  assert.equal(v.armed.length, 1, 'le honeypot est un pouvoir ARME, pas un simple drapeau');
});

t('une taxe de vente fatale est ARMEE, une taxe extractive n est qu un drapeau', () => {
  const fatal = R.assessFromSimulationOnly({ ok: true, honeypot: false, sellTax: R.SELL_TAX_FATAL * 100, flags: [] });
  assert.equal(fatal.verdict, 'rug_ready', 'au seuil fatal (' + R.SELL_TAX_FATAL * 100 + '%) c est arme');
  assert.equal(fatal.armed.length, 1);

  const extractif = R.assessFromSimulationOnly({ ok: true, honeypot: false, sellTax: R.SELL_TAX_EXTRACTIVE * 100, flags: [] });
  assert.equal(extractif.armed.length, 0, 'extractif n est pas arme');
  assert.ok(extractif.flags.length >= 1, 'mais c est un drapeau');
  assert.notEqual(extractif.verdict, 'rug_ready');
});

t('sans simulation exploitable, le verdict est unknown — pas caution', () => {
  /* Fail-closed. `caution` dirait "j ai regarde et c est moyen"; ici on n a rien regarde du tout. */
  for (const sim of [null, undefined, { ok: false }, { ok: false, honeypot: true }]) {
    const v = R.assessFromSimulationOnly(sim);
    assert.equal(v.verdict, 'unknown', JSON.stringify(sim));
    assert.deepStrictEqual(v.unknowns, ['*'], 'tout est inconnu, et ca doit se voir dans le champ');
  }
});

t('les inconnus structurels sont TOUJOURS declares sur ce chemin', () => {
  // owner, LP lock, distribution: aucun des trois n est observable par une simulation de trade. Les taire
  // ferait passer un verdict `caution` pour un examen complet.
  const v = R.assessFromSimulationOnly({ ok: true, honeypot: false, sellTax: 1, flags: [] });
  assert.ok(v.unknowns.length >= 3, 'au moins owner + LP + distribution');
  assert.equal(v.lpLockedPct, null, 'aucun chiffre de LP ne doit etre invente');
  assert.equal(v.topWalletPct, null, 'aucun chiffre de concentration non plus');
});

console.log('\nl echelle des verdicts: chaque cran est une frontiere');

const ligneNeutre = { owner_address: '0x' + '0'.repeat(40) };   // renonce: aucun pouvoir armable

t('un pouvoir ARME bat tout le reste', () => {
  const v = R.assessRugFields({ owner_address: '0x' + 'a'.repeat(40), is_honeypot: '1' }, null);
  assert.equal(v.verdict, 'rug_ready');
  assert.ok(v.armed.length >= 1);
});

t('la frontiere caution/high_risk est a TROIS drapeaux', () => {
  const v = R.assessRugFields(ligneNeutre, null);
  // On ne fabrique pas de drapeaux a la main: on verifie que la regle lue est celle appliquee.
  const attendu = v.armed.length ? 'rug_ready'
    : v.flags.length >= 3 ? 'high_risk'
    : v.flags.length ? 'caution'
    : v.unknowns.length > 2 ? 'unknown' : 'clean';
  assert.equal(v.verdict, attendu, 'le verdict doit suivre exactement l echelle documentee');
});

t('trop d inconnus = unknown, jamais clean (fail-closed)', () => {
  // Une ligne quasi vide: rien d arme, rien de flagge, mais presque rien d observe non plus.
  const v = R.assessRugFields({ owner_address: '0x' + '0'.repeat(40) }, null);
  assert.notEqual(v.verdict, 'rug_ready');
  if (v.unknowns.length > 2) assert.equal(v.verdict, 'unknown', 'plus de 2 inconnus doit interdire clean');
});

t('le verdict porte toujours sa clause de divulgation', () => {
  for (const v of [R.assessRugFields(ligneNeutre, null), R.assessFromSimulationOnly({ ok: true, flags: [] })]) {
    assert.ok(v.disclosure && v.disclosure.length > 20, 'la sortie doit se qualifier elle-meme');
  }
});

t('ownerState=unknown ne DEFUSE jamais un drapeau', () => {
  /* La regression que le module raconte dans son en-tete: l ancienne version repliait "owner absent" dans
   * "owner renonce", et deplacait chaque drapeau dangereux vers `defused` sous la mention
   * "(defused by renounced ownership)" — une phrase affirmant quelque chose de jamais observe. */
  const arme = { is_mintable: '1', transfer_pausable: '1', slippage_modifiable: '1' };
  const absent = R.assessRugFields({ ...arme }, null);                                   // owner non rapporte
  const renonce = R.assessRugFields({ ...arme, owner_address: '0x' + '0'.repeat(40) }, null);
  assert.equal(absent.ownerState, 'unknown');
  assert.equal(renonce.ownerState, 'renounced');
  assert.equal(absent.defused.length, 0, 'un owner ABSENT ne desamorce rien');
  assert.ok(renonce.defused.length > 0, 'un owner RENONCE, lui, desamorce');
  assert.notEqual(absent.verdict, 'clean', 'et le resultat ne peut pas lire comme propre');
});

/* ── scanRug : UN PLAFOND QUI NE SE DIT PAS DEGUISE UN TROU EN ABSTENTION ───────────────────────────
 * `.slice(0, 20)` tronquait la liste sans un mot, alors que l'appelant de production
 * (`hermes/economy/token-radar.js`) envoie MAX_NEW=40 en documentant « 2 GoPlus batches of 20 » — il
 * croyait donc que cette fonction decoupait. Mesure du 2026-07-28: 40 envoyes rendaient 20 verdicts, et
 * les 20 adresses restantes n'avaient meme pas de cle dans la sortie.
 *
 * Le cout etait REEL. Le recolteur coalesce un verdict manquant, donc un jeton jamais scanne entrait en
 * base habille en ABSTENTION. Sur la base de production: 7 lignes portaient l'empreinte
 * `reason: 'no verdict'` parmi 152 `unknown`. Aucune n'avait rugue — donc aucun rug manque, et c'est la
 * moitie du resultat qu'il faut publier aussi — mais la scorecard decrit `abstained` comme « les rugs
 * qu'on avait qualifies d'unknown », ce que ces sept-la n'etaient pas.
 *
 * ⚠️ Le harnais `t` de ce fichier est SYNCHRONE: on calcule par `await` AVANT et on assertit sur les
 * valeurs. Un `t('...', async () => ...)` ne pourrait jamais echouer. */
const adr = (n) => '0x' + String(n).padStart(40, '0');

(async () => {
  let lots = 0;
  const faux = async (url) => {
    if ((String(url).match(/0x/g) || []).length > 1) lots++;
    return { ok: true, json: async () => ({ result: {} }) };
  };
  const demander = async (n) => {
    lots = 0;
    const r = await R.scanRug('base', Array.from({ length: n }, (_, i) => adr(i + 1)), { fetchImpl: faux });
    return { r, lots };
  };

  const vingt = await demander(20);
  const quarante = await demander(40);
  const centVingt = await demander(120);
  const compte = (r, v) => Object.values(r).filter((x) => x.verdict === v).length;

  t('40 adresses rendent 40 verdicts, pas 20', () => {
    assert.strictEqual(Object.keys(quarante.r).length, 40);
    /* Le 21e existait deja dans la demande; il doit exister dans la reponse. */
    assert.ok(adr(21) in quarante.r, 'la 21e adresse doit avoir une cle');
    assert.strictEqual(compte(quarante.r, 'not_scanned'), 0, 'sous le plafond, rien n\'est refuse');
  });

  t('la liste est DECOUPEE en lots de 20, pas tronquee', () => {
    /* C'est ce que le commentaire de token-radar affirmait depuis toujours: « 2 GoPlus batches of 20 ». */
    assert.strictEqual(vingt.lots, 1);
    assert.strictEqual(quarante.lots, 2);
  });

  t('au-dela du plafond dur, l adresse EXISTE et se declare non scannee', () => {
    assert.strictEqual(Object.keys(centVingt.r).length, 120, 'aucune adresse ne disparait');
    assert.strictEqual(compte(centVingt.r, 'not_scanned'), 20);
    const refuse = centVingt.r[adr(120)];
    assert.strictEqual(refuse.verdict, 'not_scanned');
    /* ⚠️ `not_scanned` doit rester DISTINCT d'`unknown`: « je n'ai pas regarde » n'est pas « j'ai
     * regarde et je ne sais pas ». C'est toute la faute qu'on repare. */
    assert.notStrictEqual(refuse.verdict, 'unknown');
    assert.match(refuse.reason, /NEVER examined/);
    assert.match(refuse.reason, /Not an abstention|not an abstention/);
  });

  t('le plafond n avale jamais un scan qui aurait pu se faire', () => {
    /* Les deux bornes: un plafond pousse trop bas couperait ce qu'on sait traiter. */
    assert.strictEqual(compte(centVingt.r, 'not_scanned') + 100, 120);
    assert.strictEqual(centVingt.lots, 5, '100 adresses = 5 lots de 20');
  });

  const horsChaine = await R.scanRug('chaine-inexistante', [adr(1)], { fetchImpl: faux });
  t('une chaine non couverte reste unknown, PAS not_scanned', () => {
    /* Ces deux-la ne doivent pas se confondre non plus: une chaine non cablee est une REPONSE — on sait
     * pourquoi on ne peut rien dire — alors que `not_scanned` veut dire qu'on n'a meme pas demande. */
    assert.strictEqual(horsChaine[adr(1)].verdict, 'unknown');
    assert.notStrictEqual(horsChaine[adr(1)].verdict, 'not_scanned');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  /* Sans ce filet, une promesse rejetee tuerait le processus AVANT le bilan — et l'agregateur compte les
   * bilans. Un fichier sans bilan doit crier, pas disparaitre. */
  console.log('  FAIL harnais async: ' + (e && e.message));
  console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
