'use strict';
/**
 * BIII ledger — the till roll: human-readable receipts + provable books.
 * =====================================================================
 * Phil's idea (checked: doesn't exist for in-person USDC — Request Network does B2B invoices,
 * explorers show raw txs, but no consumer "here is your receipt" ticket + a merchant's day
 * roll): make a payment something a NON-crypto human instantly understands, AND make the
 * merchant's books PROVABLE. Every receipt is anchored to a txHash, so anyone can re-confirm
 * it on-chain — a receipt that cannot be faked, and a day's sales that cannot be padded.
 *
 * Pure & deterministic: receipts/ledger in, formatted strings + summaries out. Persistence
 * (localStorage in the PWA, or a file/db on a server) is an adapter around this.
 */
const T = require('./till');

const pad2 = (n) => String(n).padStart(2, '0');
/** a stable, human receipt number from the ledger position + the tx (no clock needed). */
const receiptNo = (n) => 'B3-' + String(n).padStart(4, '0');

const HHMM = (blockTimeSec) => {
  if (!blockTimeSec) return '--:--';
  const d = new Date(Number(blockTimeSec) * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
};

/**
 * brandLine — WHITE-LABEL: the small attribution at the foot of a ticket/roll. A partner ships receipts
 * under their own brand ("via <Partner>"), optionally keeping a "· powered by BIII" tag. This NEVER
 * touches the honest bits — the ✓ PAID·USDC·on-Base line and the non-custodial disclosure stay, because
 * they are facts, not branding. `brand` = string | { name, poweredBy? }; absent ⇒ "via BIII" (default).
 */
function brandLine(brand) {
  if (!brand) return 'via BIII';
  const name = (typeof brand === 'string' ? brand : String((brand && brand.name) || '')).slice(0, 28).trim();
  if (!name) return 'via BIII';
  return 'via ' + name + (brand && brand.poweredBy ? ' · powered by BIII' : '');
}

/**
 * renderReceipt — the paper-ticket a human reads. Fixed-width, printer/share friendly.
 * receipt = the object from till.receipt(); opts.number = its ledger position; opts.brand = white-label.
 */
function renderReceipt(receipt, { number = 1, lang = 'en', brand } = {}) {
  if (!receipt || receipt.kind !== 'basetill-receipt') throw new Error('renderReceipt needs a verified BIII receipt');
  const L = lang === 'fr'
    ? { paid: 'PAYÉ', amount: 'Montant', tip: 'Pourboire', item: 'Article', when: 'Heure', by: 'Payé par', verify: 'Vérifiable sur', thanks: 'Merci !' }
    : { paid: 'PAID', amount: 'Amount', tip: 'Tip', item: 'Item', when: 'Time', by: 'Paid by', verify: 'Verify on-chain', thanks: 'Thank you!' };
  const merchant = (receipt.merchant && receipt.merchant.name) || 'Merchant';
  const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';
  const tip = tipMicroOf(receipt);   // null = PRESENT mais illisible; 0n = pas de pourboire declare
  const W = 34, line = '─'.repeat(W);
  const row = (k, v) => `${k}${' '.repeat(Math.max(1, W - k.length - String(v).length))}${v}`;
  const out = [
    center(merchant, W), center(receiptNo(number), W), line,
    receipt.label ? row(L.item + ':', receipt.label) : null,
    row(L.amount + ':', receipt.amountUsd + ' USDC'),
    // Un pourboire illisible se DIT sur le recu: l'omettre le rendrait identique a « pas de pourboire ».
    tip === null ? row(L.tip + ':', 'UNREADABLE') : (tip > 0n ? row(L.tip + ':', T.microToUsd(tip.toString()) + ' USDC') : null),
    row(L.when + ':', HHMM(receipt.blockTime)),
    row(L.by + ':', short(receipt.payer)),
    line,
    center(`✓ ${L.paid} · USDC on Base`, W),
    receipt.tier === 'final' ? center('(final)', W) : center('(confirmed)', W),
    line,
    L.verify + ':', receipt.explorer || short(receipt.txHash),
    '', center(L.thanks, W), center(brandLine(brand), W),
  ].filter((x) => x !== null);
  return out.join('\n');
}
function center(s, w) { const p = Math.max(0, Math.floor((w - s.length) / 2)); return ' '.repeat(p) + s; }

/**
 * APPEND to the till roll — receipts are append-only (a receipt is never edited or removed;
 * a correction is a new counter-entry, like real accounting). Returns the new rows + entry.
 * A receipt's txHash can appear at most once (a tx pays once) — silent dedup keeps books honest.
 */
function appendReceipt(rows, receipt) {
  const r = Array.isArray(rows) ? rows : [];
  if (!receipt || !receipt.txHash) throw new Error('a ledger entry needs a verified receipt (with a txHash)');
  const h = String(receipt.txHash || '').toLowerCase();   // case-insensitive, matching reverify() — a tx
  if (r.some((e) => String(e.receipt.txHash || '').toLowerCase() === h)) return { rows: r, entry: null, duplicate: true }; // in mixed casing must not double-count
  /* ⚠️ `r.length + 1` REUTILISAIT UN NUMERO DEJA EMIS. Mesure du 2026-07-28: on ajoute trois recus
   * (B3-0001, B3-0002, B3-0003), on retire le deuxieme du tableau — correction, purge, migration, rien
   * d'exotique pour un registre stocke en JSON — puis on ajoute. La longueur est retombee a 2, donc le
   * nouveau recu sort en B3-0003. Deux recus differents, LE MEME NUMERO, dans les livres d'un commerçant.
   *
   * Un numero de recu n'a qu'un seul travail: etre unique. Une quantite DERIVEE (la longueur) ne peut pas
   * le garantir, parce qu'elle descend. Un compteur MONOTONE le peut: on repart du plus grand `n` deja
   * emis, jamais du nombre de lignes restantes.
   *
   * Le `Math.max(..., r.length)` est une ceinture: si aucune ligne ne porte de `n` (registre ancien ou
   * importe), le maximum vaut 0 et on retomberait sur 1, qui existe deja. On ne descend donc jamais
   * en dessous du nombre de lignes presentes. */
  const plusGrand = r.reduce((m, e) => {
    const v = Number(e && e.n);
    return Number.isFinite(v) && v > m ? v : m;
  }, 0);
  const n = Math.max(plusGrand, r.length) + 1;
  const entry = { n, no: receiptNo(n), receipt };
  return { rows: [...r, entry], entry, duplicate: false };
}

/**
 * ═══ LA REGLE DE FENETRE — UNE SEULE DEFINITION, PARCE QU'ELLE EXISTAIT EN CINQ EXEMPLAIRES ═══
 *
 * `Number(receipt.blockTime) || 0` etait recopie dans ledger.summary, ledger.renderRoll, export.inWindow,
 * export.isoDate et meter.meterUsage. Cette coercition transforme un horodatage ABSENT en l'epoque unix
 * ZERO — et `0 >= fromBlockTime` est faux pour toute fenetre reelle. Un recu PAYE, confirme, verifiable
 * on-chain sortait donc des livres du marchand sans un mot, et le brut sortait court. Mesure du 2026-08-05
 * a travers le vrai producteur, pas une fixture: test/receipt-blocktime-producer.test.js.
 *
 * Quatre corrections sont mortes dans ce depot pour avoir atterri sur une route et pas sur ses soeurs. La
 * reponse structurelle n'est donc pas de reparer la coercition cinq fois: c'est qu'il n'y ait plus qu'un
 * endroit ou elle puisse etre fausse. `windowRows` est exportee et les trois modules l'appellent.
 *
 * LA REGLE:
 *   · Un recu sans date n'est JAMAIS date en silence. Il ne peut pas etre prouve dans la journee du 8
 *     juillet; l'y compter gonflerait une periode fiscale a laquelle il n'appartient peut-etre pas, et
 *     l'en retirer sans le dire la sous-evalue. Il en sort — ET LE COMPTE DES EXCLUS VOYAGE AVEC LES LIVRES.
 *   · Une fenetre SANS borne ne pose aucune question de date: tout est garde, `undatedExcluded` vaut 0.
 *     C'est le comportement historique, preserve exactement.
 */
const blockTimeOf = (receipt) => {
  const t = Number(receipt && receipt.blockTime);
  return Number.isFinite(t) && t > 0 ? t : null;   // null = SANS DATE. Jamais 0 — 1970 est une affirmation.
};

/**
 * microStrict — un montant en micro-USDC: un entier non negatif, ou `null` = ILLISIBLE. JAMAIS zero.
 *
 * ⚠️ Mesure du 2026-08-17 a travers le PRODUCTEUR (`appendReceipt`), pas une fixture. Deux recus dans les
 * livres, dont un seul lisible:
 *
 *   temoin: deux recus a 10.00 .......... count=2  gross=20.00  undatedExcluded=0
 *   un a 10, un SANS amountMicro ........ count=2  gross=10.00  undatedExcluded=0   <-- ici
 *   un a 10, un a ZERO REEL ............. count=2  gross=10.00  undatedExcluded=0
 *   un a 10, un amountMicro NEGATIF ..... count=2  gross= 5.00  undatedExcluded=0   <-- et ici
 *
 * Les deux lignes du milieu sont identiques OCTET POUR OCTET, divulgation comprise: un recu dont le
 * montant est illisible et un recu qui vaut honnetement 0.00 rendent les MEMES livres — avec
 * `undatedExcluded: 0` qui AFFIRME en plus que rien n'a ete tu. La derniere ligne est pire qu'une
 * omission: un montant negatif SOUSTRAIT du total prouvable, donc une ligne malformee peut effacer une
 * vente reelle. (`'abc'` et `'1.5'`, eux, faisaient jeter `BigInt` au travers de TOUS les livres, sans
 * nommer la ligne fautive.)
 *
 * ⛔ CE DEPOT TRANCHAIT DEJA CE CAS CORRECTEMENT A TROIS ENDROITS, et c'est ce qui rend le diagnostic:
 * `blockTimeOf` juste au-dessus refuse de dater a 1970 (« null = SANS DATE. Jamais 0 »), `bin/biii-mcp.js`
 * lit un montant par `/^\d+$/` AVANT de construire une charge, et `meter.js` REFUSE un `verdictCount`
 * negatif au motif qu'« un compte negatif n'est pas un compte bas, c'est un rapport malforme, et le
 * ramener a 0 facturerait comme si l'operateur avait honnetement declare zero ». Cet argument-la est mot
 * pour mot celui du montant — et il vivait VINGT LIGNES sous la coercition qui l'ignorait, du cote de
 * l'argent PROUVABLE. Meme classe, resolue strictement pour le declaratif et par defaut pour la chaine.
 *
 * Pourquoi DIVULGUER plutot que REFUSER: le fichier tranche deja cette distinction. `boundStrict` refuse,
 * parce qu'une borne illisible est une DEMANDE malformee, et qu'on ne consomme pas une demande avant de
 * l'avoir validee. Un montant illisible est un fait sur la DONNEE, comme un recu sans date: on le retire
 * du total EN LE DISANT. Il suit donc la route de `undatedNote`, pas celle de `boundStrict`.
 */
const microStrict = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;   // '', 'abc', '1.5', '-5' : illisible. Jamais rabattu sur zero.
  return BigInt(s);
};

