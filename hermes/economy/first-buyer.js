#!/usr/bin/env node
'use strict';
/**
 * first-buyer — qui achete EN PREMIER, et est-ce quelqu'un de la maison ?
 * =======================================================================
 * L'hypothese, posee par Phil: le tout premier acheteur d'un lancement est souvent le fondateur sous un
 * autre portefeuille, ou un initie prevenu. Si c'est vrai et mesurable au premier coup d'oeil, c'est un
 * signal utilisable — et contrairement au financeur, il ne demande AUCUN historique: il est visible dans
 * la minute qui suit la creation du pool.
 *
 * ═══ CE QUE CE FICHIER REFUSE DE FAIRE ═══
 * Lire le champ `to` du log et l'appeler "l'acheteur". Le `to` d'un swap est le DESTINATAIRE des tokens,
 * pas le signataire. Verifie le 2026-07-27 sur PEEPS: le premier log affichait un destinataire CONTRAT,
 * et j'ai ecrit "un contrat a achete" — faux, `tx.from` etait un EOA, et le contrat n'etait que le
 * receptacle d'un bot. La regle du depot ("un evenement n'est pas une transaction") s'est verifiee sur le
 * raisonnement de celui qui venait de la citer. Donc: le premier achat est identifie par le LOG, et son
 * auteur est lu dans la TRANSACTION.
 *
 * ═══ CE QUE LE SIGNAL PEUT ET NE PEUT PAS DIRE ═══
 * Acheter au bloc N+1 apres la creation du pool n'est PAS une preuve d'information privilegiee: des bots
 * snipent le mempool et achetent tout ce qui cree un pool, sans rien savoir. La distinction ne peut donc
 * pas venir du DELAI seul, elle doit venir du LIEN: le premier acheteur est-il le deployeur lui-meme, ou
 * a-t-il ete finance par le meme portefeuille que lui ? Un lien de financement prouve un controle ou une
 * infrastructure partagee — jamais une intention, et jamais une personne.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const DB = path.join(__dirname, '..', '..', 'data', 'token-radar', 'tokens.json');
const OUT = path.join(__dirname, '..', '..', 'data', 'token-radar', 'first-buyers.json');
const EXP = 'https://base.blockscout.com';
const CONC = 8;                    // mesure du 2026-07-27: 40 concurrents passaient sans refus; 8 laisse
                                   // de la marge pour le radar horaire qui tourne sur le meme endpoint.

const getJSON = (url) => new Promise((resolve) => {
  const req = https.get(url, { headers: { accept: 'application/json' } }, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.setTimeout(25000, () => { req.destroy(); resolve(null); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const low = (s) => String(s || '').toLowerCase();

/**
 * Le premier ACHAT d'un token, et qui l'a signe.
 *
 * Trois issues, et la troisieme compte autant que les deux autres:
 *   { ok:true,  ... }                    on a lu la chaine et voici le resultat
 *   { ok:false, reason:'no_lp_event' }   on a lu, et il n'y a pas de creation de pool reperable
 *   { ok:false, reason:'unread' }        on n'a PAS pu lire. Ce n'est pas "pas d'acheteur".
 */
async function firstBuyOf(token, deployer) {
  const url = EXP + '/api?module=account&action=tokentx&contractaddress=' + token + '&sort=asc&page=1&offset=30';
  const res = await getJSON(url);
  if (!res || res.status !== '1' || !Array.isArray(res.result)) return { ok: false, reason: 'unread' };
  const txs = res.result;
  if (!txs.length) return { ok: false, reason: 'unread' };   // succes VIDE: pas une donnee tant qu'on n'a rien lu

  /* Ancre = la creation du pool. Reperee par la methode quand elle est lisible, sinon par le fait que le
   * deployeur envoie des tokens a une adresse qui devient ensuite l'emetteur des swaps. */
  let lpIdx = txs.findIndex((t) => /addliquidity/i.test(String(t.functionName || '')));
  if (lpIdx < 0 && deployer) lpIdx = txs.findIndex((t) => low(t.from) === low(deployer));
  if (lpIdx < 0) return { ok: false, reason: 'no_lp_event' };

  const pool = low(txs[lpIdx].to);
  const lpBlock = Number(txs[lpIdx].blockNumber);

  /* Le premier achat = le premier transfert SORTANT du pool apres la creation. Un transfert ENTRANT est
   * une vente ou un ajout de liquidite, pas un achat. */
  let buy = txs.slice(lpIdx + 1).find((t) => low(t.from) === pool);
  let voie = 'pool_sortant';

  /* ═══ LA VOIE DE SECOURS QUI A FABRIQUE SES REPONSES — GARDEE COMME AVERTISSEMENT ═══
   *
   * Premiere tentative de correctif, le 2026-07-27. Les cas non resolus revenaient tous en `no_buy_yet`,
   * et TOUS etaient des tokens vivants, aucun rug: un motif d'echec aligne sur l'issue mesuree, donc un
   * biais et pas du bruit. J'ai ajoute une seconde voie qui cherchait la premiere transaction dont la
   * methode ressemblait a un echange:
   *
   *     /swap|handleops|execute|multicall/
   *
   * La couverture est passee de 65% a 97%. Et la mesure est devenue FAUSSE, parce que les 13 nouvelles
   * lignes etaient toutes la meme chose, verifiee sur la chaine:
   *
   *     methode  multicall
   *     to       0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1  (Uniswap V3 Positions NFT-V1)
   *     from     le deployeur lui-meme
   *     valeur   0 ETH
   *
   * Zero ETH verse, vers le gestionnaire de positions: c'est le deployeur qui CREE sa liquidite V3.
   * `multicall` est precisement la facon d'ajouter de la liquidite en V3, et mon motif l'attrapait.
   * Les 13 "premiers acheteurs vivants" etaient 13 fois le deployeur ajoutant sa propre liquidite.
   *
   * 💎 AMELIORER UN TAUX DE COUVERTURE N'EST PAS AMELIORER UNE MESURE. Le trou etait du cote exact que
   * je cherchais a comparer, et le remplir de reponses fabriquees a produit un echantillon "equilibre"
   * qui mentait mieux que le desequilibre visible d'avant.
   *
   * LA CAUSE RACINE: tout ce fichier suppose Uniswap V2 (addLiquidityETH, achats = sorties du pool). En
   * V3 la liquidite est un NFT de position et rien de cette logique ne s'applique. On REFUSE donc ces
   * lancements explicitement, avec leur raison, plutot que de deviner. Un `unknown` nomme vaut mieux
   * qu'un chiffre inventable. */
  if (!buy) {
    const v3 = txs.slice(lpIdx).some((t) => /multicall|mint\(/i.test(String(t.functionName || '')));
    return { ok: false, reason: v3 ? 'uniswap_v3_launch' : 'no_buy_yet', pool, lpBlock,
      note: v3 ? 'liquidite V3 (NFT de position): la notion de "sortie de pool" ne s applique pas, '
        + 'et compter le multicall du deployeur comme un achat est l erreur que ce garde empeche.' : undefined };
  }

  /* Et meme sur la voie V2, un "achat" doit couter quelque chose. Un transfert sortant du pool avec
   * 0 ETH n'est pas un achat: c'est un retrait, une distribution ou un transfert interne. */
  voie = 'pool_sortant';

  /* LE POINT DE TOUT LE FICHIER: le destinataire du log n'est pas l'acheteur. On va chercher le signataire. */
  const tx = await getJSON(EXP + '/api/v2/transactions/' + buy.hash);
  if (!tx || !tx.from || !tx.from.hash) {
    return { ok: false, reason: 'tx_unread', pool, lpBlock, logRecipient: low(buy.to), buyHash: buy.hash };
  }

  /* ═══ TROISIEME ETAGE, ET IL FAIT ECHOUER LA QUESTION ELLE-MEME ═══
   *
   * Sur un lancement en abstraction de compte (ERC-4337), la transaction est envoyee par un BUNDLER qui
   * relaie les operations de tiers. `tx.from` est alors une adresse d'infrastructure partagee — exactement
   * la meme classe d'erreur que lire le `to` du log, un etage plus haut. Le vrai acheteur est le `sender`
   * de la UserOperation, a l'interieur du calldata de handleOps.
   *
   * Verifie sur la chaine le 2026-07-27, token ZELLIO:
   *     tx.to   = 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789   etiquete "EntryPoint" par Blockscout
   *     tx.from = 0x4337038429B76948Ee97EB2d8115513277c3abf5   un EOA, prefixe vanity 0x4337
   *
   * Et ce n'est PAS un detail statistique: dans l'echantillon equilibre du 2026-07-27, l'architecture de
   * lancement se repartissait avec l'issue (classique -> surtout des rugs, 4337 -> surtout des vivants).
   * Nommer le bundler comme "premier acheteur" aurait donc produit une reponse confiante ET fausse, avec
   * un biais aligne sur ce qu'on cherchait a mesurer. On REFUSE de repondre plutot que de deviner. */
  const ENTRYPOINTS = new Set([
    '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789',   // EntryPoint v0.6, etiquete par Blockscout
    '0x0000000071727de22e5e9d8baf0edac6f37da032',   // EntryPoint v0.7
  ]);
  if (ENTRYPOINTS.has(low(tx.to && tx.to.hash)) || /handleops/i.test(String(tx.method || ''))) {
    return { ok: false, reason: 'account_abstraction', pool, lpBlock, buyHash: buy.hash,
      bundler: low(tx.from.hash), entryPoint: low(tx.to && tx.to.hash),
      note: 'tx.from est un bundler, pas l acheteur. Le sender reel est dans la UserOperation.' };
  }

  return {
    ok: true, voie,
    /* La valeur payee est ENREGISTREE, pas filtree. Un achat en ETH la porte; un achat token-contre-token
     * (paire USDC, ou WETH deja detenu) vaut legitimement 0. En faire un critere serait exactement la faute
     * que la voie de secours vient de me couter: un filtre pose sur une hypothese non validee. L'analyse
     * decidera, et elle pourra au moins voir combien de cas sont concernes. */
    buyValueWei: String(tx.value == null ? '' : tx.value),
    buyPaidEth: !!(tx.value && tx.value !== '0'),
    buyMethod: String(tx.method || ''),
    buyTarget: low(tx.to && tx.to.hash),
    buyTargetName: (tx.to && tx.to.name) || null,
    pool, lpBlock,
    buyBlock: Number(buy.blockNumber),
    blocksAfterLp: Number(buy.blockNumber) - lpBlock,
    buyHash: buy.hash,
    firstBuyer: low(tx.from.hash),
    buyerIsContract: !!(tx.from.is_contract),
    logRecipient: low(buy.to),
    // Un ecart entre les deux est exactement le piege que ce fichier existe pour eviter; on le garde
    // pour pouvoir MESURER a quelle frequence il se produit plutot que de l'affirmer.
    recipientDiffersFromSigner: low(buy.to) !== low(tx.from.hash),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const limite = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
  const equilibre = args.includes('--balanced');

  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  let entrees = Object.entries(db).filter(([, t]) => t.deployer);

  if (equilibre) {
    /* Echantillon EQUILIBRE. Ne prendre que des rugs mesurerait le biais du survivant: on verrait
     * "les premiers acheteurs des rugs sont lies au deployeur" sans jamais avoir regarde si c'est
     * aussi vrai des tokens qui ont survecu. */
    const rug = entrees.filter(([, t]) => t.outcome === 'rugged');
    const vif = entrees.filter(([, t]) => t.outcome !== 'rugged');
    const n = limite ? Math.floor(limite / 2) : Math.min(rug.length, vif.length);
    entrees = [...rug.slice(0, n), ...vif.slice(0, n)];
  } else if (limite) {
    entrees = entrees.slice(0, limite);
  }

  console.log('first-buyer: ' + entrees.length + ' tokens (' +
    entrees.filter(([, t]) => t.outcome === 'rugged').length + ' ruggés, ' +
    entrees.filter(([, t]) => t.outcome !== 'rugged').length + ' vivants)');

  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  let fait = 0, lus = 0, illisibles = 0;

  for (let i = 0; i < entrees.length; i += CONC) {
    const lot = entrees.slice(i, i + CONC);
    const res = await Promise.all(lot.map(([addr, t]) => firstBuyOf(addr, t.deployer)));
    for (let j = 0; j < lot.length; j++) {
      const [addr, t] = lot[j];
      out[addr] = { ...res[j], sym: t.sym, outcome: t.outcome || 'open', deployer: low(t.deployer), funder: low(t.funder) };
      if (res[j].ok) lus++; else illisibles++;
    }
    fait += lot.length;
    process.stdout.write('\r  ' + fait + '/' + entrees.length + '  lus=' + lus + '  non-lus=' + illisibles + '   ');
    await sleep(250);
  }
  console.log();

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('  ecrit -> ' + OUT);
  /* La couverture est publiee AVEC le resultat, jamais apres. Un taux de lecture de 60% change ce qu'on a
   * le droit de conclure, et l'omettre transforme un echantillon en affirmation. */
  console.log('  couverture de lecture: ' + lus + '/' + (lus + illisibles) +
    ' (' + Math.round(100 * lus / Math.max(1, lus + illisibles)) + '%)');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { firstBuyOf };