/**
 * Le montant encaisse d'un recu: `paidMicro` s'il est PRESENT, sinon `amountMicro`. `null` = illisible.
 * Un `paidMicro` present mais illisible ne se rabat PAS sur `amountMicro`: ce qui a ete reellement paye
 * est la question posee, et y repondre par ce qui avait ete facture serait une autre lecture ratee rendue
 * comme une lecture reussie.
 */
const amountMicroOf = (receipt) => {
  if (!receipt) return null;
  const brut = (receipt.paidMicro === undefined || receipt.paidMicro === null || receipt.paidMicro === '')
    ? receipt.amountMicro : receipt.paidMicro;
  return microStrict(brut);
};

/** Le pourboire: ABSENT vaut 0n (ne rien declarer est legitime), PRESENT et illisible vaut `null`. */
const tipMicroOf = (receipt) => {
  const v = receipt && receipt.overpaidMicro;
  if (v === undefined || v === null || v === '') return 0n;
  return microStrict(v);
};

/**
 * boundStrict — une BORNE de fenetre: absente (`null`), ou un nombre fini. Une borne PRESENTE mais
 * illisible est REFUSEE, elle n'est jamais silencieusement laissee tomber.
 *
 * ⚠️ Mesure du 2026-08-09 a travers le vrai `callTool('till_export')`, pas une fixture: `bin/biii-mcp.js`
 * gardait ses deux bornes derriere `Number.isFinite(a.fromBlockTime)`, qui est un test de TYPE et non une
 * lecture. Il est faux pour `"1783555200"` — une borne parfaitement valide, telle que beaucoup de clients
 * JSON-RPC envoient les nombres. La borne partait donc a la poubelle, `window` restait `{}`, et `windowRows`
 * prenait sa sortie anticipee « aucune date demandee ». Trois recus, un seul dans la journee visee:
 *
 *   bornes valides (nombres) ... count=1  gross=10.00   <- la vraie reponse
 *   bornes "1783555200" ........ count=3  gross=75.00   <- 7,5x trop, MEME OCTET que « pas de fenetre »
 *   bornes "2026-07-08" ........ count=3  gross=75.00   <- idem
 *   aucune fenetre ............. count=3  gross=75.00
 *
 * Le comptable demandait la journee du 8 juillet et recevait le total de TOUS LES TEMPS, avec
 * `undatedExcluded: 0` — c'est-a-dire « rien ne vous a ete tu ». Une lecture ratee rendait exactement ce
 * que rend une lecture reussie: la forme meme que ce depot chasse. Et `till_meter` portait les quatre
 * memes lignes, donc la mauvaise fenetre devenait une FACTURE.
 *
 * Pourquoi REFUSER plutot que divulguer: un recu sans date est un fait sur la DONNEE, on le retire en le
 * disant. Une borne illisible est une DEMANDE malformee — divulguer « votre borne a ete ignoree » tout en
 * rendant quand meme le total de tous les temps expedie encore le chiffre 7,5x trop grand sous une question
 * datee. On ne consomme pas la demande avant de l'avoir validee.
 *
 * `Number()` seul ne peut pas tenir ce role: il transforme `null`, `''`, `'  '`, `[]` et `false` en ZERO,
 * et zero est une borne basse legitime. On exige donc la forme ATTENDUE au lieu d'enumerer les fautives —
 * meme raisonnement, et meme redaction, que `nombreStrict` dans lib/x402-settle.js.
 */
function boundStrict(v, nom) {
  /* `invalidParams` marque un refus que NOUS avons valide, sur une entree de l'appelant. Le catch generique
   * de bin/biii-mcp.js refuse (a juste titre) de nommer une cause, parce qu'il ne peut PAS distinguer une
   * mauvaise entree d'une panne amont — sur `till_check_payment`, « check arguments » accusait les donnees
   * d'un marchand dont le noeud etait tombe. Ici la cause n'est pas devinee, elle est etablie: c'est la
   * borne fournie. Ce drapeau est donc ce qui autorise le serveur a la NOMMER, en -32602, sans revenir a
   * l'attribution aveugle. Un refus qui ne dit pas QUOI etait faux renvoie l'appelant deviner. */
  const refus = (msg) => { const e = new Error(msg); e.invalidParams = true; throw e; };
  if (v === undefined || v === null) return null;                    // absente: aucune borne demandee
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return v;
    return refus(`window.${nom} is not a finite number (${String(v)}) — refusing to answer a dated `
      + 'question with an undated total');
  }
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return refus(`window.${nom} is present but unreadable (${JSON.stringify(v)}) — refusing: dropping it `
    + 'would answer for ALL TIME while the caller asked for a dated window. Pass unix SECONDS.');
}

/**
 * boundsOrdered — une fenetre VIDE PAR CONSTRUCTION est une demande malformee, pas une periode calme.
 *
 * ⚠️ Mesure du 2026-08-12 a travers le vrai `callTool('till_export')`, pas une fixture. Trois recus, dont
 * un seul dans la journee visee:
 *
 *   aucune fenetre ........................ count=3  gross=75.00  undatedExcluded=0
 *   jour du 8 juillet (bornes correctes) .. count=1  gross=10.00  undatedExcluded=0
 *   bornes INVERSEES (from > to) .......... count=0  gross=0.00   undatedExcluded=0   <-- ici
 *   journee reellement sans vente ......... count=0  gross=0.00   undatedExcluded=0
 *
 * Les deux dernieres lignes sont identiques OCTET POUR OCTET. Un comptable qui intervertit ses deux bornes
 * — la faute de saisie la plus banale sur une paire de dates — s'entend donc dire que le commerce n'a rien
 * encaisse ce mois-la, avec `undatedExcluded: 0` qui AFFIRME en plus que rien ne lui a ete tu. Et
 * `till_meter` porte la meme regle, donc la meme inversion sort une FACTURE a zero recu facturable.
 *
 * ⛔ CE FICHIER TRANCHAIT DEJA CE CAS CORRECTEMENT A COTE, et c'est ce qui rend le diagnostic sur:
 * `meter.js` REFUSE un `verdictCount` negatif au motif qu'« un compte negatif n'est pas un compte bas,
 * c'est un rapport malforme, et le ramener a 0 facturerait comme si l'operateur avait honnetement declare
 * zero ». Une fenetre inversee est le meme argument du cote de la fenetre: zero recu par impossibilite
 * n'est pas zero recu par mesure. Meme classe, resolue strictement d'un cote et par defaut de l'autre.
 *
 * LE CRITERE EST « VIDE PAR CONSTRUCTION », pas « bizarre ». Une fenetre ou AUCUNE donnee ne peut tomber,
 * quelle que soit la donnee, ne peut pas etre repondue par une mesure. C'est ce qui distingue ce refus de
 * `fromBlockTime: -1` SEUL, qui reste accepte et rend tout: une borne basse negative est LISIBLE et sa
 * reponse litterale (« tout ce qui est au moins a -1 ») est vraie. Mesure du meme jour: elle rend bien les
 * trois recus, et ce n'est pas un defaut. `from === to` reste accepte aussi — une fenetre d'une seconde est
 * etroite, pas impossible, et elle rend bien 1 recu.
 *
 * Le drapeau `invalidParams` est le meme que `boundStrict`: il autorise bin/biii-mcp.js a NOMMER la cause
 * en -32602 au lieu du « failed » nu qui renvoie l'appelant deviner.
 */
function boundsOrdered(from, to) {
  if (from > to) {
    const e = new Error(`window.fromBlockTime (${from}) is after window.toBlockTime (${to}) — refusing: no `
      + 'receipt can fall in that window whatever the data, so an empty answer would be indistinguishable '
      + 'from a period with genuinely no sales. Swap the bounds; they are unix SECONDS.');
    e.invalidParams = true; throw e;
  }
}

/** Applique LA regle a un jeu de lignes {receipt}. Rend { kept, undatedExcluded } — jamais l'un sans l'autre. */
function windowRows(rows, window) {
  const list = Array.isArray(rows) ? rows : [];
  const parsedFrom = boundStrict(window && window.fromBlockTime, 'fromBlockTime');
  const parsedTo = boundStrict(window && window.toBlockTime, 'toBlockTime');
  const from = parsedFrom !== null && parsedFrom > 0 ? parsedFrom : 0;
  const to = parsedTo !== null ? parsedTo : Infinity;
  boundsOrdered(from, to);   // vide par construction = demande malformee, jamais une periode calme
  if (from === 0 && to === Infinity) return { kept: list, undatedExcluded: 0 };   // aucune date demandee
  let undatedExcluded = 0;
  const kept = list.filter((e) => {
    const bt = blockTimeOf(e && e.receipt);
    if (bt === null) { undatedExcluded += 1; return false; }
    return bt >= from && bt <= to;
  });
  return { kept, undatedExcluded };
}

/**
 * DAY SUMMARY — the merchant's provable books for a window. Sums in micro (exact), plus USD.
 * `undatedExcluded` = receipts dropped from a DATED window for carrying no readable on-chain block time.
 * It is part of the books: a total that omits lines without saying so looks complete and is not.
 */
function summary(rows, window = {}) {
  const { kept: inWin, undatedExcluded } = windowRows(rows, window);
  let gross = 0n, tips = 0n, unreadableAmounts = 0;
  for (const e of inWin) {
    const m = amountMicroOf(e.receipt), tip = tipMicroOf(e.receipt);
    if (m === null || tip === null) unreadableAmounts += 1;   // LA LIGNE est signalee une seule fois
    if (m !== null) gross += m;                               // et ce qui EST lisible reste compte
    if (tip !== null) tips += tip;
  }
  return {
    count: inWin.length,
    grossMicro: gross.toString(), grossUsd: T.microToUsd(gross.toString()),
    tipsMicro: tips.toString(), tipsUsd: T.microToUsd(tips.toString()),
    txHashes: inWin.map((e) => e.receipt.txHash),          // every line re-checkable on-chain
    undatedExcluded,                                       // 0 = rien n'a ete tu
    unreadableAmounts,                                     // idem, pour l'ARGENT: 0 = tout a ete lu
  };
}

/** La phrase que TOUT consommateur de livres datees affiche quand des lignes ont ete ecartees faute de date. */
function undatedNote(n, lang) {
  if (!n) return null;
  return lang === 'fr'
    ? `⚠ ${n} reçu(s) sans horodatage on-chain — NON comptés dans cette fenêtre datée. Le total ci-dessus est `
      + `incomplet d'autant : ces paiements sont réels et vérifiables, mais leur date ne peut pas être prouvée.`
    : `⚠ ${n} receipt(s) carry no on-chain block time and are NOT counted in this dated window. The total above `
      + `is short by that much: those payments are real and re-verifiable, but their date cannot be proven.`;
}

/** La phrase jumelle, pour l'ARGENT. Meme regle que `undatedNote`: une ligne retiree du total se dit. */
function unreadableAmountNote(n, lang) {
  if (!n) return null;
  return lang === 'fr'
    ? `⚠ ${n} reçu(s) portent un montant ILLISIBLE (absent, négatif ou non entier) — il n'est PAS compté `
      + `dans le total ci-dessus, qui est donc incomplet. Un montant qu'on ne sait pas lire n'est pas un `
      + `montant nul : re-vérifiez ces lignes sur Base avant de vous servir de ceci comme livres.`
    : `⚠ ${n} receipt(s) carry an UNREADABLE amount (absent, negative or non-integer) and it is NOT counted `
      + `in the total above, which is short by that much. An amount that cannot be read is not an amount of `
      + `zero: re-verify those lines on Base before using this as books.`;
}

/** RE-VERIFY a past ledger entry against a fresh chain fact — books that anyone can audit.
 *  Rebuilds the charge from the receipt and re-runs the field-for-field check. */
function reverify(entry, fact) {
  if (!entry || !entry.receipt) throw new Error('reverify needs a ledger entry');
  const rec = entry.receipt;
  const charge = { to: rec.merchant.address, amountMicro: rec.amountMicro, amountUsd: rec.amountUsd, token: T.USDC_BASE, chainId: T.BASE_CHAIN_ID };
  const v = T.verifyPayment(charge, fact);
  return { ok: v.paid === true && (fact && (fact.txHash || '').toLowerCase() === (rec.txHash || '').toLowerCase()),
    verdict: v, expectedTx: rec.txHash };
}

/**
 * PORTABLE PROVABLE BOOKS — the shareable till roll an EXCLUDED merchant/agent can hand to anyone.
 * When they left Stripe/PayPal they lost the settlement statement + the dispute trail; an irreversible
 * crypto rail gives neither. This is the substitute: a plain statement where EVERY line carries its own
 * on-chain txHash + explorer link, so the reader re-verifies each one against Base themselves — trust no
 * one, not even the merchant, not even BIII. Pure/deterministic; the reader supplies the chain facts.
 */
function renderRoll(rows, { merchantName = 'Merchant', lang = 'en', window, brand } = {}) {
  const s = summary(rows, window || {});
  const { kept: inWin } = windowRows(rows, window);   // MEME regle que le total ci-dessus — plus de jumelle a diverger
  const L = lang === 'fr'
    ? { roll: 'REGISTRE DE CAISSE — PROUVABLE', line: 'Reçu', amt: 'Montant', when: 'Heure', tx: 'Tx', gross: 'Total', tips: 'Pourboires', n: 'Reçus', foot: 'Re-vérifiez CHAQUE ligne sur Base — ne faites confiance à personne. Non-custodial : BIII ne détient aucun fonds.' }
    : { roll: 'PROVABLE TILL ROLL', line: 'Receipt', amt: 'Amount', when: 'Time', tx: 'Tx', gross: 'Gross', tips: 'Tips', n: 'Receipts', foot: 'Re-verify EVERY line on Base — trust no one. Non-custodial: BIII holds no funds.' };
  const short = (a) => a ? String(a).slice(0, 10) + '…' + String(a).slice(-6) : '—';
  /* Une ligne dont le montant est illisible ne peut pas afficher `amountUsd`: ce champ est une SECONDE
   * ecriture du meme montant, et il reste souvent lisible quand `amountMicro` ne l'est pas — le document
   * afficherait alors « 10.00 » sur une ligne que le total ci-dessus n'a pas comptee. Le lecteur verrait
   * des lignes qui ne s'additionnent pas a leur propre total, sans savoir laquelle croire. */
  const montantAffiche = (r) => (amountMicroOf(r) === null ? 'UNREADABLE' : String(r.amountUsd) + ' USDC');
  const lines = inWin.map((e) => `  ${e.no}  ${montantAffiche(e.receipt).padEnd(12)} ${HHMM(e.receipt.blockTime).padEnd(10)} ${short(e.receipt.txHash)}`);
  return [
    merchantName, L.roll,
    // WHITE-LABEL: a partner's brand sits in the header; the non-custodial disclosure (L.foot) is a FACT
    // and stays whatever the brand — white-labeling never edits the honesty line.
    ...(brand ? [brandLine(brand)] : []), '',
    `${L.n}: ${s.count}   ${L.gross}: ${s.grossUsd} USDC   ${L.tips}: ${s.tipsUsd} USDC`, '',
    ...lines, '',
    // La divulgation se place AVANT la ligne de non-custodie, collee au total qu'elle corrige — un lecteur
    // qui s'arrete au chiffre doit rencontrer l'avertissement, pas le trouver en pied de page.
    ...(undatedNote(s.undatedExcluded, lang) ? [undatedNote(s.undatedExcluded, lang), ''] : []),
    ...(unreadableAmountNote(s.unreadableAmounts, lang) ? [unreadableAmountNote(s.unreadableAmounts, lang), ''] : []),
    L.foot,
  ].join('\n');
}

/**
 * RE-VERIFY the WHOLE roll against fresh chain facts — the "books anyone can audit" made batch.
 * facts: a Map<txHashLower, fact>, or a function (txHash) => fact | null. Returns a per-line result and
 * the honest headline: allVerified only if EVERY line re-checks field-for-field on Base (fail-closed —
 * a missing/mismatched fact fails that line, never passes it).
 */
function reverifyRoll(rows, facts) {
  const getFact = typeof facts === 'function'
    ? facts
    : (h) => { const m = facts; const k = String(h || '').toLowerCase(); return m && (typeof m.get === 'function' ? m.get(k) : m[k]) || null; };
  const results = (Array.isArray(rows) ? rows : []).map((entry) => {
    const h = entry && entry.receipt && entry.receipt.txHash;
    const r = reverify(entry, getFact(h));
    return { no: entry.no, txHash: h, ok: r.ok, verdict: r.verdict };
  });
  const verified = results.filter((r) => r.ok).length;
  return { total: results.length, verified, allVerified: results.length > 0 && verified === results.length, results };
}

module.exports = { renderReceipt, appendReceipt, summary, reverify, reverifyRoll, renderRoll, brandLine, receiptNo,
  windowRows, blockTimeOf, boundStrict, boundsOrdered, undatedNote,
  microStrict, amountMicroOf, tipMicroOf, unreadableAmountNote };
